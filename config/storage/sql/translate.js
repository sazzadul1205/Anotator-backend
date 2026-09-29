// config/storage/sql/translate.js
// Document <-> row conversion, filter translation, and update application.
//
// Pure functions with no database connection, so they can be unit-tested on
// their own. config/storage/sql/store.js drives them against a real connection.
//
// Representation
// --------------
// One document is one row. `_id` is the `id` primary key. Each declared field
// from config/storage/schema.js becomes a typed column. Fields the schema does
// not declare are kept in a per-row `extra` JSON column, so an undeclared
// field is stored-but-not-queryable rather than silently dropped.
//
// Representation
// --------------
// One document is one row. `_id` is the `id` primary key. Each declared field
// from config/storage/schema.js becomes a typed column. Fields the schema does
// not declare are kept in a per-row `extra` JSON column, so an undeclared
// field is stored-but-not-queryable rather than silently dropped.
//
// Semantics that are deliberately Mongo-shaped, because models depend on them:
//   * `{ field: null }` matches NULL (and, as in Mongo, an absent field)
//   * `$in: []` matches nothing
//   * `$ne` / `$nin` also match rows where the field is absent
//   * `modifiedCount` counts rows whose value actually changed, so a no-op
//     update reports 0 — SQLite and MySQL disagree on this natively, so the
//     change is detected here rather than trusted from the driver
//   * a unique-constraint violation surfaces as `err.code === 11000`, which is
//     what the models' `translateError` maps to DuplicateKeyError

const { newId } = require("../../../models/shared/ids");
const { columnForKey, EXTRA_COLUMN } = require("./dialect");

// ---------------------------------------------------------------------------
// Value encoding
// ---------------------------------------------------------------------------

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !(value instanceof Date)
  );
}

function encodeValue(kind, value) {
  if (value === undefined || value === null) return null;

  switch (kind) {
    case "date":
      if (value instanceof Date) return value.toISOString();
      if (typeof value === "number") return new Date(value).toISOString();
      return String(value);
    case "bool":
      return value ? 1 : 0;
    case "int": {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    // Bounding-box coordinates. MySQL DECIMAL arrives as a string over the
    // wire and SQLite REAL as a number, so both are funnelled through
    // Number(). A non-finite value becomes null rather than NaN, because NaN
    // compares false against everything in SQL and would make a row silently
    // unfindable.
    case "float": {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case "json":
      return JSON.stringify(value);
    default:
      return typeof value === "string" ? value : String(value);
  }
}

function decodeValue(kind, value) {
  if (value === null || value === undefined) return undefined;

  switch (kind) {
    case "date": {
      const d = new Date(value);
      return Number.isNaN(d.getTime()) ? value : d;
    }
    case "bool":
      return Boolean(Number(value));
    case "int":
      return Number(value);
    // DECIMAL(12,6) comes back as a string from mysql2; REAL as a number from
    // node:sqlite. Normalising here is what makes a box read back as the same
    // JavaScript number on every provider.
    case "float": {
      const n = Number(value);
      return Number.isFinite(n) ? n : undefined;
    }
    case "json":
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    default:
      return typeof value === "string" ? value : String(value);
  }
}

/**
 * `$regex` arrives already escaped for a regex by the caller. LIKE needs its
 * own two wildcards escaped, and reusing `\` as the escape character also turns
 * the regex backslashes into literal characters — so `\.` reads as a literal
 * dot, exactly as the regex intended.
 *
 * Case-insensitivity is the default in both engines (SQLite's LIKE for ASCII,
 * MySQL's utf8mb4_unicode_ci collation), which is what `$options: "i"` asks for.
 */
function likePattern(escapedRegex) {
  return `%${String(escapedRegex).replace(/[%_]/g, "\\$&")}%`;
}

// ---------------------------------------------------------------------------
// Query translation
// ---------------------------------------------------------------------------

class QueryTranslator {
  constructor(columns, dialect) {
    this.columns = columns;
    this.dialect = dialect;
  }

  has(field) {
    return Object.prototype.hasOwnProperty.call(
      this.columns,
      columnForKey(field),
    );
  }

  kindOf(field) {
    return this.columns[columnForKey(field)];
  }

  col(field) {
    return this.dialect.quote(columnForKey(field));
  }

  /** Turns a Mongo-style filter into `{ sql, params }`. */
  build(filter) {
    const params = [];
    const sql = this.clauses(filter, params);
    return { sql: sql || "1=1", params };
  }

  clauses(filter, params) {
    if (!filter || typeof filter !== "object") return "1=1";

    const parts = [];
    for (const [key, condition] of Object.entries(filter)) {
      if (key === "$and" || key === "$or") {
        const subs = (Array.isArray(condition) ? condition : [condition]).map(
          (f) => {
            const built = this.build(f);
            params.push(...built.params);
            return built.sql;
          },
        );
        if (subs.length) parts.push(`(${subs.join(key === "$and" ? " AND " : " OR ")})`);
        continue;
      }
      if (key.startsWith("$")) {
        throw new Error(`Unsupported top-level query operator "${key}"`);
      }
      if (!this.has(key)) {
        // Stored in `extra`, so it has no column to compare against. Fail
        // loudly rather than silently return rows that do not match.
        throw new Error(
          `Cannot filter on undeclared field "${key}" for a SQL provider. ` +
            "Declare it in config/storage/schema.js.",
        );
      }
      const clause = this.condition(key, condition, params);
      if (clause) parts.push(clause);
    }
    return parts.join(" AND ");
  }

  condition(field, condition, params) {
    const col = this.col(field);
    const kind = this.kindOf(field);

    const isOperatorObject =
      isPlainObject(condition) &&
      Object.keys(condition).some((k) => k.startsWith("$"));

    if (!isOperatorObject) {
      if (condition === null) return `${col} IS NULL`;
      params.push(encodeValue(kind, condition));
      return `${col} = ?`;
    }

    // `$regex` and `$options` share one object, so they are read together.
    if ("$regex" in condition) {
      params.push(likePattern(condition.$regex));
      return `${col} LIKE ? ${this.dialect.likeEscape}`;
    }

    const parts = [];
    for (const [op, operand] of Object.entries(condition)) {
      const clause = this.operator(col, kind, op, operand, params);
      if (clause) parts.push(clause);
    }
    return parts.length ? `(${parts.join(" AND ")})` : null;
  }

  operator(col, kind, op, operand, params) {
    switch (op) {
      case "$eq":
        if (operand === null) return `${col} IS NULL`;
        params.push(encodeValue(kind, operand));
        return `${col} = ?`;

      case "$ne":
        // In Mongo, $ne also matches documents where the field is absent.
        params.push(encodeValue(kind, operand));
        return `(${col} <> ? OR ${col} IS NULL)`;

      case "$in": {
        const list = Array.isArray(operand) ? operand : [operand];
        // An empty $in matches nothing. The shared filters rely on this: a
        // filter whose every id was malformed degrades to "match nothing".
        if (!list.length) return "1=0";
        const hasNull = list.some((v) => v === null);
        const values = list.filter((v) => v !== null);
        if (!values.length) return `${col} IS NULL`;
        const marks = values.map(() => "?").join(", ");
        values.forEach((v) => params.push(encodeValue(kind, v)));
        const clause = `${col} IN (${marks})`;
        return hasNull ? `(${clause} OR ${col} IS NULL)` : clause;
      }

      case "$nin": {
        const list = Array.isArray(operand) ? operand : [operand];
        if (!list.length) return "1=1";
        const marks = list.map(() => "?").join(", ");
        list.forEach((v) => params.push(encodeValue(kind, v)));
        return `(${col} NOT IN (${marks}) OR ${col} IS NULL)`;
      }

      case "$lt":
      case "$lte":
      case "$gt":
      case "$gte": {
        const sqlOp = { $lt: "<", $lte: "<=", $gt: ">", $gte: ">=" }[op];
        params.push(encodeValue(kind, operand));
        return `${col} ${sqlOp} ?`;
      }

      case "$exists":
        return operand ? `${col} IS NOT NULL` : `${col} IS NULL`;

      default:
        throw new Error(`Unsupported query operator "${op}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Document <-> row
// ---------------------------------------------------------------------------

function docToRow(doc, columns) {
  const row = {
    id: doc._id === undefined || doc._id === null ? newId() : String(doc._id),
  };
  const extra = {};

  for (const [key, value] of Object.entries(doc)) {
    if (key === "_id") continue;
    if (Object.prototype.hasOwnProperty.call(columns, key)) {
      row[key] = encodeValue(columns[key], value);
    } else {
      extra[key] = value;
    }
  }

  // Undeclared-on-write fields are NULL rather than absent, so the column list
  // is the same for every insert.
  for (const name of Object.keys(columns)) {
    if (name === "id") continue;
    if (!(name in row)) row[name] = null;
  }

  row[EXTRA_COLUMN] = Object.keys(extra).length ? JSON.stringify(extra) : null;
  return { row, id: row.id };
}

function rowToDoc(row, columns) {
  const doc = { _id: row.id };

  for (const [name, kind] of Object.entries(columns)) {
    if (name === "id") continue;
    const decoded = decodeValue(kind, row[name]);
    // A NULL column reads as an absent field, exactly like Mongo.
    if (decoded !== undefined) doc[name] = decoded;
  }

  if (row[EXTRA_COLUMN]) {
    try {
      Object.assign(doc, JSON.parse(row[EXTRA_COLUMN]));
    } catch {
      /* a corrupt extra blob must not take the whole row down */
    }
  }
  return doc;
}

// ---------------------------------------------------------------------------
// Update application, in JS, so modifiedCount matches Mongo exactly
// ---------------------------------------------------------------------------

function getPath(doc, dotted) {
  let cursor = doc;
  for (const part of dotted.split(".")) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[part];
  }
  return cursor;
}

function setPath(doc, dotted, value) {
  const parts = dotted.split(".");
  let cursor = doc;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!isPlainObject(cursor[parts[i]])) cursor[parts[i]] = {};
    cursor = cursor[parts[i]];
  }
  cursor[parts[parts.length - 1]] = value;
}

function unsetPath(doc, dotted) {
  const parts = dotted.split(".");
  let cursor = doc;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (!isPlainObject(cursor[parts[i]])) return;
    cursor = cursor[parts[i]];
  }
  delete cursor[parts[parts.length - 1]];
}

/** Returns true when the document actually changed. */
function applyUpdate(doc, update) {
  let changed = false;
  for (const [op, payload] of Object.entries(update || {})) {
    switch (op) {
      case "$set":
        for (const [key, value] of Object.entries(payload)) {
          if (isSame(getPath(doc, key), value)) continue;
          setPath(doc, key, value);
          changed = true;
        }
        break;
      case "$inc":
        for (const [key, delta] of Object.entries(payload)) {
          const before = getPath(doc, key);
          setPath(
            doc,
            key,
            (typeof before === "number" ? before : 0) + Number(delta),
          );
          changed = true;
        }
        break;
      case "$unset":
        for (const key of Object.keys(payload)) {
          if (getPath(doc, key) === undefined) continue;
          unsetPath(doc, key);
          changed = true;
        }
        break;
      default:
        throw new Error(`Unsupported update operator "${op}"`);
    }
  }
  return changed;
}

function isSame(a, b) {
  if (a instanceof Date || b instanceof Date) {
    const at = a instanceof Date ? a.getTime() : a;
    const bt = b instanceof Date ? b.getTime() : b;
    return at === bt;
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    return JSON.stringify(sortedJson(a)) === JSON.stringify(sortedJson(b));
  }
  return a === b;
}

/** Stable key order, so object comparison does not depend on insertion order. */
function sortedJson(value) {
  if (Array.isArray(value)) return value.map(sortedJson);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortedJson(value[key]);
    return out;
  }
  return value;
}

module.exports = {
  QueryTranslator,
  docToRow,
  rowToDoc,
  applyUpdate,
  likePattern,
  isPlainObject,
  encodeValue,
  decodeValue,
  EXTRA_COLUMN,
};
