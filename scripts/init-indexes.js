// scripts/init-indexes.js
// Run once: npm run init-indexes
// Safe to re-run — creating an existing index is a no-op.
//
// Provider-aware: it applies whatever schema the currently configured
// DATA_PROVIDER declares (config/storage/schema.js). For MongoDB that means
// creating the real indexes; for the JSON store it is a no-op, because the
// unique constraints are enforced in code on every write.

require("dotenv").config();

const { config } = require("../config/app");
const storage = require("../config/storage");

async function main() {
  const provider = storage.getProvider();
  console.log(`Applying schema for provider "${provider.name}"...`);

  await storage.init();

  console.log(`\nSchema applied successfully.`);
  if (provider.name === "json") {
    console.log(
      `The JSON store has no secondary indexes; data lives in ${config.storage.json.dir}`,
    );
  }
}

main()
  .then(() => storage.close())
  .catch((err) => {
    console.error("Schema application failed:", err.message);
    process.exit(1);
  });
