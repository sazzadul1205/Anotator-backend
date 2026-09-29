// config/storage/sqlite.js
// SQLite storage provider.
//
//   ✅ A real query planner and indexes, so large datasets stay fast.
//   ✅ A single file, no server, no credentials.
//   ✅ No dependency at all — Node ships `node:sqlite` (Node 22.5+).
//   ⚠️  Concurrent writers serialise on the database file. Fine for a single
//      Node process, which is how this is normally deployed; it is not a
//      substitute for a server database when several processes write at once.
//
// Switch it on with DATA_PROVIDER=sqlite. Nothing else in the app changes.

const { config } = require("../app");
const { SqlStore } = require("./sql/store");
const { SqliteDriver } = require("./sql/sqliteDriver");
const { ensureSqlSchema } = require("./sql/ensureSchema");

let store = null;
let connecting = null;

async function connect() {
  if (store) return store;
  if (connecting) return connecting;

  connecting = (async () => {
    const { file } = config.storage.sqlite;
    await SqliteDriver.prepareDir(file);

    const driver = new SqliteDriver({ file, dialect: "sqlite" });
    store = new SqlStore({ driver, dialect: "sqlite" });

    // Prove the file is actually readable and writable before declaring ready.
    await store.exec("SELECT 1");

    console.log(`✅ Connected to SQLite (file="${file}")`);
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

/**
 * Creates the tables and indexes from config/storage/schema.js. Both use
 * IF NOT EXISTS, so this is safe on every boot.
 */
async function ensureSchema() {
  if (!store) throw new Error("SQLite provider is not connected");
  const { tableCount, indexCount } = await ensureSqlSchema(store);
  console.log(`✅ SQLite schema ensured (${tableCount} tables, ${indexCount} indexes)`);
}

async function close() {
  if (store) await store.close().catch(() => {});
  store = null;
}

function describe() {
  return {
    provider: "sqlite",
    ready: !!store,
    detail: { file: config.storage.sqlite.file },
  };
}

module.exports = {
  name: "sqlite",
  connect,
  getStore,
  ping,
  ensureSchema,
  close,
  describe,
  requires: [],
};
