// tests/run-all.js
// Runs the whole test matrix: unit suites, the storage-parity suite, then the
// full end-to-end API suite against EVERY storage provider, each in its own
// isolated environment.
//
//   npm test                          # everything available
//   node tests/run-all.js --unit      # unit suites only (no server, no database)
//   node tests/run-all.js --json      # end-to-end on JSON only
//   node tests/run-all.js --mongo     # end-to-end on MongoDB only
//   node tests/run-all.js --sqlite    # end-to-end on SQLite only
//   node tests/run-all.js --mysql     # end-to-end on MySQL only
//
// Isolation is the important part. Each provider run gets a private port, a
// private store, and — for MongoDB and MySQL — a throwaway database that is
// dropped afterwards. Your configured database, your local data directory, and
// any server you already have running are never touched.
//
// Providers that are unavailable (no MONGO_URI, no MySQL server) are reported
// as skipped rather than failed.
//
// Writes a machine-readable report to tests/results/.

"use strict";

const path = require("path");
const fsp = require("fs/promises");

const harness = require(path.join(__dirname, "helpers", "harness"));
const {
  ROOT,
  createSandbox,
  startServer,
  stopServer,
  runNode,
  parseApiTestReport,
  ensureResultsDir,
} = harness;

const UNIT_SUITES = [
  { name: "json-store", script: "tests/unit/json-store.test.js" },
  { name: "sql-store", script: "tests/unit/sql-store.test.js" },
  { name: "config", script: "tests/unit/config.test.js" },
  { name: "contract", script: "tests/unit/contract.test.js" },
  { name: "media", script: "tests/unit/media.test.js" },
];

// Every provider the end-to-end matrix knows about.
const ALL_PROVIDERS = ["json", "sqlite", "mongo", "mysql"];

const args = new Set(process.argv.slice(2));
const unitOnly = args.has("--unit");
const skipProviderSuites = unitOnly;

const runId = Date.now().toString(36);

const line = (char = "─") => char.repeat(72);
const heading = (text) => `\n${line()}\n${text}\n${line()}`;

// ---------------------------------------------------------------------------
// Unit suites (in-process child runs, no server needed)
// ---------------------------------------------------------------------------

async function runUnitSuites() {
  const reports = [];
  for (const suite of UNIT_SUITES) {
    process.stdout.write(`\n▶ ${suite.name}\n`);
    const run = await runNode(path.join(ROOT, suite.script));
    // Surface the child output so a failure is diagnosable without a rerun.
    process.stdout.write(run.stdout);
    if (run.stderr.trim()) process.stderr.write(run.stderr);

    const match = run.stdout.match(/=== (\d+) passed, (\d+) failed, (\d+) total ===/);
    reports.push({
      suite: suite.name,
      kind: "unit",
      passed: match ? Number(match[1]) : 0,
      failed: match ? Number(match[2]) : 0,
      total: match ? Number(match[3]) : 0,
      ok: run.ok,
    });
  }
  return reports;
}

// ---------------------------------------------------------------------------
// Cross-provider model parity (needs a database only if MONGO_URI is set)
// ---------------------------------------------------------------------------

async function runParitySuite() {
  process.stdout.write("\n▶ storage parity (all providers)\n");
  const run = await runNode(path.join(ROOT, "tests/storage-parity.js"));
  process.stdout.write(run.stdout);
  if (run.stderr.trim()) process.stderr.write(run.stderr);

  const match = run.stdout.match(/=== (\d+) passed, (\d+) failed, (\d+) skipped ===/);
  const passed = match ? Number(match[1]) : 0;
  const failed = match ? Number(match[2]) : 0;
  return {
    suite: "storage-parity",
    kind: "parity",
    passed,
    failed,
    total: passed + failed,
    skipped: match ? Number(match[3]) : 0,
    ok: run.ok,
  };
}

// ---------------------------------------------------------------------------
// End-to-end API suite, per provider
// ---------------------------------------------------------------------------

/**
 * Boots a real server against one provider in a throwaway environment and
 * runs the full HTTP suite against it.
 *
 * A provider that cannot run in this environment is reported as skipped, not
 * failed: a machine with no MongoDB and no MySQL can still test json and
 * sqlite completely.
 */
async function runApiSuiteForProvider(provider) {
  const skip = (reason) => {
    process.stdout.write(`\n▶ end-to-end API · ${provider} — SKIPPED (${reason})\n`);
    return {
      suite: `api:${provider}`,
      kind: "e2e",
      provider,
      passed: 0,
      failed: 0,
      total: 0,
      skipped: true,
      skipReason: reason,
      ok: true,
    };
  };

  if (provider === "mongo" && !process.env.MONGO_URI) {
    return skip("MONGO_URI not set");
  }
  if (provider === "mysql" && !(await harness.mysqlReachable())) {
    return skip("no MySQL server reachable");
  }

  const sandbox = await createSandbox(provider, { runId });
  process.stdout.write(`\n▶ end-to-end API · ${sandbox.describe}\n`);

  let server = null;
  try {
    server = await startServer({ env: sandbox.env });
    process.stdout.write(`  server ready on ${server.apiUrl}\n`);

    const run = await runNode(path.join(ROOT, "tests/api-test.js"), {
      env: { API_URL: server.apiUrl },
    });
    process.stdout.write(run.stdout);
    if (run.stderr.trim()) process.stderr.write(run.stderr);

    const parsed = parseApiTestReport(run.stdout);
    return {
      suite: `api:${provider}`,
      kind: "e2e",
      provider,
      target: sandbox.describe,
      passed: parsed ? parsed.passed : 0,
      failed: parsed ? parsed.failed : run.ok ? 0 : 1,
      total: parsed ? parsed.total : 0,
      ok: run.ok,
      serverLog: run.ok ? null : server.logs(),
    };
  } catch (err) {
    // A failure to boot is itself a result: this provider cannot run.
    process.stdout.write(`  ✗ could not run: ${err.message}\n`);
    return {
      suite: `api:${provider}`,
      kind: "e2e",
      provider,
      target: sandbox.describe,
      passed: 0,
      failed: 1,
      total: 1,
      ok: false,
      error: err.message,
    };
  } finally {
    if (server) await stopServer(server);
    await sandbox.cleanup();
  }
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

function renderSummary(reports) {
  const kindLabel = { unit: "unit", parity: "parity", e2e: "end-to-end" };
  console.log(heading("Test matrix"));
  console.log(
    `${"Suite".padEnd(26)}${"Kind".padEnd(12)}${"Passed".padStart(8)}${"Failed".padStart(9)}`,
  );
  console.log(line("·"));
  for (const r of reports) {
    const kind = (kindLabel[r.kind] || r.kind).padEnd(12);
    const status = r.skipped ? "skipped" : String(r.passed);
    const label = r.skipped && r.skipReason ? `${r.suite} (${r.skipReason})` : r.suite;
    console.log(
      `${label.padEnd(26)}${kind.padEnd(12)}${status.padStart(8)}${String(r.failed).padStart(9)}`,
    );
  }
  console.log(line("·"));

  const totals = reports.reduce(
    (acc, r) => {
      if (r.skipped) acc.skipped += 1;
      else {
        acc.passed += r.passed;
        acc.failed += r.failed;
        acc.total += r.total;
      }
      return acc;
    },
    { passed: 0, failed: 0, total: 0, skipped: 0 },
  );
  console.log(
    `\nTotals: ${totals.passed} passed, ${totals.failed} failed, ${totals.total} checks` +
      (totals.skipped ? `, ${totals.skipped} suite skipped` : ""),
  );

  const failedSuites = reports.filter((r) => !r.ok);
  if (!failedSuites.length) {
    console.log("✅ All suites passed.\n");
  } else {
    console.log(`\n❌ ${failedSuites.length} suite(s) failed:\n`);
    for (const r of failedSuites) {
      console.log(`   • ${r.suite} (${r.failed} failed)`);
      if (r.error) console.log(`     ${r.error.split("\n")[0]}`);
    }
    console.log("");
  }
}

async function writeReport(reports) {
  const dir = ensureResultsDir();
  const file = path.join(dir, `test-report-${runId}.json`);
  await fsp.writeFile(
    file,
    JSON.stringify(
      {
        runId,
        startedAt: new Date().toISOString(),
        node: process.version,
        platform: process.platform,
        passed: reports.every((r) => r.ok),
        reports,
      },
      null,
      2,
    ),
    "utf8",
  );
  return file;
}

// ---------------------------------------------------------------------------

async function main() {
  const providerFlags = ALL_PROVIDERS.filter((p) => args.has(`--${p}`));
  if (unitOnly && providerFlags.length) {
    console.error(`--unit cannot be combined with ${providerFlags.map((p) => `--${p}`).join("/")}`);
    process.exit(2);
  }

  console.log(heading("Annotator backend — full test matrix"));
  console.log(`node ${process.version} · ${process.platform} · run ${runId}`);

  const reports = [];
  reports.push(...(await runUnitSuites()));

  if (skipProviderSuites) {
    console.log(
      "\n--unit given: skipping the parity and end-to-end suites (no server, no database).",
    );
  } else {
    reports.push(await runParitySuite());

    const providers = providerFlags.length ? providerFlags : ALL_PROVIDERS;
    for (const provider of providers) {
      reports.push(await runApiSuiteForProvider(provider));
    }
  }

  renderSummary(reports);
  const file = await writeReport(reports);
  console.log(`Report written to ${path.relative(ROOT, file)}\n`);

  process.exit(reports.every((r) => r.ok) ? 0 : 1);
}

main().catch((err) => {
  console.error("\nTest runner crashed:", err);
  process.exit(1);
});
