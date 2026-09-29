// config/storage/json.js
// In-app JSON storage provider — the opt-in alternative to MongoDB.
//
// Everything lives in plain JSON files under JSON_DATA_DIR, one file per
// collection. The trade-off is deliberate and worth stating plainly:
//
//   ✅ No server to install, no credentials, no network — a single process
//      and a directory is the whole database.
//   ⚠️  Single-process only. Every mutation is funnelled through a per-file
//      write queue, so concurrent requests are safe, but running two server
//      processes against the same directory is NOT supported.
//   ⚠️  Aggregations run in JavaScript, so very large `comments` collections
//      are slower than a real index. This provider targets development,
//      evaluation, and offline/desktop-style deployments.
//
// Switch it on with DATA_PROVIDER=json. Nothing else in the app changes.

const fsp = require("fs/promises");
const path = require("path");

const { config } = require("../app");
const { JsonStore } = require("./jsonStore");
const { COLLECTIONS } = require("./schema");

let store = null;
let connecting = null;

async function connect() {
  if (store) return store;
  if (connecting) return connecting;

  connecting = (async () => {
    const { dir, writeThrough } = config.storage.json;
    await fsp.mkdir(dir, { recursive: true });

    store = new JsonStore({
      dir,
      writeThrough,
      // Only the unique constraints are enforced in code; non-unique indexes
      // have no meaning without a query engine and are ignored.
      indexes: Object.fromEntries(
        Object.entries(COLLECTIONS).map(([name, spec]) => [
          name,
          spec.indexes.filter((i) => i.unique),
        ]),
      ),
    });

    for (const name of Object.keys(COLLECTIONS)) store.collection(name);
    await store.load();

    const existing = await Promise.all(
      Object.keys(COLLECTIONS).map(async (name) => {
        const count = await store.collection(name).countDocuments({});
        return { name, count };
      }),
    );
    const total = existing.reduce((sum, c) => sum + c.count, 0);

    console.log(
      `✅ Connected to JSON store (dir="${dir}", ${total} document(s) across ${existing.length} collection(s))`,
    );
    return store;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

function getStore() {
  return store;
}

async function ping() {
  if (!store) return false;
  await store.command({ ping: 1 });
  return true;
}

/**
 * No-op: a JSON file has no secondary indexes. The unique constraints from
 * config/storage/schema.js are already active because they are enforced on
 * every write by JsonCollection.
 */
async function ensureSchema() {
  if (!store) throw new Error("JSON provider is not connected");
}

async function close() {
  if (store) await store.flushAll().catch(() => {});
  store = null;
}

function describe() {
  return {
    provider: "json",
    ready: !!store,
    detail: {
      dir: config.storage.json.dir,
      writeThrough: config.storage.json.writeThrough,
      collections: store ? [...store.collections.keys()] : [],
    },
  };
}

module.exports = {
  name: "json",
  connect,
  getStore,
  ping,
  ensureSchema,
  close,
  describe,
  requires: [],
  // helper used by the parity test suite
  _internals: { dir: () => path.resolve(config.storage.json.dir) },
};
