// tests/helpers/harness.js
// Shared plumbing for the test suites: a tiny test runner, provider
// sandboxes, and server lifecycle management.
//
// Everything here is deliberately dependency-free so `npm test` works on a
// clean checkout with no test framework installed.

"use strict";

const assert = require("assert");
const net = require("net");
const fs = require("fs");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const ROOT = path.resolve(__dirname, "..", "..");
const LONG_SECRET = "test-secret-that-is-definitely-longer-than-32-chars";

// The runner process itself needs the environment: it creates and drops
// throwaway MongoDB databases, and it must see the same MONGO_URI the server
// under test will use. The child servers load dotenv independently.
require(path.join(ROOT, "node_modules", "dotenv")).config({ quiet: true });

// ---------------------------------------------------------------------------
// Tiny test runner
// ---------------------------------------------------------------------------

/**
 * Collects suites and reports results. Kept deliberately boring: a suite is a
 * group of named async checks, and a failure records the message and keeps
 * going so one run shows every problem rather than the first.
 */
class Suite {
  constructor(name) {
    this.name = name;
    this.checks = [];
  }

  test(name, fn) {
    this.checks.push({ name, fn });
  }

  async run({ log = console.log } = {}) {
    log(`\n── ${this.name} ${"─".repeat(Math.max(0, 58 - this.name.length))}`);
    const failures = [];
    for (const check of this.checks) {
      try {
        await check.fn();
        log(`  ✓ ${check.name}`);
      } catch (err) {
        failures.push({ name: check.name, error: err.message });
        log(`  ✗ ${check.name}`);
        log(`      ${String(err.message).split("\n").join("\n      ")}`);
      }
    }
    return {
      suite: this.name,
      passed: this.checks.length - failures.length,
      failed: failures.length,
      total: this.checks.length,
      failures,
    };
  }
}

/** Runs a list of suites and returns an aggregated result. */
async function runSuites(suites, { log = console.log } = {}) {
  const results = [];
  for (const suite of suites) results.push(await suite.run({ log }));
  return {
    results,
    passed: results.reduce((n, r) => n + r.passed, 0),
    failed: results.reduce((n, r) => n + r.failed, 0),
    total: results.reduce((n, r) => n + r.total, 0),
  };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const expect = {
  equal(actual, wanted, msg) {
    assert.deepStrictEqual(actual, wanted, msg);
  },
  deep(actual, wanted, msg) {
    assert.deepStrictEqual(actual, wanted, msg);
  },
  isTrue(value, msg) {
    assert.strictEqual(value, true, msg || `expected true, got ${value}`);
  },
  isFalse(value, msg) {
    assert.strictEqual(value, false, msg || `expected false, got ${value}`);
  },
  ok(value, msg) {
    assert.ok(value, msg);
  },
  /** Asserts `fn` rejects and that the error looks like `predicate`. */
  async throws(fn, predicate, msg) {
    let error = null;
    try {
      await fn();
    } catch (err) {
      error = err;
    }
    assert.ok(error, msg || "expected the call to throw, but it resolved");
    if (predicate) {
      const ok = predicate(error);
      assert.ok(ok, msg || `error did not match predicate: ${error.name}: ${error.message}`);
    }
    return error;
  },
};

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

/** Asks the OS for a free port, then releases it for the server to claim. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.unref();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------
// Provider sandboxes
// ---------------------------------------------------------------------------

/**
 * Creates an isolated, empty store for one provider run.
 *
 * Isolation matters: the API suite bootstraps the first admin, so it can only
 * run against a store that has never been used. Neither the configured
 * application database nor a developer's local data directory is ever touched.
 */
async function createSandbox(provider, { runId }) {
  if (provider === "json") {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `annotator-json-${runId}-`));
    return {
      provider,
      env: { DATA_PROVIDER: "json", JSON_DATA_DIR: dir },
      describe: `json @ ${dir}`,
      cleanup: async () => fsp.rm(dir, { recursive: true, force: true }),
    };
  }

  if (provider === "mongo") {
    const dbName = `annotator_test_${runId}`;
    return {
      provider,
      env: { DATA_PROVIDER: "mongo", DB_NAME: dbName },
      describe: `mongo @ ${dbName}`,
      cleanup: async () => dropMongoDatabase(dbName),
    };
  }

  throw new Error(`Unknown provider "${provider}"`);
}

/**
 * Drops a throwaway test database.
 *
 * Never throws: a cleanup failure must not turn a passing run into a failed
 * one, but it is worth saying out loud, because it leaves data behind.
 */
async function dropMongoDatabase(dbName) {
  if (!process.env.MONGO_URI) {
    console.warn(
      `  ⚠️  could not drop "${dbName}": MONGO_URI is not set in the runner process`,
    );
    return;
  }
  try {
    const { MongoClient } = require(path.join(ROOT, "node_modules", "mongodb"));
    const client = new MongoClient(process.env.MONGO_URI);
    await client.connect();
    await client.db(dbName).dropDatabase();
    await client.close();
  } catch (err) {
    console.warn(`  ⚠️  could not drop "${dbName}": ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

const READY_PATTERN = /🚀 Server running/;
const FAILED_PATTERN = /(Failed to start server|Invalid configuration|❌)/;

/**
 * Spawns `node server.js` in an isolated environment and resolves once it
 * reports that it is listening.
 *
 * Passing the environment explicitly (rather than inheriting it) is what keeps
 * parallel or repeated runs from colliding with a developer's running server:
 * the port, the data directory and the database name are all unique per run.
 */
async function startServer({ env, timeoutMs = 45000 } = {}) {
  const port = await findFreePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: "development",
      PORT: String(port),
      JWT_SECRET: LONG_SECRET,
      // Never inherit a developer's provider or store settings.
      DATA_PROVIDER: "json",
      JSON_DATA_DIR: path.join(os.tmpdir(), "annotator-unused"),
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const output = [];
  let settled = false;

  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(
        new Error(
          `Server did not become ready within ${timeoutMs}ms.\n${output.join("")}`,
        ),
      );
    }, timeoutMs);

    const onChunk = (chunk) => {
      const text = chunk.toString();
      output.push(text);
      if (settled) return;

      if (FAILED_PATTERN.test(text)) {
        settled = true;
        clearTimeout(timer);
        child.kill("SIGKILL");
        reject(new Error(`Server failed to start:\n${text}`));
        return;
      }
      if (READY_PATTERN.test(text)) {
        settled = true;
        clearTimeout(timer);
        resolve({
          child,
          port,
          baseUrl: `http://127.0.0.1:${port}`,
          apiUrl: `http://127.0.0.1:${port}/api`,
          logs: () => output.join(""),
        });
      }
    };

    child.stdout.on("data", onChunk);
    child.stderr.on("data", onChunk);
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(`Server exited early with code ${code}:\n${output.join("")}`),
      );
    });
  });
}

/** Runs a child test process to completion and captures its report. */
function runNode(scriptPath, { env = {}, cwd = ROOT } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c.toString()));
    child.stderr.on("data", (c) => (stderr += c.toString()));
    child.on("close", (code) =>
      resolve({ code, stdout, stderr, ok: code === 0 }),
    );
  });
}

/** Sends SIGTERM (so the app's graceful-shutdown path runs) and waits. */
async function stopServer(server, { timeoutMs = 8000 } = {}) {
  if (!server || server.child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      server.child.kill("SIGKILL");
      resolve();
    }, timeoutMs);
    server.child.on("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    server.child.kill("SIGTERM");
  });
}

/** Parses the "N passed, M failed" line the api-test harness prints. */
function parseApiTestReport(stdout) {
  const match = stdout.match(/Results:\s+(\d+) passed,\s+(\d+) failed,\s+(\d+) total/);
  if (!match) return null;
  return {
    passed: Number(match[1]),
    failed: Number(match[2]),
    total: Number(match[3]),
  };
}

function ensureResultsDir() {
  const dir = path.join(ROOT, "tests", "results");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

module.exports = {
  ROOT,
  LONG_SECRET,
  Suite,
  runSuites,
  expect,
  findFreePort,
  createSandbox,
  startServer,
  stopServer,
  runNode,
  parseApiTestReport,
  ensureResultsDir,
};
