// config/env.js
// Backwards-compatible entry point for configuration validation.
//
// The actual work now lives in config/app.js, which is the only module
// allowed to read `process.env`. This file is kept so `server.js` and any
// scripts keep a stable require path, and so startup failures still report
// every problem at once instead of one per restart.

const { config, assertValid, collectProblems } = require("./app");

/**
 * Validates the resolved configuration and exits the process on failure.
 * Safe to call more than once.
 */
function validateEnv() {
  try {
    assertValid(config);
  } catch (err) {
    console.error(`❌ ${err.message}`);
    console.error(
      `   Provider in use: ${config.storage.provider} (set DATA_PROVIDER to switch)`,
    );
    process.exit(1);
  }
  return true;
}

module.exports = { validateEnv, collectProblems };
