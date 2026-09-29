// config/storage/jsonStore.js
// A tiny, dependency-free document store that speaks the subset of the
// MongoDB collection API the models actually use.
//
// Why not just "read the whole file and filter in JS" everywhere? Because the
// models hand us real Mongo query/update documents. If the JSON store
// understood those documents, the *only* difference between the two model
// implementations would be aggregation pipelines — which is exactly the
// property that makes the abstraction trustworthy.
//
// Supported surface (deliberately small):
//   findOne, find(sort/skip/limit), countDocuments, distinct,
//   insertOne, insertMany, updateOne, updateMany, bulkWrite,
//   deleteOne, deleteMany
//
// Deliberately NOT supported:
//   aggregate()      — pipelines are provider-specific; the JSON models
//                      compute aggregations in plain JS instead.
//   transactions     — the Mongo implementation does not use them either
//                      (see docs/models.md §7 "No transactions anywhere").
//
// Durability: every mutation is appended to a per-collection write queue and
// flushed with write-to-temp + rename, so a crash can never leave a half
// written file behind.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Value helpers
// ---------------------------------------------------------------------------

/** Mongo's duplicate-key error code, so `translateError` works unchanged. */
const DUPLICATE_KEY_CODE = 11000;

function duplicateKeyError(indexKey, value) {
  const err = new Error(
    `E11000 duplicate key error collection: index: ${indexKey} dup key: { ${indexKey}: ${String(
      value,
    )} }`,
  );
  err.code = DUPLICATE_KEY_CODE;
  err.keyValue = { [indexKey]: value };
  return err;
}

/** 24-char hex id, byte-for-byte compatible with an ObjectId hex string. */
function newId() {
  return crypto.randomBytes(12).toString("hex");
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isDate(v) {
  return v instanceof Date;
}

// ---------------------------------------------------------------------------
// Serialisation — Dates must survive a JSON round-trip
// ---------------------------------------------------------------------------

// Dates are encoded as { "$date": "<iso>" } so a real string that happens to
// look like an ISO timestamp is never silently turned into a Date.

function encode(value) {
  if (isDate(value)) return { $date: value.toISOString() };
  if (Array.isArray(value)) return value.map(encode);
  if (isPlainObject(value)) {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue; // matches Mongo: undefined fields are dropped
      out[k] = encode(v);
    }
    return out;
  }
  return value;
}

function decode(value) {
  if (Array.isArray(value)) return value.map(decode);
  if (isPlainObject(value)) {
    if (typeof value.$date === "string" && Object.keys(value).length === 1) {
      return new Date(value.$date);
    }
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = decode(v);
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Path access — supports dotted paths such as "progress.processed"
// ---------------------------------------------------------------------------

function getPath(doc, pathExpr) {
  if (!pathExpr.includes(".")) {
    return doc === null || doc === undefined ? undefined : doc[pathExpr];
  }
  let cur = doc;
  for (const part of pathExpr.split(".")) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[part];
  }
  return cur;
}

function setPath(doc, pathExpr, value) {
  const parts = pathExpr.split(".");
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!isPlainObject(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

function unsetPath(doc, pathExpr) {
  const parts = pathExpr.split(".");
  let cur = doc;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (!isPlainObject(cur[part])) return;
    cur = cur[part];
  }
  delete cur[parts[parts.length - 1]];
}

// ---------------------------------------------------------------------------
// Comparison — Mongo's BSON type ordering, simplified
// ---------------------------------------------------------------------------

function typeRank(v) {
  if (v === null || v === undefined) return 0;
  if (typeof v === "boolean") return 1;
  if (typeof v === "number") return 2;
  if (typeof v === "string") return 3;
  if (isDate(v)) return 4;
  return 5;
}

function compareValues(a, b) {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra < rb ? -1 : 1;
  if (ra === 0) return 0;
  if (ra === 4) return a.getTime() - b.getTime();
  if (ra === 2 || ra === 1) return a < b ? -1 : a > b ? 1 : 0;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function valuesEqual(a, b) {
  // Mongo treats a missing field as null for equality: the query
  // `{ assignedTo: null }` matches documents where the field is null *and*
  // documents where it was never set. Reproduce that here, otherwise
  // "unassigned" queries silently return nothing.
  const aEmpty = a === null || a === undefined;
  const bEmpty = b === null || b === undefined;
  if (aEmpty || bEmpty) return aEmpty && bEmpty;

  if (a === b) return true;
  if (isDate(a) && isDate(b)) return a.getTime() === b.getTime();
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => valuesEqual(v, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    return ka.every((k) => valuesEqual(a[k], b[k]));
  }
  return false;
}

// ---------------------------------------------------------------------------
// Query matching
// ---------------------------------------------------------------------------

function matchOperator(value, op, operand) {
  switch (op) {
    case "$eq":
      return valuesEqual(value, operand);
    case "$ne":
      return !valuesEqual(value, operand);
    case "$in":
      return (operand || []).some((o) => valuesEqual(value, o));
    case "$nin":
      return !(operand || []).some((o) => valuesEqual(value, o));
    case "$gt":
      return value !== undefined && compareValues(value, operand) > 0;
    case "$gte":
      return value !== undefined && compareValues(value, operand) >= 0;
    case "$lt":
      return value !== undefined && compareValues(value, operand) < 0;
    case "$lte":
      return value !== undefined && compareValues(value, operand) <= 0;
    case "$exists":
      return (value !== undefined) === Boolean(operand);
    case "$regex": {
      const re = operand instanceof RegExp ? operand : new RegExp(operand);
      if (typeof value !== "string") return false;
      return re.test(value);
    }
    case "$options": {
      // Only meaningful alongside $regex; handled by the $regex branch which
      // receives an already-compiled RegExp from the filter compiler.
      return true;
    }
    case "$not":
      return !matchCondition(value, operand);
    default:
      throw new Error(`JSON store: unsupported query operator "${op}"`);
  }
}

function matchCondition(value, condition) {
  if (isPlainObject(condition)) {
    const keys = Object.keys(condition);
    const looksLikeOperator =
      keys.length > 0 && keys.every((k) => k.startsWith("$"));
    if (looksLikeOperator) {
      const re = condition.$regex;
      if (re !== undefined) {
        // Compile $regex + $options into a single RegExp once.
        const flags = condition.$options || "";
        const compiled =
          re instanceof RegExp
            ? new RegExp(re.source, `${re.flags}${flags}`.replace(/g/g, ""))
            : new RegExp(re, flags);
        return (
          typeof value === "string" &&
          compiled.test(value) &&
          keys
            .filter((k) => k !== "$regex" && k !== "$options")
            .every((k) => matchOperator(value, k, condition[k]))
        );
      }
      return keys.every((k) => matchOperator(value, k, condition[k]));
    }
  }
  return valuesEqual(value, condition);
}

/** Returns true when `doc` satisfies the Mongo-style query `filter`. */
function matchesFilter(doc, filter) {
  if (!filter) return true;
  for (const [key, condition] of Object.entries(filter)) {
    if (key === "$or") {
      if (!(condition || []).some((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (key === "$and") {
      if (!(condition || []).every((sub) => matchesFilter(doc, sub))) return false;
      continue;
    }
    if (!matchCondition(getPath(doc, key), condition)) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Sorting & projection
// ---------------------------------------------------------------------------

function normalizeSort(sort) {
  if (!sort) return [];
  const entries = Array.isArray(sort) ? sort : Object.entries(sort);
  return entries
    .map(([field, dir]) => ({
      field,
      dir: typeof dir === "object" && dir !== null ? dir.$direction || 1 : dir,
    }))
    .map(({ field, dir }) => ({ field, dir: dir < 0 ? -1 : 1 }));
}

function sortDocs(docs, sort) {
  const spec = normalizeSort(sort);
  if (!spec.length) return docs;
  // Stable sort keeps insertion order for equal keys, matching Mongo closely
  // enough for our deterministic tests.
  return docs
    .map((doc, index) => ({ doc, index }))
    .sort((a, b) => {
      for (const { field, dir } of spec) {
        const cmp = compareValues(getPath(a.doc, field), getPath(b.doc, field));
        if (cmp !== 0) return cmp * dir;
      }
      return a.index - b.index;
    })
    .map((w) => w.doc);
}

function applyProjection(doc, projection) {
  if (!projection || !isPlainObject(projection)) return doc;
  const includes = Object.entries(projection)
    .filter(([, v]) => v === 1 || v === true)
    .map(([k]) => k);

  if (!includes.length) return doc; // exclusion projection: not needed by our models

  const out = {};
  // _id is included unless the projection explicitly excludes it.
  if (!(projection._id === 0 || projection._id === false)) out._id = doc._id;
  for (const field of includes) {
    if (field === "_id") continue;
    const value = getPath(doc, field);
    if (value !== undefined) setPath(out, field, decode(value));
  }
  return out;
}

function cloneDoc(doc) {
  return decode(encode(doc));
}

// ---------------------------------------------------------------------------
// Update application
// ---------------------------------------------------------------------------

function applyUpdate(doc, update) {
  const before = JSON.stringify(encode(doc));
  for (const [op, payload] of Object.entries(update || {})) {
    switch (op) {
      case "$set":
        for (const [k, v] of Object.entries(payload || {})) setPath(doc, k, v);
        break;
      case "$unset":
        for (const k of Object.keys(payload || {})) unsetPath(doc, k);
        break;
      case "$inc":
        for (const [k, v] of Object.entries(payload || {})) {
          const current = getPath(doc, k);
          setPath(doc, k, (typeof current === "number" ? current : 0) + v);
        }
        break;
      case "$setOnInsert":
        // Only meaningful on upsert; the caller applies the base document
        // first, so a plain $set has the same effect here.
        for (const [k, v] of Object.entries(payload || {})) {
          if (getPath(doc, k) === undefined) setPath(doc, k, v);
        }
        break;
      default:
        throw new Error(`JSON store: unsupported update operator "${op}"`);
    }
  }
  return JSON.stringify(encode(doc)) !== before;
}

// ---------------------------------------------------------------------------
// JsonCollection
// ---------------------------------------------------------------------------

class JsonCollection {
  /**
   * @param {string} name      collection name (e.g. "comments")
   * @param {object} options
   * @param {string} options.dir       directory the JSON file lives in
   * @param {Array<{keys:string[], unique:boolean, name?:string}>} [options.indexes]
   * @param {boolean} [options.writeThrough]
   */
  constructor(name, { dir, indexes = [], writeThrough = true } = {}) {
    this.name = name;
    this.filePath = path.join(dir, `${name}.json`);
    this.indexes = indexes;
    this.writeThrough = writeThrough;
    this.docs = [];
    this.loaded = false;
    this._writeChain = Promise.resolve();
  }

  // --- lifecycle -----------------------------------------------------------

  async load() {
    if (this.loaded) return this;
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await fsp.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const docs = Array.isArray(parsed) ? parsed : parsed?.documents;
      this.docs = Array.isArray(docs) ? docs.map(decode) : [];
    } catch (err) {
      if (err.code === "ENOENT") {
        this.docs = [];
      } else {
        throw new Error(
          `JSON store: could not read ${this.filePath}: ${err.message}`,
          { cause: err },
        );
      }
    }
    this.loaded = true;
    return this;
  }

  async flush() {
    const payload = JSON.stringify(
      { collection: this.name, documents: encode(this.docs) },
      null,
      0,
    );
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
    await fsp.writeFile(tmp, payload, "utf8");
    await fsp.rename(tmp, this.filePath);
  }

  /** Serialises writes so concurrent requests cannot interleave. */
  _persist() {
    this._writeChain = this._writeChain
      .then(() => this.flush())
      .catch((err) => {
        console.error(`❌ JSON store write failed (${this.name}):`, err.message);
      });
    return this._writeChain;
  }

  // --- unique index enforcement -------------------------------------------

  _indexFields(index) {
    return index.keys.length === 1 ? index.keys[0] : JSON.stringify(index.keys);
  }

  _findIndexFor(keys) {
    return this.indexes.find((idx) => keys.every((k) => idx.keys.includes(k)));
  }

  _assertUnique(candidate, { skipId = null } = {}) {
    for (const index of this.indexes) {
      if (!index.unique) continue;
      const values = index.keys.map((k) => getPath(candidate, k));
      // A null/absent value never collides — same rule as a Mongo sparse-ish
      // unique index on a null field (we deliberately do not enforce those).
      if (values.every((v) => v === null || v === undefined)) continue;
      const clash = this.docs.find(
        (d) =>
          d._id !== skipId &&
          index.keys.every((k, i) => valuesEqual(getPath(d, k), values[i])),
      );
      if (clash) {
        throw duplicateKeyError(this._indexFields(index), values[0]);
      }
    }
  }

  // --- reads ---------------------------------------------------------------

  async findOne(filter = {}, options = {}) {
    await this.load();
    const found = this.docs.find((d) => matchesFilter(d, filter));
    return found ? applyProjection(cloneDoc(found), options.projection) : null;
  }

  async find(filter = {}, options = {}) {
    await this.load();
    let rows = this.docs.filter((d) => matchesFilter(d, filter));
    if (options.sort) rows = sortDocs(rows, options.sort);
    const total = rows.length;
    const skip = options.skip || 0;
    const limit =
      options.limit === null || options.limit === undefined
        ? total
        : options.limit;
    rows = rows.slice(skip, skip + limit);
    return rows.map((d) => applyProjection(cloneDoc(d), options.projection));
  }

  async countDocuments(filter = {}) {
    await this.load();
    return this.docs.filter((d) => matchesFilter(d, filter)).length;
  }

  async distinct(field) {
    await this.load();
    const seen = [];
    for (const doc of this.docs) {
      const value = getPath(doc, field);
      if (value === undefined) continue;
      if (!seen.some((v) => valuesEqual(v, value))) seen.push(value);
    }
    return seen;
  }

  // --- writes --------------------------------------------------------------

  async insertOne(doc) {
    await this.load();
    const stored = cloneDoc(doc);
    if (stored._id === undefined || stored._id === null) stored._id = newId();
    else stored._id = String(stored._id);

    this._assertUnique(stored);
    this.docs.push(stored);
    if (this.writeThrough) await this._persist();
    return { acknowledged: true, insertedId: stored._id };
  }

  /**
   * Mirrors the Mongo driver's `ordered: false` behaviour: every document is
   * attempted, failures are collected, and a BulkWriteError-shaped error is
   * thrown *if* at least one failed. Callers that want partial success (see
   * Comment.insertMany) read `err.result.insertedIds`, exactly as they do for
   * MongoDB.
   */
  async insertMany(docs, { ordered = true } = {}) {
    await this.load();
    const insertedIds = {};
    const writeErrors = [];
    const prepared = [];

    docs.forEach((doc, index) => {
      const stored = cloneDoc(doc);
      if (stored._id === undefined || stored._id === null) stored._id = newId();
      else stored._id = String(stored._id);
      try {
        this._assertUnique(stored);
        prepared.push({ index, stored });
        insertedIds[index] = stored._id;
      } catch (err) {
        writeErrors.push({ index, errmsg: err.message, err });
      }
    });

    if (writeErrors.length && ordered) {
      // Mongo aborts on the first failure in ordered mode; so do we, and no
      // rows are written.
      const err = writeErrors[0].err;
      err.result = { insertedIds: {} };
      throw err;
    }

    for (const { stored } of prepared) this.docs.push(stored);
    if (this.writeThrough && prepared.length) await this._persist();

    if (writeErrors.length) {
      const err = new Error(
        `JSON store: ${writeErrors.length} document(s) failed to insert into ${this.name}`,
      );
      err.name = "BulkWriteError";
      err.result = { insertedIds };
      err.writeErrors = writeErrors;
      err.code = writeErrors[0].err.code;
      throw err;
    }

    return {
      acknowledged: true,
      insertedCount: prepared.length,
      insertedIds,
    };
  }

  async updateOne(filter, update, options = {}) {
    return this._update(filter, update, { ...options, multi: false });
  }

  async updateMany(filter, update, options = {}) {
    return this._update(filter, update, { ...options, multi: true });
  }

  async _update(filter, update, { multi = false, upsert = false } = {}) {
    await this.load();
    const matches = this.docs.filter((d) => matchesFilter(d, filter));
    const targets = multi ? matches : matches.slice(0, 1);

    let modifiedCount = 0;
    for (const doc of targets) {
      if (applyUpdate(doc, update)) modifiedCount += 1;
      this._assertUnique(doc, { skipId: doc._id });
    }

    let upsertedId = null;
    if (!targets.length && upsert) {
      const base = { _id: newId() };
      for (const [k, v] of Object.entries(filter)) {
        if (k.startsWith("$") || isPlainObject(v)) continue;
        setPath(base, k, v);
      }
      applyUpdate(base, update);
      this._assertUnique(base);
      this.docs.push(base);
      upsertedId = base._id;
    }

    if (this.writeThrough && (modifiedCount || upsertedId)) await this._persist();

    return {
      acknowledged: true,
      matchedCount: targets.length,
      modifiedCount: modifiedCount + (upsertedId ? 1 : 0),
      upsertedCount: upsertedId ? 1 : 0,
      upsertedId,
    };
  }

  /** Accepts `{ updateOne: { filter, update } }` operations, like Mongo. */
  async bulkWrite(ops) {
    await this.load();
    let matchedCount = 0;
    let modifiedCount = 0;
    for (const op of ops || []) {
      if (op.updateOne) {
        const r = await this._update(op.updateOne.filter, op.updateOne.update, {
          multi: false,
        });
        matchedCount += r.matchedCount;
        modifiedCount += r.modifiedCount;
      } else if (op.deleteOne) {
        const r = await this.deleteMany(op.deleteOne.filter);
        matchedCount += r.deletedCount;
      }
    }
    return { acknowledged: true, matchedCount, modifiedCount };
  }

  async deleteOne(filter) {
    return this.deleteMany(filter, { multi: false });
  }

  async deleteMany(filter = {}, { multi = true } = {}) {
    await this.load();
    // In single mode only the FIRST match may go; the rest must survive.
    const doomed = new Set();
    for (const doc of this.docs) {
      if (!matchesFilter(doc, filter)) continue;
      doomed.add(doc);
      if (!multi) break;
    }
    if (!doomed.size) return { acknowledged: true, deletedCount: 0 };
    this.docs = this.docs.filter((d) => !doomed.has(d));
    if (this.writeThrough) await this._persist();
    return { acknowledged: true, deletedCount: doomed.size };
  }

  /** Escape hatch for the provider's aggregate-style helpers. */
  all() {
    return this.docs.map(cloneDoc);
  }
}

// ---------------------------------------------------------------------------
// JsonStore — the "Db" handle handed to the JSON models
// ---------------------------------------------------------------------------

class JsonStore {
  constructor({ dir, writeThrough = true, indexes = {} } = {}) {
    this.kind = "json";
    this.dir = dir;
    this.writeThrough = writeThrough;
    this.indexSpecs = indexes;
    this.collections = new Map();
  }

  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(
        name,
        new JsonCollection(name, {
          dir: this.dir,
          indexes: this.indexSpecs[name] || [],
          writeThrough: this.writeThrough,
        }),
      );
    }
    return this.collections.get(name);
  }

  async load() {
    for (const collection of this.collections.values()) await collection.load();
    return this;
  }

  async flushAll() {
    for (const collection of this.collections.values()) {
      if (collection.loaded) await collection.flush();
    }
  }

  /** Mirrors `db.command({ ping: 1 })` used by /health. */
  async command() {
    return { ok: 1 };
  }
}

/** Synchronous existence check, used by the provider's readiness report. */
function storageDirExists(dir) {
  return fs.existsSync(dir);
}

module.exports = {
  JsonStore,
  JsonCollection,
  DUPLICATE_KEY_CODE,
  newId,
  storageDirExists,
  // exported for the parity test suite
  _internals: { matchesFilter, sortDocs, encode, decode, compareValues },
};
