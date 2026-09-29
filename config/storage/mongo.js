// config/storage/mongo.js
// MongoDB storage provider — the default strategy.
//
// `mongodb` is required lazily, inside `connect()`, so that running with
// DATA_PROVIDER=json never loads the driver and never touches the network.

const { config } = require("../app");
const { COLLECTIONS } = require("./schema");

let client = null;
let db = null;
let connecting = null;

function applyDnsOverrides() {
  // Only override DNS when explicitly configured. Hard-coding 8.8.8.8 breaks
  // in private networks and where it is blocked.
  const servers = config.storage.mongo.dnsServers;
  if (!servers.length) return;
  require("dns").setServers(servers);
}

/**
 * Translates a schema entry into a Mongo index spec.
 * The generated name matches MongoDB's own default (`field_1`, `a_1_b_-1`)
 * so re-running against a database whose indexes were created earlier — or by
 * the previous `config/indexes.js` — is a no-op instead of a name conflict.
 */
function toMongoIndex(index) {
  const spec = {};
  const nameParts = [];
  for (const key of index.keys) {
    const dir = index.direction === -1 ? -1 : 1;
    spec[key] = dir;
    nameParts.push(`${key}_${dir}`);
  }
  return { key: spec, name: nameParts.join("_") };
}

async function connect() {
  if (db) return db;
  if (connecting) return connecting;

  connecting = (async () => {
    applyDnsOverrides();

    const { MongoClient, ServerApiVersion } = require("mongodb");
    client = new MongoClient(config.storage.mongo.uri, {
      serverApi: {
        version: ServerApiVersion.v1,
        strict: false,
        deprecationErrors: true,
      },
    });

    await client.connect();
    await client.db("admin").command({ ping: 1 });
    db = client.db(config.storage.mongo.dbName);
    console.log(
      `✅ Connected to MongoDB (db="${config.storage.mongo.dbName}")`,
    );
    return db;
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

function getStore() {
  return db;
}

async function ping() {
  if (!db) return false;
  await db.command({ ping: 1 });
  return true;
}

/**
 * Creates every index declared in config/storage/schema.js.
 * Re-running is a no-op in Mongo, so it is safe on every boot.
 */
async function ensureSchema() {
  if (!db) throw new Error("MongoDB provider is not connected");
  const jobs = [];
  for (const [name, spec] of Object.entries(COLLECTIONS)) {
    const collection = db.collection(name);
    for (const index of spec.indexes) {
      // `_id` is implicitly unique in Mongo and the index always exists.
      // The schema still declares it, because the JSON provider has to
      // enforce that constraint in code.
      if (index.keys.length === 1 && index.keys[0] === "_id") continue;
      const { key, name: indexName } = toMongoIndex(index);
      jobs.push(
        collection.createIndex(key, {
          name: indexName,
          ...(index.unique ? { unique: true } : {}),
        }),
      );
    }
  }
  await Promise.all(jobs);
  console.log(`✅ DB indexes ensured (${jobs.length} indexes)`);
}

async function close() {
  if (client) {
    await client.close().catch(() => {});
  }
  client = null;
  db = null;
}

/** Safe for /health — never throws. */
function describe() {
  return {
    provider: "mongo",
    ready: !!db,
    detail: { dbName: config.storage.mongo.dbName },
  };
}

module.exports = {
  name: "mongo",
  connect,
  getStore,
  ping,
  ensureSchema,
  close,
  describe,
  requires: ["MONGO_URI"],
};
