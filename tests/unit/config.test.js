// tests/unit/config.test.js
// Unit tests for configuration handling — the surface that decides which
// storage provider runs and what each one requires.
//
//   node tests/unit/config.test.js
//
// If these pass, "change DATA_PROVIDER and restart" is a real, supported
// operation rather than a hopeful claim.

"use strict";

const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const {
  Suite,
  runSuites,
  expect,
  LONG_SECRET,
} = require(path.join(ROOT, "tests", "helpers", "harness"));

const APP_PATH = path.join(ROOT, "config", "app.js");
const STORAGE_PATH = path.join(ROOT, "config", "storage", "index.js");

/**
 * Re-evaluates config/app.js under a given environment.
 *
 * config/app.js resolves process.env once at load time on purpose — that is
 * what makes it usable as an injected value everywhere else. The tests
 * therefore reload the module rather than mutating the resolved object.
 */
function loadConfig(env) {
  const saved = {};
  for (const key of Object.keys(env)) {
    saved[key] = process.env[key];
    if (env[key] === undefined) delete process.env[key];
    else process.env[key] = env[key];
  }
  delete require.cache[require.resolve(APP_PATH)];
  const app = require(APP_PATH);
  return {
    config: app.config,
    collectProblems: app.collectProblems,
    assertValid: app.assertValid,
    restore() {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      delete require.cache[require.resolve(APP_PATH)];
    },
  };
}

const BASE = {
  DATA_PROVIDER: undefined,
  MONGO_URI: undefined,
  DB_NAME: undefined,
  JSON_DATA_DIR: undefined,
  JSON_WRITE_THROUGH: undefined,
  DNS_SERVERS: undefined,
  NODE_ENV: undefined,
  CORS_ORIGIN: undefined,
  JWT_SECRET: LONG_SECRET,
  PORT: undefined,
  RATE_LIMIT_GLOBAL: undefined,
  MAX_CONCURRENT_IMPORTS: undefined,
  SQLITE_FILE: undefined,
  MYSQL_URL: undefined,
  MYSQL_HOST: undefined,
  MYSQL_PORT: undefined,
  MYSQL_USER: undefined,
  MYSQL_PASSWORD: undefined,
  MYSQL_DATABASE: undefined,
};

// ===========================================================================

const selectionSuite = new Suite("config · provider selection");

selectionSuite.test("MongoDB is the default provider", () => {
  const ctx = loadConfig(BASE);
  try {
    expect.equal(ctx.config.storage.provider, "mongo");
  } finally {
    ctx.restore();
  }
});

selectionSuite.test("DATA_PROVIDER=json selects the JSON provider", () => {
  const ctx = loadConfig({ ...BASE, DATA_PROVIDER: "json" });
  try {
    expect.equal(ctx.config.storage.provider, "json");
  } finally {
    ctx.restore();
  }
});

selectionSuite.test("DATA_PROVIDER=sqlite selects the SQLite provider", () => {
  const ctx = loadConfig({ ...BASE, DATA_PROVIDER: "sqlite" });
  try {
    expect.equal(ctx.config.storage.provider, "sqlite");
  } finally {
    ctx.restore();
  }
});

selectionSuite.test("DATA_PROVIDER=mysql selects the MySQL provider", () => {
  const ctx = loadConfig({ ...BASE, DATA_PROVIDER: "mysql" });
  try {
    expect.equal(ctx.config.storage.provider, "mysql");
  } finally {
    ctx.restore();
  }
});

selectionSuite.test("provider names are case-insensitive", () => {
  const ctx = loadConfig({ ...BASE, DATA_PROVIDER: "JSON" });
  try {
    expect.equal(ctx.config.storage.provider, "json");
  } finally {
    ctx.restore();
  }
});

selectionSuite.test("an unknown provider warns and falls back to mongo", () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (msg) => warnings.push(msg);
  let ctx;
  try {
    ctx = loadConfig({ ...BASE, DATA_PROVIDER: "postgres" });
    expect.equal(ctx.config.storage.provider, "mongo");
  } finally {
    console.warn = original;
    ctx && ctx.restore();
  }
  expect.ok(
    warnings.some((w) => w.includes("DATA_PROVIDER") && w.includes("postgres")),
    "should warn about the invalid value",
  );
});

// ===========================================================================

const requirementsSuite = new Suite("config · required variables");

requirementsSuite.test("MongoDB requires MONGO_URI; JSON does not", () => {
  const mongo = loadConfig({ ...BASE, DATA_PROVIDER: "mongo" });
  const json = loadConfig({ ...BASE, DATA_PROVIDER: "json" });
  try {
    expect.ok(
      mongo.collectProblems().some((p) => p.includes("MONGO_URI")),
      "mongo without MONGO_URI should be a problem",
    );
    expect.deep(json.collectProblems(), [], "json needs no Mongo variables");

    const ok = loadConfig({ ...BASE, DATA_PROVIDER: "mongo", MONGO_URI: "mongodb://x/y" });
    try {
      expect.deep(ok.collectProblems(), []);
    } finally {
      ok.restore();
    }
  } finally {
    mongo.restore();
    json.restore();
  }
});

requirementsSuite.test("the MONGO_URI error names the server-free escape hatches", () => {
  const ctx = loadConfig({ ...BASE, DATA_PROVIDER: "mongo" });
  try {
    const problem = ctx.collectProblems().find((p) => p.includes("MONGO_URI"));
    expect.ok(
      problem.includes("DATA_PROVIDER=sqlite"),
      "the message should tell you how to switch",
    );
  } finally {
    ctx.restore();
  }
});

requirementsSuite.test("sqlite and mysql need nothing beyond the provider name", () => {
  // Both must be fully usable with an empty environment: sqlite is a file,
  // and MySQL falls back to the conventional local root/3306 credentials.
  const sqlite = loadConfig({ ...BASE, DATA_PROVIDER: "sqlite" });
  const mysql = loadConfig({ ...BASE, DATA_PROVIDER: "mysql" });
  try {
    expect.deep(sqlite.collectProblems(), [], "sqlite should need no variables");
    expect.deep(mysql.collectProblems(), [], "mysql should need no variables");
  } finally {
    sqlite.restore();
    mysql.restore();
  }
});

requirementsSuite.test("each provider can be configured alongside the others", () => {
  const ctx = loadConfig({
    ...BASE,
    DATA_PROVIDER: "sqlite",
    MONGO_URI: "mongodb://x/y",
    MYSQL_DATABASE: "other",
    SQLITE_FILE: "custom/path.sqlite",
  });
  try {
    expect.equal(ctx.config.storage.sqlite.file.endsWith("custom\\path.sqlite")
      || ctx.config.storage.sqlite.file.endsWith("custom/path.sqlite"), true);
    expect.equal(ctx.config.storage.mongo.uri, "mongodb://x/y");
    expect.equal(ctx.config.storage.mysql.database, "other");
  } finally {
    ctx.restore();
  }
});

requirementsSuite.test("JWT_SECRET is required and must be 32+ characters", () => {
  const missing = loadConfig({ ...BASE, JWT_SECRET: undefined });
  const short = loadConfig({ ...BASE, JWT_SECRET: "too-short" });
  try {
    expect.ok(missing.collectProblems().some((p) => p.includes("JWT_SECRET")));
    expect.ok(short.collectProblems().some((p) => p.includes("32")));
  } finally {
    missing.restore();
    short.restore();
  }
});

requirementsSuite.test("CORS_ORIGIN is required only in production", () => {
  const dev = loadConfig({ ...BASE, NODE_ENV: "development" });
  const prod = loadConfig({ ...BASE, NODE_ENV: "production" });
  try {
    expect.isFalse(dev.collectProblems().some((p) => p.includes("CORS_ORIGIN")));
    expect.ok(prod.collectProblems().some((p) => p.includes("CORS_ORIGIN")));
  } finally {
    dev.restore();
    prod.restore();
  }
});

requirementsSuite.test("assertValid throws with every problem listed at once", () => {
  const ctx = loadConfig({
    ...BASE,
    DATA_PROVIDER: "mongo",
    JWT_SECRET: "short",
    NODE_ENV: "production",
  });
  try {
    let error = null;
    try {
      ctx.assertValid();
    } catch (err) {
      error = err;
    }
    expect.ok(error, "should throw");
    // Failing one variable per restart is the behaviour this replaced.
    expect.ok(error.problems.length >= 3, `expected >=3 problems, got ${error.problems.length}`);
  } finally {
    ctx.restore();
  }
});

// ===========================================================================

const valuesSuite = new Suite("config · value coercion");

valuesSuite.test("PORT falls back to 5000 and rejects out-of-range values", () => {
  const fallback = loadConfig({ ...BASE, PORT: undefined });
  const valid = loadConfig({ ...BASE, PORT: "8080" });
  let clamped;
  const original = console.warn;
  console.warn = () => {};
  try {
    clamped = loadConfig({ ...BASE, PORT: "99999" });
  } finally {
    console.warn = original;
  }
  try {
    expect.equal(fallback.config.port, 5000);
    expect.equal(valid.config.port, 8080);
    expect.equal(clamped.config.port, 5000);
  } finally {
    fallback.restore();
    valid.restore();
    clamped.restore();
  }
});

valuesSuite.test("CORS_ORIGIN becomes a trimmed, empty-free list", () => {
  const ctx = loadConfig({ ...BASE, CORS_ORIGIN: " https://a.com , https://b.com ,, " });
  try {
    expect.deep(ctx.config.corsOrigin, ["https://a.com", "https://b.com"]);
  } finally {
    ctx.restore();
  }
});

valuesSuite.test("DNS_SERVERS becomes a list of trimmed servers", () => {
  const ctx = loadConfig({ ...BASE, MONGO_URI: "mongodb://x/y", DNS_SERVERS: " 8.8.8.8 , 1.1.1.1 " });
  try {
    expect.deep(ctx.config.storage.mongo.dnsServers, ["8.8.8.8", "1.1.1.1"]);
  } finally {
    ctx.restore();
  }
});

valuesSuite.test("booleans accept the usual spellings", () => {
  const cases = [
    ["true", true],
    ["1", true],
    ["on", true],
    ["false", false],
    ["0", false],
    ["off", false],
  ];
  const original = console.warn;
  for (const [raw, expected] of cases) {
    let ctx;
    console.warn = () => {};
    try {
      ctx = loadConfig({ ...BASE, DATA_PROVIDER: "json", JSON_WRITE_THROUGH: raw });
      expect.equal(ctx.config.storage.json.writeThrough, expected, `for "${raw}"`);
    } finally {
      ctx.restore();
      console.warn = original;
    }
  }
});

valuesSuite.test("queue settings are read through, not re-parsed elsewhere", () => {
  const ctx = loadConfig({ ...BASE, MAX_CONCURRENT_IMPORTS: "7" });
  try {
    expect.equal(ctx.config.queues.maxConcurrentImports, 7);
  } finally {
    ctx.restore();
  }
});

valuesSuite.test("the JSON data directory resolves to an absolute path", () => {
  const ctx = loadConfig({ ...BASE, DATA_PROVIDER: "json", JSON_DATA_DIR: "data/json" });
  try {
    expect.isTrue(path.isAbsolute(ctx.config.storage.json.dir));
    expect.ok(ctx.config.storage.json.dir.endsWith(path.join("data", "json")));
  } finally {
    ctx.restore();
  }
});

valuesSuite.test("both providers' settings can be configured at the same time", () => {
  // This is what makes the switch (and the rollback) a one-line change.
  const ctx = loadConfig({
    ...BASE,
    DATA_PROVIDER: "json",
    MONGO_URI: "mongodb://prod/db",
    DB_NAME: "annotator_db",
    JSON_DATA_DIR: "data/json",
  });
  try {
    expect.equal(ctx.config.storage.provider, "json");
    expect.equal(ctx.config.storage.mongo.uri, "mongodb://prod/db");
    expect.equal(ctx.config.storage.mongo.dbName, "annotator_db");
    expect.deep(ctx.collectProblems(), []);
  } finally {
    ctx.restore();
  }
});

// ===========================================================================

const registrySuite = new Suite("config · storage registry");

registrySuite.test("all four providers are registered", () => {
  const ctx = loadConfig({ ...BASE, DATA_PROVIDER: "json" });
  try {
    delete require.cache[require.resolve(STORAGE_PATH)];
    const storage = require(STORAGE_PATH);
    const expected = ["json", "mongo", "mysql", "sqlite"];
    expect.deep(Object.keys(storage.PROVIDERS).sort(), expected);
    expect.deep(storage.KNOWN_PROVIDERS.slice().sort(), expected);
    expect.equal(storage.DEFAULT_PROVIDER, "mongo");
  } finally {
    ctx.restore();
    delete require.cache[require.resolve(STORAGE_PATH)];
  }
});

registrySuite.test("a SQL provider loads without pulling in the other drivers", () => {
  // The point of the lazy registry: selecting sqlite must not require mysql2,
  // and neither must require the mongodb driver.
  const ctx = loadConfig({ ...BASE, DATA_PROVIDER: "sqlite" });
  try {
    delete require.cache[require.resolve(STORAGE_PATH)];
    const storage = require(STORAGE_PATH);
    const provider = storage.PROVIDERS.sqlite.load();
    expect.equal(provider.name, "sqlite");
    expect.deep(provider.requires, [], "sqlite should need no npm dependency");
    expect.ok(
      !Object.keys(require.cache).some((k) => k.includes("node_modules\\mysql2")),
      "loading sqlite must not load mysql2",
    );
  } finally {
    ctx.restore();
    delete require.cache[require.resolve(STORAGE_PATH)];
  }
});

registrySuite.test("an unknown provider fails with a message naming the known ones", () => {
  const ctx = loadConfig({ ...BASE, DATA_PROVIDER: "mongo" });
  try {
    delete require.cache[require.resolve(STORAGE_PATH)];
    const storage = require(STORAGE_PATH);
    let error = null;
    try {
      storage._useProvider("cassandra");
    } catch (err) {
      error = err;
    }
    expect.ok(error, "should throw for an unregistered provider");
    expect.ok(error.message.includes("mongo") && error.message.includes("json"));
  } finally {
    ctx.restore();
    delete require.cache[require.resolve(STORAGE_PATH)];
  }
});

registrySuite.test("running on json does not load the mongodb driver", () => {
  const ctx = loadConfig({ ...BASE, DATA_PROVIDER: "json" });
  try {
    delete require.cache[require.resolve(STORAGE_PATH)];
    const storage = require(STORAGE_PATH);
    const provider = storage.getProvider();
    expect.equal(provider.name, "json");
    expect.deep(provider.requires, [], "the json provider needs no credentials");
    // The whole point of lazy loading: a JSON deployment has no driver.
    expect.ok(
      !Object.keys(require.cache).some((k) => k.includes("mongodb") && k.includes("models")),
      "no model should have pulled in the driver",
    );
  } finally {
    ctx.restore();
    delete require.cache[require.resolve(STORAGE_PATH)];
  }
});

// ===========================================================================

async function main() {
  console.log("\n=== Configuration unit tests ===");
  const summary = await runSuites([
    selectionSuite,
    requirementsSuite,
    valuesSuite,
    registrySuite,
  ]);
  console.log(`\n=== ${summary.passed} passed, ${summary.failed} failed, ${summary.total} total ===\n`);
  process.exit(summary.failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Configuration unit tests crashed:", err);
  process.exit(1);
});
