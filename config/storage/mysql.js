// config/storage/mysql.js
// MySQL / MariaDB storage provider.
//
//   ✅ Real indexes and concurrent writes, so it scales like any server database.
//   ⚠️  Requires a running server and credentials — unlike sqlite or json, this
//      is not a zero-setup provider.
//
// `mysql2` is required lazily inside connect(), so the driver is never loaded
// unless this provider is selected.
//
// The database itself is created on boot if it does not exist, because you
// cannot connect to a database that has not been created yet. That needs a
// connection without a database selected first.
//
// Switch it on with DATA_PROVIDER=mysql.

const { config } = require("../app");
const { SqlStore } = require("./sql/store");
const { MysqlDriver } = require("./sql/mysqlDriver");
const { ensureSqlSchema } = require("./sql/ensureSchema");

let store = null;
let connecting = null;

function poolOptions(database) {
  const cfg = config.storage.mysql;
  return {
    ...connectionOptions(database),
    waitForConnections: true,
    connectionLimit: cfg.connectionLimit,
    // Everything is compared and sorted as text, so keep the session in UTC
    // rather than the server's local zone.
    timezone: "Z",
    charset: "utf8mb4_unicode_ci",
  };
}

/** Connection options, from MYSQL_URL when set, otherwise the discrete parts. */
function connectionOptions(database) {
  const cfg = config.storage.mysql;
  if (cfg.url) {
    const url = new URL(cfg.url);
    return {
      host: url.hostname,
      port: Number(url.port) || 3306,
      user: decodeURIComponent(url.username),
      password: decodeURIComponent(url.password),
      database: database || url.pathname.replace(/^\//, "") || undefined,
    };
  }
  return {
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: database || cfg.database,
  };
}

async function connect() {
  if (store) return store;
  if (connecting) return connecting;

  connecting = (async () => {
    const mysql = require("mysql2/promise");
    const { database } = config.storage.mysql;

    // Step 1: connect without a database and create it if it is missing.
    const adminOptions = connectionOptions(null);
    delete adminOptions.database;
    const admin = await mysql.createConnection(adminOptions);
    try {
      await admin.query(
        `CREATE DATABASE IF NOT EXISTS \`${database.replace(/`/g, "")}\`` +
          " DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci",
      );
    } finally {
      await admin.end();
    }

    // Step 2: pooled connections against that database.
    const pool = mysql.createPool(poolOptions(database));
    const driver = new MysqlDriver({ pool });
    store = new SqlStore({ driver, dialect: "mysql" });

    await store.get("SELECT 1 AS ok");

    console.log(
      `✅ Connected to MySQL (${connectionOptions(database).host}:${connectionOptions(database).port}, db="${database}")`,
    );
    return store;
  })();

  try {
    return await connecting;
  } catch (err) {
    store = null;
    throw err;
  } finally {
    connecting = null;
  }
}

function getStore() {
  return store;
}

async function ping() {
  if (!store) return false;
  await store.get("SELECT 1 AS ok");
  return true;
}

async function ensureSchema() {
  if (!store) throw new Error("MySQL provider is not connected");
  const { tableCount, indexCount } = await ensureSqlSchema(store);
  console.log(`✅ MySQL schema ensured (${tableCount} tables, ${indexCount} indexes)`);
}

async function close() {
  if (store) await store.close().catch(() => {});
  store = null;
}

function describe() {
  const cfg = config.storage.mysql;
  return {
    provider: "mysql",
    ready: !!store,
    // Never echo the password back out through /health.
    detail: {
      host: cfg.url ? "see MYSQL_URL" : cfg.host,
      port: cfg.port,
      database: cfg.database,
    },
  };
}

module.exports = {
  name: "mysql",
  connect,
  getStore,
  ping,
  ensureSchema,
  close,
  describe,
  requires: ["mysql2"],
};
