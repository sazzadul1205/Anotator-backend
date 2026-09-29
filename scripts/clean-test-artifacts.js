// scripts/clean-test-artifacts.js
// Removes everything the test suites can leave behind.
//
//   npm run clean:test
//
// Three kinds of residue:
//   • throwaway MongoDB databases (`annotator_test_*`, `annotator_parity*`)
//   • throwaway MySQL databases (the same names)
//   • temporary JSON / SQLite data directories under the OS temp dir
//
// Safety: the database name is matched against an explicit prefix allow-list,
// so the configured application database can never be dropped by accident. The
// temp directories are only removed when their name starts with a known test
// prefix.

"use strict";

require("dotenv").config({ quiet: true });

const path = require("path");
const fsp = require("fs/promises");
const os = require("os");

// Only these prefixes may ever be dropped.
const DB_PREFIXES = ["annotator_test_", "annotator_parity"];
const DB_ALLOW_LIST = new Set(["annotator_parity_test", "annotator_apitest"]);

// Only these prefixes may ever be deleted from the temp dir.
const TEMP_PREFIXES = [
  "annotator-test-",
  "annotator-json-",
  "annotator-parity-",
  "annotator-jsonstore-",
  "annotator-sqlite-",
  "annotator-sqlstore-",
];

const SAFE_DB_PATTERN = /^[a-z0-9_]+$/;

function isThrowawayName(name) {
  return DB_ALLOW_LIST.has(name) || DB_PREFIXES.some((p) => name.startsWith(p));
}

async function dropMongoDatabases({ log }) {
  if (!process.env.MONGO_URI) {
    log("  · no MONGO_URI — skipping MongoDB cleanup");
    return 0;
  }
  const { MongoClient } = require("mongodb");
  const client = new MongoClient(process.env.MONGO_URI);
  let dropped = 0;
  try {
    await client.connect();
    const { databases } = await client.db("admin").admin().listDatabases();
    for (const { name } of databases) {
      if (!isThrowawayName(name)) continue;
      if (!SAFE_DB_PATTERN.test(name)) {
        log(`  ⚠️  refusing to drop unexpected name "${name}"`);
        continue;
      }
      await client.db(name).dropDatabase();
      log(`  · dropped MongoDB database "${name}"`);
      dropped += 1;
    }
  } catch (err) {
    log(`  ⚠️  MongoDB cleanup failed: ${err.message}`);
  } finally {
    await client.close().catch(() => {});
  }
  return dropped;
}

async function dropMysqlDatabases({ log }) {
  let conn;
  try {
    const mysql = require("mysql2/promise");
    const { config } = require("../config/app");
    const c = config.storage.mysql;
    const opts = c.url
      ? (() => {
          const url = new URL(c.url);
          return {
            host: url.hostname,
            port: Number(url.port) || 3306,
            user: decodeURIComponent(url.username),
            password: decodeURIComponent(url.password),
          };
        })()
      : { host: c.host, port: c.port, user: c.user, password: c.password };

    conn = await mysql.createConnection({ ...opts, connectTimeout: 3000 });
    const [rows] = await conn.query("SHOW DATABASES");
    let dropped = 0;
    for (const row of rows) {
      const name = row.Database || Object.values(row)[0];
      if (!isThrowawayName(name)) continue;
      if (!SAFE_DB_PATTERN.test(name)) {
        log(`  ⚠️  refusing to drop unexpected name "${name}"`);
        continue;
      }
      await conn.query(`DROP DATABASE \`${name.replace(/`/g, "")}\``);
      log(`  · dropped MySQL database "${name}"`);
      dropped += 1;
    }
    return dropped;
  } catch (err) {
    // No MySQL server is a normal situation, not a failure worth shouting about.
    log(`  · skipped MySQL cleanup (${err.message})`);
    return 0;
  } finally {
    if (conn) await conn.end().catch(() => {});
  }
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
  const dbs =
    (await dropMongoDatabases({ log })) + (await dropMysqlDatabases({ log }));
  const dirs = await dropTempDirs({ log });
  log(`Done. ${dbs} database(s), ${dirs} directory(ies) removed.\n`);
}

main().catch((err) => {
  console.error("Cleanup failed:", err.message);
  process.exit(1);
});
