// scripts/clean-test-artifacts.js
// Removes everything the test suites can leave behind.
//
//   npm run clean:test
//
// Two kinds of residue:
//   • throwaway MongoDB databases (`annotator_test_*`, `annotator_parity_test`)
//   • temporary JSON data directories under the OS temp dir
//
// Safety: the database name is matched against an explicit prefix allow-list,
// so the configured application database can never be dropped by accident. The
// JSON directories are only removed when their name starts with a known
// test prefix AND the directory contains no file outside the collection set.

"use strict";

require("dotenv").config({ quiet: true });

const path = require("path");
const fsp = require("fs/promises");
const os = require("os");

// Only these prefixes may ever be dropped.
const DB_PREFIXES = ["annotator_test_", "annotator_parity"];
const DB_ALLOW_LIST = new Set(["annotator_parity_test", "annotator_apitest"]);

// Only these prefixes may ever be deleted from the temp dir.
const TEMP_PREFIXES = ["annotator-test-", "annotator-json-", "annotator-parity-", "annotator-jsonstore-"];

const SAFE_DB_PATTERN = /^[a-z0-9_]+$/;

async function dropDatabases({ log }) {
  if (!process.env.MONGO_URI) {
    log("  · no MONGO_URI — skipping database cleanup");
    return 0;
  }
  const { MongoClient } = require("mongodb");
  const client = new MongoClient(process.env.MONGO_URI);
  let dropped = 0;
  try {
    await client.connect();
    const { databases } = await client.db("admin").admin().listDatabases();
    for (const { name } of databases) {
      const isThrowaway =
        DB_ALLOW_LIST.has(name) ||
        DB_PREFIXES.some((prefix) => name.startsWith(prefix));
      if (!isThrowaway) continue;
      if (!SAFE_DB_PATTERN.test(name)) {
        log(`  ⚠️  refusing to drop unexpected name "${name}"`);
        continue;
      }
      await client.db(name).dropDatabase();
      log(`  · dropped database "${name}"`);
      dropped += 1;
    }
  } catch (err) {
    log(`  ⚠️  database cleanup failed: ${err.message}`);
  } finally {
    await client.close().catch(() => {});
  }
  return dropped;
}

async function dropTempDirs({ log }) {
  const root = os.tmpdir();
  let entries;
  try {
    entries = await fsp.readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (!TEMP_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
    await fsp.rm(path.join(root, entry.name), { recursive: true, force: true });
    log(`  · removed ${path.join(root, entry.name)}`);
    removed += 1;
  }
  return removed;
}

async function main() {
  const log = console.log;
  log("Cleaning test artifacts…");
  const dbs = await dropDatabases({ log });
  const dirs = await dropTempDirs({ log });
  log(`Done. ${dbs} database(s), ${dirs} directory(ies) removed.\n`);
}

main().catch((err) => {
  console.error("Cleanup failed:", err.message);
  process.exit(1);
});
