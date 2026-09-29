// tests/unit/contract.test.js
// Unit tests for the bulwark itself.
//
//   node tests/unit/contract.test.js
//
// The parity suite proves the two strategies agree on behaviour. This suite
// proves the guard rail around them: that the declared contract is real, that
// both strategies satisfy it, and that a provider which drifts is caught
// loudly instead of failing in production.

"use strict";

const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const { Suite, runSuites, expect } = require(
  path.join(ROOT, "tests", "helpers", "harness"),
);

const {
  CONTRACT,
  MODEL_NAMES,
  findGaps,
  verifyContract,
} = require(path.join(ROOT, "models", "contract"));
const { stringIds } = require(path.join(ROOT, "models", "shared", "ids"));
const { objectIds } = require(path.join(ROOT, "models", "mongo", "oid"));
const {
  commentFilter,
  datasetFilter,
  userFilter,
  auditLogFilter,
  sanitizePatch,
  normalizeEmail,
} = require(path.join(ROOT, "models", "shared", "filters"));
const {
  commentToDTO,
  userToDTO,
  datasetToDTO,
  taxonomyToDTO,
  commentVersionToDTO,
  auditLogToDTO,
} = require(path.join(ROOT, "models", "shared", "dto"));
const { dateKey, bucketByBoundaries } = require(
  path.join(ROOT, "models", "shared", "aggregate"),
);

// ===========================================================================

const contractSuite = new Suite("contract · declared surface");

contractSuite.test("all seven models are declared", () => {
  expect.deep(MODEL_NAMES.slice().sort(), [
    "AuditLog",
    "Comment",
    "CommentVersion",
    "Dataset",
    "SystemLock",
    "Taxonomy",
    "User",
  ]);
});

contractSuite.test("every declared method is a plain, non-empty name", () => {
  for (const [model, methods] of Object.entries(CONTRACT)) {
    for (const method of methods) {
      expect.ok(
        typeof method === "string" && /^[a-zA-Z][a-zA-Z0-9]*$/.test(method),
        `${model}.${method} is not a valid method name`,
      );
    }
  }
});

contractSuite.test("the Mongo strategy satisfies the contract", () => {
  const models = require(path.join(ROOT, "models", "mongo"));
  expect.deep(findGaps(models), []);
});

contractSuite.test("the document strategy satisfies the contract", () => {
  // json, sqlite and mysql all select this one strategy.
  const models = require(path.join(ROOT, "models", "document"));
  expect.deep(findGaps(models), []);
});

contractSuite.test("the two strategies expose the same method names", () => {
  // Stronger than "both satisfy the list": a method on one and not the other
  // is exactly the drift this layer exists to prevent.
  const mongo = require(path.join(ROOT, "models", "mongo"));
  const json = require(path.join(ROOT, "models", "document"));
  for (const model of MODEL_NAMES) {
    const mongoMethods = Object.getOwnPropertyNames(mongo[model])
      .filter((n) => typeof mongo[model][n] === "function" && n !== "constructor")
      .sort();
    const jsonMethods = Object.getOwnPropertyNames(json[model])
      .filter((n) => typeof json[model][n] === "function" && n !== "constructor")
      .sort();
    expect.deep(jsonMethods, mongoMethods, `${model} differs between strategies`);
  }
});

contractSuite.test("a missing method is reported by name, not swallowed", () => {
  const broken = { Comment: { findById() {} } };
  const gaps = findGaps(broken);
  expect.ok(gaps.some((g) => g === "Comment.findOne: missing"));
  expect.ok(gaps.some((g) => g.startsWith("User: model missing")));
});

contractSuite.test("a whole missing model is reported", () => {
  expect.ok(findGaps({}).some((g) => g.includes("Dataset: model missing")));
});

contractSuite.test("verifyContract throws with the gaps listed", () => {
  let error = null;
  try {
    verifyContract({ Comment: {} });
  } catch (err) {
    error = err;
  }
  expect.ok(error, "should throw on a contract violation");
  expect.ok(error.gaps.length > 0);
  expect.ok(error.message.includes("Comment.findById"));
});

contractSuite.test("verifyContract can report without throwing", () => {
  const gaps = verifyContract({ Comment: {} }, { throwOnGap: false });
  expect.ok(Array.isArray(gaps) && gaps.length > 0);
});

// ===========================================================================

const sharedSuite = new Suite("shared layer · provider independence");

sharedSuite.test("both id adapters turn the same input into a usable id", () => {
  const hex = "507f1f77bcf86cd799439011";
  expect.equal(stringIds.coerce(hex), hex);
  expect.equal(objectIds.coerce(hex).toString(), hex);
  // Both reject nonsense, which is what turns a bad id into a 404, not a 500.
  expect.equal(stringIds.coerce("nope"), "nope"); // strings are permissive...
  expect.equal(objectIds.coerce("nope"), null); // ...ObjectIds are strict
  expect.equal(stringIds.coerce(null), null);
  expect.equal(objectIds.coerce(""), null);
});

sharedSuite.test("the same domain filter builds an equivalent query for each adapter", () => {
  const domain = { datasetId: "507f1f77bcf86cd799439011", status: "pending" };
  const asMongo = commentFilter(domain, objectIds);
  const asString = commentFilter(domain, stringIds);

  expect.equal(asMongo.status, asString.status);
  // Same field targeted; only the id representation differs.
  expect.ok("datasetId" in asMongo && "datasetId" in asString);
  expect.equal(asMongo.datasetId.toString(), asString.datasetId);
});

sharedSuite.test("datasetIds scoping behaves the same on both adapters", () => {
  const a = "507f1f77bcf86cd799439011";
  const b = "507f191e810c19729de860ea";

  const permissive = commentFilter({ datasetIds: [a, b] }, stringIds);
  expect.deep(permissive.datasetId, { $in: [a, b] });

  // A datasetId outside the allowed list narrows to "match nothing".
  const blocked = commentFilter({ datasetIds: [a], datasetId: b }, stringIds);
  expect.deep(blocked.datasetId, { $in: [] });
});

sharedSuite.test("an unassigned filter is a null match, on both adapters", () => {
  expect.equal(commentFilter({ assignedTo: null }, stringIds).assignedTo, null);
  expect.equal(commentFilter({ assignedTo: null }, objectIds).assignedTo, null);
});

sharedSuite.test("search is escaped and length-capped", () => {
  const filter = commentFilter({ search: "a.b*c(d)" }, stringIds);
  expect.equal(filter.commentText.$regex, "a\\.b\\*c\\(d\\)");
  expect.equal(filter.commentText.$options, "i");
  // A regex bomb is truncated, not executed.
  const long = commentFilter({ search: "x".repeat(500) }, stringIds);
  expect.equal(long.commentText.$regex.length, 100);
});

sharedSuite.test("status wins over excludeAnnotated (preserved quirk)", () => {
  const filter = commentFilter({ status: "pending", excludeAnnotated: true }, stringIds);
  expect.equal(filter.status, "pending");
});

sharedSuite.test("patches cannot rewrite identity and coerce references", () => {
  const patch = sanitizePatch(
    { id: "hack", _id: "hack", assignedTo: "507f1f77bcf86cd799439011", sentiment: "positive" },
    stringIds,
    ["assignedTo"],
  );
  expect.ok(!("id" in patch));
  expect.ok(!("_id" in patch));
  expect.equal(patch.assignedTo, "507f1f77bcf86cd799439011");
  expect.equal(patch.sentiment, "positive");
});

sharedSuite.test("an empty reference becomes null, not an empty string", () => {
  const patch = sanitizePatch({ assignedTo: "" }, stringIds, ["assignedTo"]);
  expect.equal(patch.assignedTo, null);
});

sharedSuite.test("emails are lower-cased and trimmed everywhere", () => {
  expect.equal(normalizeEmail("  ADMIN@Example.COM "), "admin@example.com");
  expect.equal(userFilter({ email: " A@B.COM " }).email, "a@b.com");
});

sharedSuite.test("dataset and audit filters mirror across adapters", () => {
  const domain = { status: "completed", assignedTo: "507f1f77bcf86cd799439011" };
  const asMongo = datasetFilter(domain, objectIds);
  const asString = datasetFilter(domain, stringIds);
  expect.equal(asMongo.status, asString.status);
  expect.equal(asMongo.assignedTo.toString(), asString.assignedTo);

  const auditDomain = { action: "user.create", from: "2026-01-01", to: "2026-02-01" };
  const auditMongo = auditLogFilter(auditDomain, objectIds);
  const auditString = auditLogFilter(auditDomain, stringIds);
  expect.equal(auditMongo.action, auditString.action);
  expect.equal(auditMongo.at.$gte.getTime(), auditString.at.$gte.getTime());
});

// ===========================================================================

const dtoSuite = new Suite("shared layer · DTO mapping");

dtoSuite.test("ids become strings and never leak a driver type", () => {
  const oid = objectIds.coerce("507f1f77bcf86cd799439011");
  const fromMongo = commentToDTO({
    _id: oid,
    datasetId: oid,
    assignedTo: null,
    annotatedBy: oid,
  });
  expect.equal(typeof fromMongo.id, "string");
  expect.equal(typeof fromMongo.datasetId, "string");
  expect.equal(fromMongo.assignedTo, null);
  expect.equal(typeof fromMongo.annotatedBy, "string");
});

dtoSuite.test("the same document maps identically whichever provider stored it", () => {
  const oid = objectIds.coerce("507f1f77bcf86cd799439011");
  const hex = oid.toString();
  const base = {
    sourceId: "r1",
    commentText: "hi",
    sentiment: "positive",
    type: "bangla",
    status: "pending",
    version: 1,
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
  const fromMongo = commentToDTO({ ...base, _id: oid, datasetId: oid });
  const fromJson = commentToDTO({ ...base, _id: hex, datasetId: hex });
  expect.deep(fromJson, fromMongo);
});

dtoSuite.test("missing optional values get stable defaults", () => {
  const user = userToDTO({ _id: "u1", email: "a@b.c" });
  expect.equal(user.name, undefined);
  expect.equal(user.tokenVersion, 0, "tokenVersion defaults to 0");

  const dataset = datasetToDTO({ _id: "d1" });
  expect.equal(dataset.importErrors.length, 0);
  expect.equal(dataset.renamedRows, 0);
  expect.equal(dataset.dedupeStrategy, "skip");
  expect.equal(dataset.progress, null);
});

dtoSuite.test("the password hash is opt-in", () => {
  const doc = { _id: "u1", email: "a@b.c", password: "hash" };
  expect.ok(!("password" in userToDTO(doc)));
  expect.equal(userToDTO(doc, { includePassword: true }).password, "hash");
});

dtoSuite.test("a null document maps to null", () => {
  expect.equal(commentToDTO(null), null);
  expect.equal(userToDTO(null), null);
  expect.equal(datasetToDTO(null), null);
});

dtoSuite.test("every DTO carries the _id alias the client reads", () => {
  // The React client keys and links on `_id` everywhere. If a DTO ever
  // ships without it, every list in the UI silently loses its keys.
  const doc = { _id: "507f1f77bcf86cd799439011" };
  for (const [name, dto] of [
    ["comment", commentToDTO(doc)],
    ["user", userToDTO(doc)],
    ["dataset", datasetToDTO(doc)],
    ["taxonomy", taxonomyToDTO(doc)],
    ["commentVersion", commentVersionToDTO(doc)],
    ["auditLog", auditLogToDTO(doc)],
  ]) {
    expect.equal(dto._id, dto.id, `${name} DTO is missing the _id alias`);
  }
});

dtoSuite.test("the _id alias is null-safe, not the string 'null'", () => {
  expect.equal(userToDTO({ _id: null })._id, null);
});

// ===========================================================================

const aggregateSuite = new Suite("shared layer · aggregation helpers");

aggregateSuite.test("dateKey produces the same string as $dateToString", () => {
  expect.equal(dateKey(new Date("2026-07-14T13:45:59.123Z")), "2026-07-14");
  // Grouping is by UTC day, as Mongo's default is.
  expect.equal(dateKey(new Date("2026-07-14T23:59:59.999Z")), "2026-07-14");
});

aggregateSuite.test("bucketing emits only non-empty buckets, in boundary order", () => {
  const rows = [{ n: 3 }, { n: 3 }, { n: 12 }, { n: 250 }];
  const out = bucketByBoundaries(rows, (r) => r.n, [0, 10, 50, 100]);
  expect.deep(out, [
    { label: "0–9", count: 2 },
    { label: "10–49", count: 1 },
    { label: "100+", count: 1 },
  ]);
});

aggregateSuite.test("a bucket boundary is inclusive at the bottom, exclusive at the top", () => {
  const rows = [{ n: 10 }, { n: 49 }];
  const out = bucketByBoundaries(rows, (r) => r.n, [0, 10, 50]);
  expect.deep(out, [{ label: "10–49", count: 2 }]);
});

aggregateSuite.test("an all-empty result is an empty array, not a list of zeroes", () => {
  // The models always pass boundaries starting at 0; nothing falls below.
  expect.deep(bucketByBoundaries([{ n: 500 }], (r) => r.n, [0, 100, 200]), [
    { label: "200+", count: 1 },
  ]);
  expect.deep(bucketByBoundaries([], (r) => r.n, [0, 100, 200]), []);
});

aggregateSuite.test("a value below the first boundary lands in overflow, as $bucket does", () => {
  // Mirrors MongoDB: anything outside [first, last) goes to `default`.
  // Unreachable in practice, but it pins the behaviour to MongoDB's.
  expect.deep(bucketByBoundaries([{ n: 1 }], (r) => r.n, [100, 200]), [
    { label: "200+", count: 1 },
  ]);
});

// ===========================================================================

async function main() {
  console.log("\n=== Model contract & shared layer unit tests ===");
  const summary = await runSuites([
    contractSuite,
    sharedSuite,
    dtoSuite,
    aggregateSuite,
  ]);
  console.log(`\n=== ${summary.passed} passed, ${summary.failed} failed, ${summary.total} total ===\n`);
  process.exit(summary.failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Contract unit tests crashed:", err);
  process.exit(1);
});
