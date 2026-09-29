// config/storage/sql/ensureSchema.js
// Creates the tables and indexes declared in config/storage/schema.js.
//
// One implementation for both SQL providers; the dialect supplies the DDL.
// Re-running is safe: SQLite uses IF NOT EXISTS, and MySQL's "already exists"
// error is treated as success.

const { COLLECTIONS } = require("../schema");
const { columnForKey } = require("./dialect");

/** Index names are derived the same way Mongo derives its own. */
function indexName(collection, index) {
  const parts = index.keys.map((key) => `${columnForKey(key)}_${index.direction === -1 ? -1 : 1}`);
  return `${collection}_${parts.join("_")}`;
}

async function ensureSqlSchema(store) {
  const { dialect } = store;
  let tableCount = 0;
  let indexCount = 0;

  for (const [name, spec] of Object.entries(COLLECTIONS)) {
    await store.exec(dialect.tableDdl(name, spec.columns));
    tableCount += 1;

    for (const index of spec.indexes) {
      // The primary key is already unique; re-declaring it as an index would
      // be a duplicate constraint.
      if (index.keys.length === 1 && columnForKey(index.keys[0]) === "id") continue;
      try {
        await store.exec(dialect.indexDdl(name, index, indexName(name, index)));
        indexCount += 1;
      } catch (err) {
        // MySQL has no CREATE INDEX IF NOT EXISTS, so an existing index is
        // reported as an error. That is a success, not a failure.
        if (!/duplicate key name|already exists/i.test(String(err && err.message))) {
          throw err;
        }
      }
    }
  }

  return { tableCount, indexCount };
}

module.exports = { ensureSqlSchema, indexName };
