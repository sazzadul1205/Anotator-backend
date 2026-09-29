// config/storage/index.js
// Storage strategy registry — the single switch that selects a data provider.
//
// Callers never import a provider directly. They import this module and call
// the neutral verbs:
//
//   const storage = require("./config/storage");
//   await storage.init();              // connect + ensure schema
//   const db = storage.getStore();     // provider handle
//   await storage.ping();              // readiness probe for /health
//   await storage.close();             // graceful shutdown
//
// Which provider runs is decided once, at load time, by DATA_PROVIDER. Adding
// a third provider (Postgres, SQLite, …) means adding one file and one line
// to PROVIDERS — no changes anywhere else.

const { config, STORAGE_PROVIDERS, DEFAULT_STORAGE_PROVIDER } = require("../app");

/**
 * Registry of available strategies.
 * Key      — the value accepted in DATA_PROVIDER.
 * load     — lazy so an unused provider is never required (and MongoDB's
 *            driver is never loaded when running on JSON).
 */
const PROVIDERS = {
  mongo: {
    load: () => require("./mongo"),
    requiredEnv: ["MONGO_URI"],
  },
  json: {
    load: () => require("./json"),
    requiredEnv: [],
  },
};

let active = null;

/** The provider key currently in effect. */
function providerName() {
  return config.storage.provider;
}

/** The provider module (contract-shaped), loading it on first use. */
function getProvider() {
  if (active) return active;
  const name = providerName();
  const entry = PROVIDERS[name];
  if (!entry) {
    throw new Error(
      `Unknown storage provider "${name}". Known providers: ${Object.keys(
        PROVIDERS,
      ).join(", ")}`,
    );
  }
  active = entry.load();
  return active;
}

/**
 * Provider contract. Every strategy must implement exactly these members;
 * config/storage/index.js is the only place that calls them.
 *
 *   name       string
 *   connect()           -> Promise<store>
 *   getStore()          -> store | null
 *   ping()              -> Promise<boolean>   (never throws)
 *   ensureSchema()      -> Promise<void>
 *   close()             -> Promise<void>
 *   describe()          -> { provider, ready, detail }
 */
const PROVIDER_CONTRACT = [
  "name",
  "connect",
  "getStore",
  "ping",
  "ensureSchema",
  "close",
  "describe",
];

/** Connect and create the schema/indexes. Safe to call once per process. */
async function init() {
  const provider = getProvider();
  const store = await provider.connect();
  await provider.ensureSchema(store);
  return store;
}

function getStore() {
  return getProvider().getStore();
}

function isReady() {
  const provider = getProvider();
  return !!provider.getStore();
}

async function ping() {
  try {
    return await getProvider().ping();
  } catch (err) {
    console.error(`Storage ping failed (${providerName()}):`, err.message);
    return false;
  }
}

async function close() {
  if (!active) return;
  await active.close();
}

/** Non-throwing status object for /health and diagnostics. */
function status() {
  try {
    return getProvider().describe();
  } catch (err) {
    return { provider: providerName(), ready: false, error: err.message };
  }
}

/** Used by the parity test suite to exercise a provider explicitly. */
function _useProvider(name) {
  if (!PROVIDERS[name]) {
    throw new Error(
      `Unknown provider "${name}". Known providers: ${Object.keys(PROVIDERS).join(", ")}`,
    );
  }
  active = PROVIDERS[name].load();
  return active;
}

function _resetProvider() {
  active = null;
}

module.exports = {
  init,
  getStore,
  isReady,
  ping,
  close,
  status,
  providerName,
  getProvider,
  PROVIDERS,
  PROVIDER_CONTRACT,
  KNOWN_PROVIDERS: STORAGE_PROVIDERS,
  DEFAULT_PROVIDER: DEFAULT_STORAGE_PROVIDER,
  _useProvider,
  _resetProvider,
};
