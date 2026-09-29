// config/app.js
// The single place in the application that reads `process.env`.
//
// Why this file exists
// --------------------
// Previously every module reached for `process.env` on its own, which meant:
//   * required-variable knowledge was scattered (env.js, db.js, server.js,
//     auth.js, concurrency.js) and inconsistent,
//   * switching data providers required editing logic in `config/db.js`,
//   * there was no way to unit-test a module without mutating global state.
//
// Rule for the rest of the codebase: **do not read `process.env` outside this
// file.** Import `config` from here instead. That is what makes the provider
// switch a pure configuration change.

const path = require("path");

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function str(name, fallback = undefined) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return String(raw).trim();
}

function bool(name, fallback = false) {
  const raw = str(name);
  if (raw === undefined) return fallback;
  const v = raw.toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off"].includes(v)) return false;
  console.warn(`⚠️  ${name}="${raw}" is not a boolean; using ${fallback}`);
  return fallback;
}

function int(name, fallback, { min = -Infinity, max = Infinity } = {}) {
  const raw = str(name);
  if (raw === undefined) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < min || n > max) {
    console.warn(
      `⚠️  ${name}="${raw}" is invalid; using default ${fallback} (range ${min}-${max})`,
    );
    return fallback;
  }
  return n;
}

function list(name, fallback = []) {
  const raw = str(name);
  if (raw === undefined) return fallback;
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function oneOf(name, allowed, fallback) {
  const raw = str(name);
  if (raw === undefined) return fallback;
  const v = raw.toLowerCase();
  if (!allowed.includes(v)) {
    console.warn(
      `⚠️  ${name}="${raw}" is not a valid value (expected one of: ${allowed.join(
        ", ",
      )}); using "${fallback}"`,
    );
    return fallback;
  }
  return v;
}

// ---------------------------------------------------------------------------
// Storage provider
// ---------------------------------------------------------------------------

/** Every provider key registered in config/storage/index.js. */
const STORAGE_PROVIDERS = ["mongo", "json", "sqlite", "mysql"];

/** MongoDB stays the default; every other provider is opt-in. */
const DEFAULT_STORAGE_PROVIDER = "mongo";

const rootDir = path.resolve(__dirname, "..");

const config = {
  // --- Runtime -------------------------------------------------------------
  env: str("NODE_ENV", "development"),
  isProduction: str("NODE_ENV", "development") === "production",
  port: int("PORT", 5000, { min: 1, max: 65535 }),
  corsOrigin: list("CORS_ORIGIN", []),

  // --- Auth ----------------------------------------------------------------
  jwtSecret: str("JWT_SECRET"),

  // --- Storage (provider switch) -------------------------------------------
  // `DATA_PROVIDER` picks the strategy. Everything below the provider is
  // namespaced so both providers can be configured side by side, which keeps
  // a rollback to MongoDB a one-line change.
  storage: {
    provider: oneOf(
      "DATA_PROVIDER",
      STORAGE_PROVIDERS,
      DEFAULT_STORAGE_PROVIDER,
    ),
    mongo: {
      uri: str("MONGO_URI"),
      dbName: str("DB_NAME", "annotator_db"),
      dnsServers: list("DNS_SERVERS", []),
    },
    json: {
      // Directory holding one JSON file per collection.
      dir: path.resolve(rootDir, str("JSON_DATA_DIR", "storage/json-data")),
      // When true the store flushes after every mutation (crash-safe).
      // When false it batches writes for throughput.
      writeThrough: bool("JSON_WRITE_THROUGH", true),
    },
    sqlite: {
      // Path to the database file. The parent directory is created on boot.
      file: path.resolve(rootDir, str("SQLITE_FILE", "storage/annotator.sqlite")),
    },
    mysql: {
      // Set MYSQL_URL, or the discrete parts below. MYSQL_URL wins.
      url: str("MYSQL_URL"),
      host: str("MYSQL_HOST", "127.0.0.1"),
      port: int("MYSQL_PORT", 3306, { min: 1, max: 65535 }),
      user: str("MYSQL_USER", "root"),
      password: str("MYSQL_PASSWORD", ""),
      database: str("MYSQL_DATABASE", "annotator_db"),
      // Cap on pooled connections. Match this to the server's max_connections
      // minus headroom, or the pool will queue behind itself.
      connectionLimit: int("MYSQL_POOL_SIZE", 10, { min: 1, max: 100 }),
    },
  },

  // --- Concurrency queues ---------------------------------------------------
  queues: {
    maxConcurrentImports: int("MAX_CONCURRENT_IMPORTS", 2, { min: 1, max: 64 }),
    maxConcurrentExports: int("MAX_CONCURRENT_EXPORTS", 4, { min: 1, max: 64 }),
    maxQueueSize: int("MAX_QUEUE_SIZE", 100, { min: 1, max: 10000 }),
    jobTimeoutMs: int("JOB_TIMEOUT_MS", 10 * 60 * 1000, {
      min: 1000,
      max: 24 * 60 * 60 * 1000,
    }),
    exportTimeoutMs: int("EXPORT_TIMEOUT_MS", 60 * 1000, {
      min: 1000,
      max: 10 * 60 * 1000,
    }),
    logIntervalMs: int("QUEUE_LOG_INTERVAL_MS", 60000, {
      min: 5000,
      max: 60 * 60 * 1000,
    }),
  },

  // --- Rate limiting --------------------------------------------------------
  rateLimit: {
    // requests / minute
    global: int("RATE_LIMIT_GLOBAL", 0) || null, // 0 => derive from env
    auth: int("RATE_LIMIT_AUTH", 0) || null,
  },
};

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Returns a list of human-readable problems. Empty list means the config is
 * usable. Kept side-effect free (no process.exit) so it can be unit tested and
 * so a future CLI/doctor command can reuse it.
 */
function collectProblems(cfg = config) {
  const problems = [];

  if (!cfg.jwtSecret) {
    problems.push("JWT_SECRET is required");
  } else if (cfg.jwtSecret.length < 32) {
    problems.push("JWT_SECRET must be at least 32 characters");
  }

  if (cfg.isProduction && cfg.corsOrigin.length === 0) {
    problems.push("CORS_ORIGIN is required in production");
  }

  // Only demand credentials for the provider that is actually selected, and
  // name an escape hatch in the message so the fix is obvious.
  if (cfg.storage.provider === "mongo" && !cfg.storage.mongo.uri) {
    problems.push(
      "MONGO_URI is required when DATA_PROVIDER=mongo " +
        "(set DATA_PROVIDER=sqlite, json or mysql to avoid a database server)",
    );
  }

  if (cfg.storage.provider === "mysql" && !cfg.storage.mysql.url && !cfg.storage.mysql.user) {
    problems.push("MYSQL_USER is required when DATA_PROVIDER=mysql");
  }

  if (cfg.storage.provider === "sqlite" && !cfg.storage.sqlite.file) {
    problems.push("SQLITE_FILE is required when DATA_PROVIDER=sqlite");
  }

  if (!STORAGE_PROVIDERS.includes(cfg.storage.provider)) {
    problems.push(
      `DATA_PROVIDER "${cfg.storage.provider}" is not registered (known: ${STORAGE_PROVIDERS.join(", ")})`,
    );
  }

  return problems;
}

/** Throws with a readable message if anything is missing. */
function assertValid(cfg = config) {
  const problems = collectProblems(cfg);
  if (problems.length) {
    const error = new Error(
      `Invalid configuration:\n  - ${problems.join("\n  - ")}`,
    );
    error.problems = problems;
    throw error;
  }
  return true;
}

module.exports = {
  config,
  assertValid,
  collectProblems,
  STORAGE_PROVIDERS,
  DEFAULT_STORAGE_PROVIDER,
  // exported for tests that need to exercise the primitives in isolation
  _internals: { str, bool, int, list, oneOf },
};
