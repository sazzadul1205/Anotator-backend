// tests/unit/sql-store.test.js
// Unit tests for the SQL storage layer: the dialect differences between SQLite
// and MySQL, and the filter/update translation the shared model code depends on.
//
//   node tests/unit/sql-store.test.js
//
// The parity suite proves the SQL providers *behave* like MongoDB. This suite
// covers the parts parity cannot reach cheaply: SQL actually emitted, the
// edge cases of Mongo query semantics, and the encoding round-trips that keep
// Dates, booleans and nested objects intact.
//
// Translation runs against SQLite for real, because it is a file — no server
// and no dependency. The MySQL dialect is asserted by shape.

"use strict";

const assert = require("assert");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const { Suite, runSuites, expect } = require(path.join(ROOT, "tests", "helpers", "harness"));

const { getDialect, columnForKey, EXTRA_COLUMN } = require(
  path.join(ROOT, "config", "storage", "sql", "dialect"),
);
const {
  QueryTranslator,
  docToRow,
  rowToDoc,
  applyUpdate,
  likePattern,
  encodeValue,
  decodeValue,
} = require(path.join(ROOT, "config", "storage", "sql", "translate"));
const { SqlStore } = require(path.join(ROOT, "config", "storage", "sql", "store"));
const { SqliteDriver } = require(path.join(ROOT, "config", "storage", "sql", "sqliteDriver"));
const { COLLECTIONS } = require(path.join(ROOT, "config", "storage", "schema"));

const SQLITE = getDialect("sqlite");
const MYSQL = getDialect("mysql");

/** A translator bound to the `comments` schema, as the models would build it. */
function commentsQuery() {
  return new QueryTranslator(COLLECTIONS.comments.columns, SQLITE);
}

let tmpDir = null;
let store = null;

async function freshStore() {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "annotator-sqlstore-"));
  const driver = new SqliteDriver({ file: path.join(tmpDir, "t.sqlite"), dialect: "sqlite" });
  store = new SqlStore({ driver, dialect: "sqlite" });
  const { ensureSqlSchema } = require(
    path.join(ROOT, "config", "storage", "sql", "ensureSchema"),
  );
  await ensureSqlSchema(store);
  return store;
}

/**
 * Removes a temp directory. Windows can hold the SQLite -wal/-shm sidecars
 * briefly after close, so a first EBUSY is retried rather than failing a
 * suite that has already passed.
 */
async function removeDir(dir) {
  if (!dir) return;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (attempt === 7) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

async function cleanup() {
  if (store) await store.close();
  await removeDir(tmpDir);
  store = null;
  tmpDir = null;
}

// ===========================================================================
// Dialect
// ===========================================================================

const dialectSuite = new Suite("SQL · dialect");

dialectSuite.test("both dialects are registered", () => {
  expect.equal(SQLITE.name, "sqlite");
  expect.equal(MYSQL.name, "mysql");
  let threw = false;
  try {
    getDialect("postgres");
  } catch {
    threw = true;
  }
  expect.ok(threw, "an unknown dialect should be rejected");
});

dialectSuite.test("_id maps onto the id column", () => {
  expect.equal(columnForKey("_id"), "id");
  expect.equal(columnForKey("datasetId"), "datasetId");
});

dialectSuite.test("every declared field has a column type", () => {
  for (const [name, spec] of Object.entries(COLLECTIONS)) {
    for (const [field, kind] of Object.entries(spec.columns)) {
      const sql = SQLITE.type(kind);
      assert.ok(sql && sql !== "undefined", `${name}.${field} has no SQLite type`);
      assert.ok(MYSQL.type(kind), `${name}.${field} has no MySQL type`);
    }
  }
});

dialectSuite.test("CREATE TABLE declares a primary key and the extra column", () => {
  const ddl = SQLITE.tableDdl("comments", COLLECTIONS.comments.columns);
  assert.ok(ddl.includes("CREATE TABLE IF NOT EXISTS"), "should be idempotent");
  assert.ok(ddl.includes('"id" TEXT PRIMARY KEY'), "id must be the primary key");
  assert.ok(ddl.includes(`"${EXTRA_COLUMN}"`), "the extra column must exist");
  // A field with no declared type would produce undefined in the DDL.
  assert.ok(!/undefined/.test(ddl), "no column should render as 'undefined'");
});

dialectSuite.test("MySQL uses InnoDB and utf8mb4", () => {
  const ddl = MYSQL.tableDdl("comments", COLLECTIONS.comments.columns);
  assert.ok(ddl.includes("ENGINE=InnoDB"), "needs transactions and row locking");
  assert.ok(ddl.includes("utf8mb4"), "needs full Unicode");
});

dialectSuite.test("unique indexes become UNIQUE indexes in both dialects", () => {
  const index = COLLECTIONS.comments.indexes.find((i) => i.unique);
  assert.ok(SQLITE.indexDdl("comments", index, "n").startsWith("CREATE UNIQUE INDEX"));
  assert.ok(MYSQL.indexDdl("comments", index, "n").startsWith("CREATE UNIQUE INDEX"));
});

// ===========================================================================
// Filter translation
// ===========================================================================

const filterSuite = new Suite("SQL · filter translation");

filterSuite.test("an empty filter matches everything", () => {
  const { sql, params } = commentsQuery().build({});
  assert.equal(sql, "1=1");
  expect.deep(params, []);
});

filterSuite.test("equality becomes a bound parameter, never interpolation", () => {
  const { sql, params } = commentsQuery().build({ status: "pending" });
  assert.equal(sql, '"status" = ?');
  expect.deep(params, ["pending"]);
});

filterSuite.test("_id is translated to the id column", () => {
  const { sql, params } = commentsQuery().build({ _id: "abc" });
  assert.equal(sql, '"id" = ?');
  expect.deep(params, ["abc"]);
});

filterSuite.test("{ field: null } becomes IS NULL", () => {
  const { sql } = commentsQuery().build({ assignedTo: null });
  assert.equal(sql, '"assignedTo" IS NULL');
});

filterSuite.test("an empty $in matches nothing", () => {
  // The shared filters rely on this: a filter whose every id was malformed
  // must degrade to "match nothing", never to "match everything".
  const { sql, params } = commentsQuery().build({ _id: { $in: [] } });
  assert.ok(sql.includes("1=0"), `expected a never-true predicate, got ${sql}`);
  expect.deep(params, []);
});

filterSuite.test("$in builds a placeholder per value", () => {
  const { sql, params } = commentsQuery().build({ _id: { $in: ["a", "b", "c"] } });
  assert.ok(sql.includes('"id" IN (?, ?, ?)'), `got ${sql}`);
  expect.deep(params, ["a", "b", "c"]);
});

filterSuite.test("$ne also matches rows where the field is absent", () => {
  // Matches Mongo, where a missing field is not equal to the operand.
  const { sql, params } = commentsQuery().build({ status: { $ne: "annotated" } });
  assert.ok(
    sql.includes('"status" <> ? OR "status" IS NULL'),
    `got ${sql}`,
  );
  expect.deep(params, ["annotated"]);
});

filterSuite.test("range operators translate", () => {
  const q = commentsQuery();
  assert.ok(q.build({ createdAt: { $lt: 5 } }).sql.includes('"createdAt" < ?'));
  assert.ok(q.build({ createdAt: { $lte: 5 } }).sql.includes('"createdAt" <= ?'));
  assert.ok(q.build({ createdAt: { $gt: 5 } }).sql.includes('"createdAt" > ?'));
  assert.ok(q.build({ createdAt: { $gte: 5 } }).sql.includes('"createdAt" >= ?'));
});

filterSuite.test("$exists maps to a null check", () => {
  const q = commentsQuery();
  assert.ok(
    q.build({ sentiment: { $exists: true } }).sql.includes('"sentiment" IS NOT NULL'),
  );
  assert.ok(
    q.build({ sentiment: { $exists: false } }).sql.includes('"sentiment" IS NULL'),
  );
});

filterSuite.test("dates are encoded to ISO before binding", () => {
  const when = new Date("2026-01-02T03:04:05.000Z");
  const { params } = commentsQuery().build({ createdAt: { $gte: when } });
  expect.deep(params, ["2026-01-02T03:04:05.000Z"]);
});

filterSuite.test("$regex becomes LIKE with wildcards escaped", () => {
  const { sql, params } = commentsQuery().build({
    commentText: { $regex: "hello", $options: "i" },
  });
  assert.ok(sql.startsWith('"commentText" LIKE ?'), "should be a LIKE match");
  expect.deep(params, ["%hello%"]);
});

filterSuite.test("LIKE's own wildcards in user input are escaped", () => {
  // Without this a search for "50%" would match every row.
  assert.equal(likePattern("50%"), "%50\\%%");
  assert.equal(likePattern("a_b"), "%a\\_b%");
});

filterSuite.test("$and and $or compose", () => {
  const { sql, params } = commentsQuery().build({
    $or: [{ status: "pending" }, { status: "annotated" }],
  });
  assert.ok(sql.includes(" OR "), "should join with OR");
  expect.deep(params, ["pending", "annotated"]);
});

filterSuite.test("filtering an undeclared field fails loudly", () => {
  // Silently returning unfiltered rows would be worse than an error.
  let err = null;
  try {
    commentsQuery().build({ notARealField: "x" });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "should throw");
  assert.ok(err.message.includes("notARealField"), "should name the field");
});

filterSuite.test("an unsupported operator is rejected", () => {
  let err = null;
  try {
    commentsQuery().build({ status: { $where: "1=1" } });
  } catch (e) {
    err = e;
  }
  assert.ok(err && err.message.includes("$where"), "should reject $where");
});

// ===========================================================================
// Encoding round-trips
// ===========================================================================

const encodeSuite = new Suite("SQL · value encoding");

encodeSuite.test("dates round-trip through ISO text", () => {
  const when = new Date("2026-05-06T07:08:09.000Z");
  const stored = encodeValue("date", when);
  assert.equal(stored, "2026-05-06T07:08:09.000Z");
  expect.deep(decodeValue("date", stored), when);
});

encodeSuite.test("ISO dates sort and compare as text", () => {
  // This is why dates are stored as strings: ordering must match ordering in
  // Mongo, and ISO-8601 UTC is lexicographically ordered.
  const a = new Date("2026-01-01T00:00:00.000Z");
  const b = new Date("2026-06-01T00:00:00.000Z");
  assert.ok(encodeValue("date", a) < encodeValue("date", b));
});

encodeSuite.test("booleans store as 0/1 and come back as booleans", () => {
  assert.equal(encodeValue("bool", true), 1);
  assert.equal(encodeValue("bool", false), 0);
  assert.equal(decodeValue("bool", 1), true);
  assert.equal(decodeValue("bool", 0), false);
});

encodeSuite.test("a NULL column reads as an absent field, not null", () => {
  // This is what keeps a SQL row looking like a Mongo document to the DTOs.
  assert.equal(decodeValue("str", null), undefined);
  assert.equal(decodeValue("date", null), undefined);
  assert.equal(decodeValue("json", null), undefined);
});

encodeSuite.test("nested objects and arrays round-trip through JSON", () => {
  const value = { processed: 2, total: 10, nested: { a: [1, 2] } };
  expect.deep(decodeValue("json", encodeValue("json", value)), value);
  expect.deep(decodeValue("json", encodeValue("json", [1, "two"])), [1, "two"]);
});

encodeSuite.test("a corrupt JSON column degrades to the raw text", () => {
  assert.equal(decodeValue("json", "{not json"), "{not json");
});

// ===========================================================================
// Document <-> row
// ===========================================================================

const rowSuite = new Suite("SQL · document and row");

rowSuite.test("a document becomes one row keyed on id", () => {
  const cols = COLLECTIONS.comments.columns;
  const { row, id } = docToRow({ _id: "x1", status: "pending" }, cols);
  assert.equal(id, "x1");
  assert.equal(row.id, "x1");
  assert.equal(row.status, "pending");
});

rowSuite.test("a document without _id is given one", () => {
  const { id } = docToRow({ status: "pending" }, COLLECTIONS.comments.columns);
  assert.equal(typeof id, "string");
  assert.equal(id.length, 24, "should be ObjectId-shaped");
});

rowSuite.test("an explicit _id is preserved", () => {
  // SystemLock uses the lock name as the _id; it must not be replaced.
  const { id } = docToRow({ _id: "admin_bootstrap" }, COLLECTIONS.system_locks.columns);
  assert.equal(id, "admin_bootstrap");
});

rowSuite.test("undeclared fields survive in the extra column", () => {
  const cols = COLLECTIONS.comments.columns;
  const { row } = docToRow({ _id: "x1", somethingNew: { deep: 1 } }, cols);
  const back = rowToDoc(row, cols);
  expect.deep(back.somethingNew, { deep: 1 });
});

rowSuite.test("a row round-trips back to an equivalent document", () => {
  const cols = COLLECTIONS.datasets.columns;
  const doc = {
    _id: "d1",
    name: "Bank",
    status: "completed",
    totalRows: 12,
    progress: { processed: 3 },
    taxonomyId: null,
    createdAt: new Date("2026-02-03T04:05:06.000Z"),
  };
  const { row } = docToRow(doc, cols);
  const back = rowToDoc(row, cols);
  assert.equal(back._id, "d1");
  assert.equal(back.name, "Bank");
  assert.equal(back.totalRows, 12);
  expect.deep(back.progress, { processed: 3 });
  expect.deep(back.createdAt, doc.createdAt);
  // An explicit null reads as absent, which is what the DTOs expect.
  assert.ok(!("taxonomyId" in back), "null should read as an absent field");
});

// ===========================================================================
// Update operators
// ===========================================================================

const updateSuite = new Suite("SQL · update operators");

updateSuite.test("$set reports whether anything actually changed", () => {
  const doc = { status: "pending" };
  assert.equal(applyUpdate(doc, { $set: { status: "pending" } }), false);
  assert.equal(applyUpdate(doc, { $set: { status: "annotated" } }), true);
  assert.equal(doc.status, "annotated");
});

updateSuite.test("an equal Date is not a change", () => {
  const when = new Date("2026-01-01T00:00:00.000Z");
  const doc = { at: when };
  assert.equal(applyUpdate(doc, { $set: { at: new Date(when) } }), false);
});

updateSuite.test("deeply equal objects are not a change", () => {
  const doc = { progress: { a: 1, b: 2 } };
  // Different insertion order must not read as a change.
  assert.equal(applyUpdate(doc, { $set: { progress: { b: 2, a: 1 } } }), false);
  assert.equal(applyUpdate(doc, { $set: { progress: { b: 3, a: 1 } } }), true);
});

updateSuite.test("a dotted $set reaches into a nested object", () => {
  // Dataset.setProgressProcessed relies on this.
  const doc = { progress: { total: 10, processed: 1 } };
  applyUpdate(doc, { $set: { "progress.processed": 5 } });
  expect.deep(doc.progress, { total: 10, processed: 5 });
});

updateSuite.test("$unset removes a field", () => {
  const doc = { a: 1, b: 2 };
  assert.equal(applyUpdate(doc, { $unset: { b: "" } }), true);
  assert.ok(!("b" in doc));
  assert.equal(applyUpdate(doc, { $unset: { b: "" } }), false, "removing again is a no-op");
});

updateSuite.test("$inc adds to a number and treats a missing field as zero", () => {
  const doc = { n: 5 };
  applyUpdate(doc, { $inc: { n: 3 } });
  assert.equal(doc.n, 8);
  applyUpdate(doc, { $inc: { fresh: 2 } });
  assert.equal(doc.fresh, 2);
});

updateSuite.test("an unsupported update operator is rejected", () => {
  let err = null;
  try {
    applyUpdate({}, { $rename: { a: "b" } });
  } catch (e) {
    err = e;
  }
  assert.ok(err && err.message.includes("$rename"), "should reject $rename");
});

// ===========================================================================
// Against a real SQLite database
// ===========================================================================

const liveSuite = new Suite("SQL · sqlite execution");

liveSuite.test("a document survives a full round trip through the database", async () => {
  const s = await freshStore();
  try {
    const users = s.collection("users");
    const { insertedId: id } = await users.insertOne({
      email: "a@b.c",
      name: "A",
      role: "admin",
      isActive: true,
      createdAt: new Date("2026-03-04T05:06:07.000Z"),
    });
    const back = await users.findOne({ _id: id });
    assert.equal(back.email, "a@b.c");
    assert.equal(back.isActive, true);
    expect.deep(back.createdAt, new Date("2026-03-04T05:06:07.000Z"));
  } finally {
    await cleanup();
  }
});

liveSuite.test("a unique violation surfaces as Mongo's code 11000", async () => {
  const s = await freshStore();
  try {
    const users = s.collection("users");
    await users.insertOne({ email: "dup@b.c", name: "First" });
    let err = null;
    try {
      await users.insertOne({ email: "dup@b.c", name: "Second" });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "the duplicate should be rejected");
    assert.equal(err.code, 11000, "models map 11000 to DuplicateKeyError");
  } finally {
    await cleanup();
  }
});

liveSuite.test("a no-op update reports modifiedCount 0", async () => {
  // Mongo reports 0 here, and services branch on it. The SQL drivers disagree
  // natively, so the store has to detect the no-op itself.
  const s = await freshStore();
  try {
    const users = s.collection("users");
    const { insertedId: id } = await users.insertOne({ email: "x@b.c", role: "admin" });
    const r = await users.updateOne({ _id: id }, { $set: { role: "admin" } });
    assert.equal(r.matchedCount, 1, "the row was found");
    assert.equal(r.modifiedCount, 0, "but nothing changed");
  } finally {
    await cleanup();
  }
});

liveSuite.test("a real update reports modifiedCount 1", async () => {
  const s = await freshStore();
  try {
    const users = s.collection("users");
    const { insertedId: id } = await users.insertOne({ email: "y@b.c", role: "annotator" });
    const r = await users.updateOne({ _id: id }, { $set: { role: "admin" } });
    assert.equal(r.modifiedCount, 1);
  } finally {
    await cleanup();
  }
});

liveSuite.test("deleteOne removes only the first match", async () => {
  const s = await freshStore();
  try {
    const users = s.collection("users");
    await users.insertMany([
      { email: "d1@b.c" },
      { email: "d2@b.c" },
    ]);
    const r = await users.deleteOne({ role: { $exists: false } });
    assert.equal(r.deletedCount, 1);
    assert.equal(await users.countDocuments({}), 1, "the second row survives");
  } finally {
    await cleanup();
  }
});

liveSuite.test("insertMany reports partial success like Mongo", async () => {
  const s = await freshStore();
  try {
    const users = s.collection("users");
    let err = null;
    try {
      await users.insertMany(
        [{ email: "p1@b.c" }, { email: "p2@b.c" }, { email: "p1@b.c" }],
        { ordered: false },
      );
    } catch (e) {
      err = e;
    }
    assert.ok(err, "one document failed");
    assert.ok(err.result.insertedIds, "the ids that succeeded must be reported");
    assert.equal(Object.keys(err.result.insertedIds).length, 2);
    assert.equal(await users.countDocuments({}), 2);
  } finally {
    await cleanup();
  }
});

liveSuite.test("sorting skips fields the document does not have", async () => {
  // Taxonomy sorts by kind/order/label, which live inside an array. Every row
  // ties in Mongo, so the column must be skipped rather than invented.
  const s = await freshStore();
  try {
    const tax = s.collection("taxonomies");
    await tax.insertMany([{ name: "b" }, { name: "a" }]);
    const rows = await tax.find({}, { sort: { kind: 1, name: 1 } });
    expect.deep(rows.map((r) => r.name), ["a", "b"], "the real column still sorts");
  } finally {
    await cleanup();
  }
});

liveSuite.test("projection keeps only the requested fields", async () => {
  const s = await freshStore();
  try {
    const users = s.collection("users");
    const { insertedId: id } = await users.insertOne({ email: "p@b.c", name: "P" });
    const row = await users.findOne({ _id: id }, { projection: { email: 1 } });
    expect.deep(Object.keys(row).sort(), ["_id", "email"]);
  } finally {
    await cleanup();
  }
});

liveSuite.test("distinct ignores rows where the field is absent", async () => {
  const s = await freshStore();
  try {
    const logs = s.collection("audit_log");
    await logs.insertMany([{ action: "a" }, { action: "a" }, { action: "b" }, {}]);
    expect.deep((await logs.distinct("action")).sort(), ["a", "b"]);
  } finally {
    await cleanup();
  }
});

liveSuite.test("a null value round-trips as a filterable NULL", async () => {
  const s = await freshStore();
  try {
    const comments = s.collection("comments");
    await comments.insertMany([
      { datasetId: "d", sourceId: "1", assignedTo: null },
      { datasetId: "d", sourceId: "2", assignedTo: "u1" },
      { datasetId: "d", sourceId: "3" },
    ]);
    assert.equal(await comments.countDocuments({ assignedTo: null }), 2);
    assert.equal(await comments.countDocuments({ assignedTo: "u1" }), 1);
    assert.equal(await comments.countDocuments({ assignedTo: { $ne: "u1" } }), 2);
  } finally {
    await cleanup();
  }
});

liveSuite.test("search is case-insensitive and treats % literally", async () => {
  const s = await freshStore();
  try {
    const comments = s.collection("comments");
    await comments.insertMany([
      { sourceId: "1", commentText: "Hello World" },
      { sourceId: "2", commentText: "nothing here" },
      { sourceId: "3", commentText: "50% off" },
    ]);
    assert.equal(await comments.countDocuments({ commentText: { $regex: "hello", $options: "i" } }), 1);
    assert.equal(await comments.countDocuments({ commentText: { $regex: "50%" } }), 1);
    assert.equal(await comments.countDocuments({ commentText: { $regex: "%%%" } }), 0);
  } finally {
    await cleanup();
  }
});

liveSuite.test("data survives closing and reopening the file", async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "annotator-sqlstore-"));
  const file = path.join(dir, "persist.sqlite");
  const { ensureSqlSchema } = require(
    path.join(ROOT, "config", "storage", "sql", "ensureSchema"),
  );
  try {
    let s = new SqlStore({
      driver: new SqliteDriver({ file, dialect: "sqlite" }),
      dialect: "sqlite",
    });
    await ensureSqlSchema(s);
    await s.collection("users").insertOne({ email: "keep@b.c" });
    await s.close();

    // A second process would do exactly this: same file, nothing in memory.
    s = new SqlStore({
      driver: new SqliteDriver({ file, dialect: "sqlite" }),
      dialect: "sqlite",
    });
    assert.equal(await s.collection("users").countDocuments({}), 1);
    await s.close();
  } finally {
    await removeDir(dir);
  }
});

// ===========================================================================

async function main() {
  console.log("\n=== SQL store unit tests ===");
  const summary = await runSuites([
    filterSuite,
    encodeSuite,
    rowSuite,
    updateSuite,
    dialectSuite,
    liveSuite,
  ]);
  console.log(
    `\n=== ${summary.passed} passed, ${summary.failed} failed, ${summary.total} total ===\n`,
  );
  process.exit(summary.failed ? 1 : 0);
}

main().catch((err) => {
  console.error("SQL store unit tests crashed:", err);
  process.exit(1);
});
