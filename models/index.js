// models/index.js
// The bulwark.
//
// Everything above this file — services, controllers, routes, middleware —
// sees one stable set of model classes and never learns which storage
// provider is underneath. This is the only module that knows both strategies
// exist, and the only place the switch is expressed:
//
//     const models = require("./models");            // chosen by DATA_PROVIDER
//     const { Comment, Dataset, User } = models;
//
// Selecting a strategy is three steps, and step 1 is all that ever changes
// between providers:
//   1. DATA_PROVIDER selects a folder below (mongo | json)
//   2. that folder is required lazily, so an unused driver is never loaded
//   3. the loaded models are checked against models/contract.js
//
// `verifyContract()` is not ceremony: it is what makes adding a method to one
// provider and forgetting the other a boot-time error instead of a 500 in
// production.

const { config } = require("../config/app");
const { verifyContract } = require("./contract");

/** Strategy registry. Key must match a DATA_PROVIDER value. */
const STRATEGIES = {
  mongo: () => require("./mongo"),
  json: () => require("./json"),
};

let models = null;

function load(providerName) {
  const loadStrategy = STRATEGIES[providerName];
  if (!loadStrategy) {
    throw new Error(
      `No model strategy registered for provider "${providerName}". ` +
        `Known strategies: ${Object.keys(STRATEGIES).join(", ")}`,
    );
  }

  const loaded = loadStrategy();
  // Tag it so a contract failure names the offending provider.
  Object.defineProperty(loaded, "__providerName", {
    value: providerName,
    enumerable: false,
  });

  verifyContract(loaded);
  console.log(`🧱 Model layer bound to provider "${providerName}"`);
  return loaded;
}

/** The model set for the configured provider. Loads it on first use. */
function getModels() {
  if (!models) models = load(config.storage.provider);
  return models;
}

// --- Re-exported model classes ---------------------------------------------
// Exported as lazy getters so `require("../models")` is cheap and so the
// strategy is only resolved when a model is actually touched.

for (const name of ["Comment", "CommentVersion", "Dataset", "User", "Taxonomy", "AuditLog", "SystemLock"]) {
  Object.defineProperty(module.exports, name, {
    enumerable: true,
    configurable: true,
    get: () => getModels()[name],
  });
}

module.exports.errors = require("./errors");

/** Diagnostics: which strategy is live, and whether it satisfies the contract. */
module.exports.diagnostics = {
  provider: () => config.storage.provider,
  strategies: () => Object.keys(STRATEGIES),
  loaded: () => !!models,
  verify: () => verifyContract(getModels(), { throwOnGap: false }),
  // used by tests/storage-parity.js to exercise both strategies in one process
  _useStrategy: (name) => {
    models = load(name);
    return models;
  },
};
