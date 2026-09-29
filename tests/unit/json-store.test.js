// tests/unit/json-store.test.js
// Unit tests for the JSON document store — the machinery the JSON storage
// provider is built on.
//
//   node tests/unit/json-store.test.js
//
// These are the tests that make the JSON provider trustworthy. The parity
// suite proves it *behaves* like MongoDB; this suite pins down the parts that
// parity cannot easily reach: query semantics, update operators, constraint
// enforcement, serialisation, and durability across a process restart.

"use strict";

const assert = require("assert");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const {
  JsonStore,
  DUPLICATE_KEY_CODE,
  newId,
  _internals,
} = require(path.join(ROOT, "config", "storage", "jsonStore"));
const { Suite, runSuites } = require(path.join(ROOT, "tests", "helpers", "harness"));

const { matchesFilter, encode, decode, compareValues } = _internals;

let tmpDir;

async function freshStore(indexes = {}) {
  tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "annotator-jsonstore-"));
  const store = new JsonStore({ dir: tmpDir, writeThrough: true, indexes });
  store.collection("things");
  await store.load();
  return store;
}

async function cleanup() {
  if (tmpDir) await fsp.rm(tmpDir, { recursive: true, force: true });
}

// ===========================================================================
// Query matching — the semantics the models depend on
// ===========================================================================

const querySuite = new Suite("JSON store · query matching");

querySuite.test("equality on scalars, dates and nested values", () => {
  const doc = { a: 1, b: "x", c: new Date("2026-01-01T00:00:00Z"), d: { e: 2 } };
  assert.ok(matchesFilter(doc, { a: 1 }));
  assert.ok(matchesFilter(doc, { b: "x" }));
  assert.ok(matchesFilter(doc, { c: new Date("2026-01-01T00:00:00Z") }));
  assert.ok(matchesFilter(doc, { d: { e: 2 } }));
  assert.ok(!matchesFilter(doc, { a: 2 }));
});

querySuite.test("{ field: null } matches null AND missing, like MongoDB", () => {
  // This is the rule that makes `assignedTo: null` ("unassigned") work.
  assert.ok(matchesFilter({ assignedTo: null }, { assignedTo: null }));
  assert.ok(matchesFilter({}, { assignedTo: null }));
  assert.ok(!matchesFilter({ assignedTo: "u1" }, { assignedTo: null }));
});

querySuite.test("$in / $nin, including an empty $in matching nothing", () => {
  assert.ok(matchesFilter({ a: 1 }, { a: { $in: [1, 2] } }));
  assert.ok(!matchesFilter({ a: 3 }, { a: { $in: [1, 2] } }));
  assert.ok(!matchesFilter({ a: 1 }, { a: { $in: [] } }));
  assert.ok(matchesFilter({ a: 3 }, { a: { $nin: [1, 2] } }));
});

querySuite.test("$ne matches documents where the field is absent", () => {
  assert.ok(matchesFilter({ status: "pending" }, { status: { $ne: "annotated" } }));
  assert.ok(matchesFilter({}, { status: { $ne: "annotated" } }));
  assert.ok(!matchesFilter({ status: "annotated" }, { status: { $ne: "annotated" } }));
});

querySuite.test("$exists distinguishes present-but-null from absent", () => {
  assert.ok(matchesFilter({ a: null }, { a: { $exists: true } }));
  assert.ok(!matchesFilter({}, { a: { $exists: true } }));
  assert.ok(matchesFilter({}, { a: { $exists: false } }));
});

querySuite.test("$lt / $lte / $gt / $gte compare dates and numbers", () => {
  const cutoff = new Date("2026-01-01T00:00:00Z");
  const doc = { updatedAt: new Date("2025-06-01T00:00:00Z"), n: 5 };
  assert.ok(matchesFilter(doc, { updatedAt: { $lt: cutoff } }));
  assert.ok(!matchesFilter(doc, { updatedAt: { $gt: cutoff } }));
  assert.ok(matchesFilter(doc, { n: { $gte: 5, $lte: 5 } }));
  assert.ok(!matchesFilter(doc, { n: { $lt: 5 } }));
});

querySuite.test("$regex is case-sensitive without $options, insensitive with it", () => {
  assert.ok(matchesFilter({ text: "GREAT product" }, { text: { $regex: "great", $options: "i" } }));
  assert.ok(!matchesFilter({ text: "GREAT product" }, { text: { $regex: "great" } }));
  assert.ok(matchesFilter({ text: "great product" }, { text: { $regex: "great" } }));
  assert.ok(!matchesFilter({ text: 12345 }, { text: { $regex: "great" } }));
});

querySuite.test("dotted paths traverse nested documents", () => {
  const doc = { progress: { processed: 7, meta: { phase: "inserting" } } };
  assert.ok(matchesFilter(doc, { "progress.processed": 7 }));
  assert.ok(matchesFilter(doc, { "progress.meta.phase": "inserting" }));
  assert.ok(matchesFilter(doc, { "progress.missing": null }));
  assert.ok(!matchesFilter(doc, { "progress.processed": 8 }));
});

querySuite.test("$and / $or combine", () => {
  const doc = { a: 1, b: 2 };
  assert.ok(matchesFilter(doc, { $and: [{ a: 1 }, { b: 2 }] }));
  assert.ok(matchesFilter(doc, { $or: [{ a: 9 }, { b: 2 }] }));
  assert.ok(!matchesFilter(doc, { $or: [{ a: 9 }, { b: 9 }] }));
});

querySuite.test("an unsupported operator fails loudly instead of matching everything", () => {
  // Silently ignoring a filter would return wrong data with no signal.
  assert.throws(() => matchesFilter({ a: 1 }, { a: { $bogus: 1 } }), /unsupported query operator/);
});

querySuite.test("type ordering follows Mongo's BSON ordering", () => {
  // null < boolean < number < string < date — this is what makes a missing
  // sort key land first, as it does in MongoDB.
  assert.ok(compareValues(null, 1) < 0);
  assert.ok(compareValues(1, "a") < 0);
  assert.ok(compareValues("a", new Date()) < 0);
  assert.ok(compareValues(new Date(0), new Date(1)) < 0);
});

// ===========================================================================
// Serialisation
// ===========================================================================

const serialisationSuite = new Suite("JSON store · serialisation");

serialisationSuite.test("Dates survive a JSON round trip as Dates", () => {
  const now = new Date("2026-03-04T05:06:07.008Z");
  const encoded = encode({ at: now, nested: { list: [now] } });
  // Must not be a bare string, or a reload would silently change the type.
  assert.deepStrictEqual(encoded.at, { $date: now.toISOString() });
  const decoded = decode(encoded);
  assert.ok(decoded.at instanceof Date);
  assert.strictEqual(decoded.at.getTime(), now.getTime());
  assert.ok(decoded.nested.list[0] instanceof Date);
});

serialisationSuite.test("a string that looks like a timestamp stays a string", () => {
  const value = "2026-03-04T05:06:07.008Z";
  const decoded = decode(encode({ v: value }));
  assert.strictEqual(decoded.v, value);
  assert.strictEqual(typeof decoded.v, "string");
});

serialisationSuite.test("undefined fields are dropped, as Mongo does", () => {
  assert.deepStrictEqual(encode({ a: 1, b: undefined }), { a: 1 });
});

serialisationSuite.test("arrays of plain values round trip unchanged", () => {
  const value = { list: [1, "two", false, null, { k: "v" }] };
  assert.deepStrictEqual(decode(encode(value)), value);
});

serialisationSuite.test("generated ids are 24-char hex, ObjectId-shaped", () => {
  const id = newId();
  assert.match(id, /^[0-9a-f]{24}$/);
  assert.notStrictEqual(newId(), newId());
});

// ===========================================================================
// Writes, updates and constraints
// ===========================================================================

const writeSuite = new Suite("JSON store · writes and constraints");

writeSuite.test("insertOne assigns an id and returns it", async () => {
  const store = await freshStore();
  const r = await store.collection("things").insertOne({ a: 1 });
  assert.ok(r.insertedId);
  assert.strictEqual(r.acknowledged, true);
  const doc = await store.collection("things").findOne({ a: 1 });
  assert.strictEqual(doc._id, r.insertedId);
  await cleanup();
});

writeSuite.test("an explicit _id is preserved (SystemLock relies on this)", async () => {
  const store = await freshStore({ things: [{ keys: ["_id"], unique: true }] });
  await store.collection("things").insertOne({ _id: "admin_bootstrap" });
  const doc = await store.collection("things").findOne({ _id: "admin_bootstrap" });
  assert.ok(doc);
  await cleanup();
});

writeSuite.test("a unique violation throws code 11000, like the Mongo driver", async () => {
  const store = await freshStore({ things: [{ keys: ["email"], unique: true }] });
  const col = store.collection("things");
  await col.insertOne({ email: "a@example.com" });
  await assert.rejects(
    () => col.insertOne({ email: "a@example.com" }),
    (err) => err.code === DUPLICATE_KEY_CODE,
  );
  await cleanup();
});

writeSuite.test("a compound unique index matches on the whole key, not one part", async () => {
  const store = await freshStore({
    things: [{ keys: ["datasetId", "sourceId"], unique: true }],
  });
  const col = store.collection("things");
  await col.insertOne({ datasetId: "d1", sourceId: "r1" });
  // Same sourceId in another dataset is fine.
  await col.insertOne({ datasetId: "d2", sourceId: "r1" });
  await assert.rejects(
    () => col.insertOne({ datasetId: "d1", sourceId: "r1" }),
    (err) => err.code === DUPLICATE_KEY_CODE,
  );
  await cleanup();
});

writeSuite.test("null values do not collide under a unique index", async () => {
  // Every unassigned comment has assignedTo: null; they must not be treated
  // as duplicates of each other.
  const store = await freshStore({ things: [{ keys: ["owner"], unique: true }] });
  const col = store.collection("things");
  await col.insertOne({ owner: null });
  await col.insertOne({ owner: null });
  assert.strictEqual(await col.countDocuments({}), 2);
  await cleanup();
});

writeSuite.test("insertMany({ ordered: false }) keeps successes and reports them", async () => {
  const store = await freshStore({ things: [{ keys: ["email"], unique: true }] });
  const col = store.collection("things");
  await col.insertOne({ email: "taken@example.com" });

  let error = null;
  try {
    await col.insertMany(
      [
        { email: "new1@example.com" },
        { email: "taken@example.com" },
        { email: "new2@example.com" },
      ],
      { ordered: false },
    );
  } catch (err) {
    error = err;
  }

  // The models read err.result.insertedIds exactly as they do for MongoDB.
  assert.ok(error, "expected a BulkWriteError-shaped error");
  assert.ok(error.result && error.result.insertedIds, "carries partial results");
  assert.strictEqual(Object.keys(error.result.insertedIds).length, 2);
  assert.strictEqual(await col.countDocuments({}), 3);
  await cleanup();
});

writeSuite.test("updateOne returns matchedCount / modifiedCount / upsertedCount", async () => {
  const store = await freshStore();
  const col = store.collection("things");
  await col.insertOne({ a: 1 });
  const r = await col.updateOne({ a: 1 }, { $set: { a: 2 } });
  assert.strictEqual(r.matchedCount, 1);
  assert.strictEqual(r.modifiedCount, 1);
  assert.strictEqual(r.upsertedCount, 0);
  assert.strictEqual(r.upsertedId, null);
  await cleanup();
});

writeSuite.test("$set creates a missing path, $inc accumulates, $unset removes", async () => {
  const store = await freshStore();
  const col = store.collection("things");
  await col.insertOne({ a: 1, n: 5, drop: "x" });

  await col.updateOne({ a: 1 }, { $set: { "deep.nested": true } });
  await col.updateOne({ a: 1 }, { $inc: { n: 3 } });
  await col.updateOne({ a: 1 }, { $unset: { drop: "" } });

  const doc = await col.findOne({ a: 1 });
  assert.strictEqual(doc.deep.nested, true);
  assert.strictEqual(doc.n, 8);
  assert.ok(!("drop" in doc));
  await cleanup();
});

writeSuite.test("$inc treats a missing field as zero", async () => {
  const store = await freshStore();
  const col = store.collection("things");
  await col.insertOne({ a: 1 });
  await col.updateOne({ a: 1 }, { $inc: { tokenVersion: 1 } });
  assert.strictEqual((await col.findOne({ a: 1 })).tokenVersion, 1);
  await cleanup();
});

writeSuite.test("a no-op update reports modifiedCount 0", async () => {
  const store = await freshStore();
  const col = store.collection("things");
  await col.insertOne({ a: 1, b: 2 });
  const r = await col.updateOne({ a: 1 }, { $set: { b: 2 } });
  assert.strictEqual(r.matchedCount, 1);
  assert.strictEqual(r.modifiedCount, 0);
  await cleanup();
});

writeSuite.test("an update that would break a unique index is rejected", async () => {
  const store = await freshStore({ things: [{ keys: ["email"], unique: true }] });
  const col = store.collection("things");
  await col.insertOne({ _id: "a", email: "a@example.com" });
  await col.insertOne({ _id: "b", email: "b@example.com" });
  await assert.rejects(
    () => col.updateOne({ _id: "b" }, { $set: { email: "a@example.com" } }),
    (err) => err.code === DUPLICATE_KEY_CODE,
  );
  await cleanup();
});

writeSuite.test("updateMany touches every match; deleteMany removes every match", async () => {
  const store = await freshStore();
  const col = store.collection("things");
  for (let i = 0; i < 5; i += 1) await col.insertOne({ g: i % 2, n: i });
  assert.strictEqual((await col.updateMany({ g: 0 }, { $set: { hit: true } })).modifiedCount, 3);
  assert.strictEqual((await col.deleteMany({ g: 1 })).deletedCount, 2);
  assert.strictEqual(await col.countDocuments({}), 3);
  await cleanup();
});

writeSuite.test("deleteOne removes at most a single match", async () => {
  const store = await freshStore();
  const col = store.collection("things");
  for (let i = 0; i < 3; i += 1) await col.insertOne({ g: 0 });
  assert.strictEqual((await col.deleteOne({ g: 0 })).deletedCount, 1);
  assert.strictEqual(await col.countDocuments({}), 2);
  await cleanup();
});

writeSuite.test("bulkWrite applies a list of updateOne operations", async () => {
  const store = await freshStore();
  const col = store.collection("things");
  await col.insertOne({ _id: "a", v: 0 });
  await col.insertOne({ _id: "b", v: 0 });
  const r = await col.bulkWrite([
    { updateOne: { filter: { _id: "a" }, update: { $set: { v: 1 } } } },
    { updateOne: { filter: { _id: "b" }, update: { $set: { v: 1 } } } },
  ]);
  assert.strictEqual(r.modifiedCount, 2);
  await cleanup();
});

writeSuite.test("distinct de-duplicates and ignores absent fields", async () => {
  const store = await freshStore();
  const col = store.collection("things");
  await col.insertOne({ a: 1 });
  await col.insertOne({ a: 1 });
  await col.insertOne({ a: 2 });
  await col.insertOne({ b: 3 });
  assert.deepStrictEqual((await col.distinct("a")).sort(), [1, 2]);
  await cleanup();
});

// ===========================================================================
// Reads
// ===========================================================================

const readSuite = new Suite("JSON store · reads");

readSuite.test("find applies sort, skip and limit together", async () => {
  const store = await freshStore();
  const col = store.collection("things");
  for (let i = 1; i <= 6; i += 1) await col.insertOne({ n: i });
  const page = await col.find({}, { sort: { n: -1 }, skip: 1, limit: 2 });
  assert.deepStrictEqual(page.map((d) => d.n), [5, 4]);
  await cleanup();
});

readSuite.test("sorting by a missing field places it first, as Mongo does", async () => {
  const store = await freshStore();
  const col = store.collection("things");
  await col.insertOne({ n: 2, at: new Date("2026-01-01") });
  await col.insertOne({ n: 1 });
  const asc = await col.find({}, { sort: { at: 1 } });
  assert.strictEqual(asc[0].n, 1);
  await cleanup();
});

readSuite.test("sorting is stable for equal keys", async () => {
  const store = await freshStore();
  const col = store.collection("things");
  for (let i = 0; i < 5; i += 1) await col.insertOne({ g: 0, n: i });
  const rows = await col.find({ g: 0 }, { sort: { g: 1 } });
  assert.deepStrictEqual(rows.map((d) => d.n), [0, 1, 2, 3, 4]);
  await cleanup();
});

readSuite.test("an inclusive projection still returns _id", async () => {
  const store = await freshStore();
  const col = store.collection("things");
  const { insertedId } = await col.insertOne({ a: 1, b: 2 });
  const doc = await col.findOne({ _id: insertedId }, { projection: { a: 1 } });
  assert.deepStrictEqual(doc, { _id: insertedId, a: 1 });
  await cleanup();
});

readSuite.test("read results are copies, not live references", async () => {
  // Otherwise a caller could mutate the store behind its back.
  const store = await freshStore();
  const col = store.collection("things");
  await col.insertOne({ a: 1, nested: { b: 2 } });
  const doc = await col.findOne({});
  doc.nested.b = 999;
  assert.strictEqual((await col.findOne({})).nested.b, 2);
  await cleanup();
});

readSuite.test("findOne returns null when nothing matches", async () => {
  const store = await freshStore();
  assert.strictEqual(await store.collection("things").findOne({ a: 1 }), null);
  await cleanup();
});

// ===========================================================================
// Durability
// ===========================================================================

const durabilitySuite = new Suite("JSON store · durability");

durabilitySuite.test("data survives a reload of the store from disk", async () => {
  const store = await freshStore();
  await store.collection("things").insertOne({ a: 1, at: new Date("2026-05-05T00:00:00Z") });

  // A brand new store over the same directory is what a server restart does.
  const reloaded = new JsonStore({ dir: tmpDir, writeThrough: true });
  await reloaded.load();
  const doc = await reloaded.collection("things").findOne({ a: 1 });
  assert.ok(doc, "document should have been persisted");
  assert.ok(doc.at instanceof Date, "Date should have survived the round trip");
  await cleanup();
});

durabilitySuite.test("each collection is its own file", async () => {
  const store = await freshStore();
  store.collection("others");
  await store.load();
  await store.collection("things").insertOne({ a: 1 });
  await store.collection("others").insertOne({ b: 2 });
  const files = (await fsp.readdir(tmpDir)).filter((f) => f.endsWith(".json"));
  assert.deepStrictEqual(files.sort(), ["others.json", "things.json"]);
  await cleanup();
});

durabilitySuite.test("concurrent writes are serialised, not interleaved", async () => {
  // Many parallel inserts must all land; this is the property that keeps
  // concurrent API requests from corrupting a file.
  const store = await freshStore();
  const col = store.collection("things");
  await Promise.all(
    Array.from({ length: 60 }, (_, i) => col.insertOne({ n: i })),
  );
  assert.strictEqual(await col.countDocuments({}), 60);
  await cleanup();
});

durabilitySuite.test("a corrupt file fails with a clear message", async () => {
  const store = await freshStore();
  await store.collection("things").insertOne({ a: 1 });
  await fsp.writeFile(path.join(tmpDir, "things.json"), "{ not json", "utf8");

  // Collections are read on demand, exactly as the provider does at boot.
  const broken = new JsonStore({ dir: tmpDir, writeThrough: true });
  broken.collection("things");
  await assert.rejects(
    () => broken.load(),
    (err) => /could not read/.test(err.message) && err.cause !== undefined,
  );
  await cleanup();
});

durabilitySuite.test("a missing file starts as an empty collection", async () => {
  const store = new JsonStore({ dir: path.join(tmpDir, "does-not-exist") });
  await store.load();
  assert.strictEqual(await store.collection("newthing").countDocuments({}), 0);
  await cleanup();
});

// ===========================================================================

async function main() {
  console.log("\n=== JSON store unit tests ===");
  const summary = await runSuites([
    querySuite,
    serialisationSuite,
    writeSuite,
    readSuite,
    durabilitySuite,
  ]);
  console.log(`\n=== ${summary.passed} passed, ${summary.failed} failed, ${summary.total} total ===\n`);
  process.exit(summary.failed ? 1 : 0);
}

main().catch((err) => {
  console.error("JSON store unit tests crashed:", err);
  process.exit(1);
});
