// config/storage/sql/store.js
// The "Db" handle handed to the models, backed by a real SQL connection.
//
// Implements the MongoDB collection API the models were written against, so
// SQLite and MySQL need no model code of their own:
//
//   findOne, find, countDocuments, distinct,
//   insertOne, insertMany, updateOne, updateMany, bulkWrite,
//   deleteOne, deleteMany
//
// The driver is expected to expose four primitives, which both the built-in
// node:sqlite wrapper and mysql2 provide:
//
//   exec(sql, params)  -> { changes }
//   all(sql, params)   -> rows[]
//   get(sql, params)   -> row | undefined
//   close()
//
// See config/storage/sql/translate.js for the document/row conversion and
// config/storage/sql/dialect.js for the SQLite/MySQL differences.

const { COLLECTIONS } = require("../schema");
const { getDialect } = require("./dialect");
const {
  QueryTranslator,
  docToRow,
  rowToDoc,
  applyUpdate,
  EXTRA_COLUMN,
} = require("./translate");

/** Wraps a unique-constraint failure in the shape the models expect. */
function duplicateKeyError(err, detail) {
  const wrapped = new Error(
    err && err.message
      ? err.message
      : `Duplicate key violates unique constraint (${detail})`,
  );
  wrapped.code = 11000;
  wrapped.keyPattern = detail;
  return wrapped;
}

class SqlCollection {
  constructor(store, name) {
    this.store = store;
    this.name = name;
    this.dialect = store.dialect;
    this.columns = COLLECTIONS[name].columns;
    this.table = this.dialect.quote(name);
    this.q = new QueryTranslator(this.columns, this.dialect);
  }

  // --- internals -----------------------------------------------------------

  _cols() {
    return Object.keys(this.columns);
  }

  _selectSql(where, { sort, skip, limit, projection } = {}) {
    const parts = [`SELECT * FROM ${this.table}`];
    const params = [];

    if (where && where.sql) {
      parts.push(`WHERE ${where.sql}`);
      params.push(...where.params);
    }

    if (sort) {
      const orders = [];
      for (const [field, dir] of Object.entries(sort)) {
        // A sort on a field the document does not have (Taxonomy sorts by
        // kind/order/label, which live inside the `sentiment` array) is a
        // no-op in Mongo because every row ties. Skipping it keeps the same
        // ordering here without inventing a column for it.
        if (!this.q.has(field)) continue;
        const direction = Number(dir) === -1 ? "DESC" : "ASC";
        orders.push(`${this.q.col(field)} ${direction}`);
      }
      if (orders.length) parts.push(`ORDER BY ${orders.join(", ")}`);
    }

    if (limit !== undefined && limit !== null) {
      parts.push("LIMIT ?");
      params.push(Number(limit));
      if (skip) {
        parts.push("OFFSET ?");
        params.push(Number(skip));
      }
    } else if (skip) {
      // SQLite needs a LIMIT before OFFSET; -1 means "no limit".
      parts.push("LIMIT -1 OFFSET ?");
      params.push(Number(skip));
    }

    void projection;
    return { sql: parts.join(" "), params };
  }

  _applyProjection(doc, projection) {
    if (!projection || typeof projection !== "object") return doc;
    const entries = Object.entries(projection);
    if (!entries.length) return doc;

    const include = entries.filter(([, v]) => v === 1 || v === true);
    const exclude = entries.filter(([, v]) => v === 0 || v === false);

    if (!include.length) {
      // Exclusion projection (not used by the models, but cheap to honour).
      const out = { ...doc };
      for (const [key] of exclude) {
        if (key === "_id") continue;
        delete out[key];
      }
      return out;
    }

    const out = {};
    // Mongo keeps _id unless it is explicitly excluded.
    if (!exclude.some(([key]) => key === "_id")) out._id = doc._id;
    for (const [key] of include) {
      if (key === "_id") continue;
      if (doc[key] !== undefined) out[key] = doc[key];
    }
    return out;
  }

  async _matchingRows(filter, { multi = true, sort, skip, limit } = {}) {
    const where = this.q.build(filter);
    const { sql, params } = this._selectSql(where, {
      sort,
      skip,
      limit: multi ? limit : 1,
    });
    return this.store.all(sql, params);
  }

  // --- reads ---------------------------------------------------------------

  async findOne(filter = {}, options = {}) {
    const rows = await this._matchingRows(filter, { multi: false, ...options });
    if (!rows.length) return null;
    return this._applyProjection(rowToDoc(rows[0], this.columns), options.projection);
  }

  async find(filter = {}, options = {}) {
    const rows = await this._matchingRows(filter, {
      multi: true,
      sort: options.sort,
      skip: options.skip,
      limit: options.limit,
    });
    return rows.map((row) =>
      this._applyProjection(rowToDoc(row, this.columns), options.projection),
    );
  }

  async countDocuments(filter = {}) {
    const where = this.q.build(filter);
    const row = await this.store.get(
      `SELECT COUNT(*) AS n FROM ${this.table} WHERE ${where.sql}`,
      where.params,
    );
    return Number(row ? row.n : 0);
  }

  async distinct(field) {
    if (!this.q.has(field)) {
      throw new Error(
        `Cannot run distinct() on undeclared field "${field}" for a SQL provider.`,
      );
    }
    const rows = await this.store.all(
      `SELECT DISTINCT ${this.q.col(field)} AS v FROM ${this.table} ` +
        `WHERE ${this.q.col(field)} IS NOT NULL`,
    );
    const seen = new Set();
    const out = [];
    for (const { v } of rows) {
      const key = v instanceof Date ? v.getTime() : v;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(v);
    }
    return out;
  }

  /** Escape hatch for aggregate-style helpers, matching the JSON store. */
  all() {
    return this.find({});
  }

  // --- writes --------------------------------------------------------------

  async insertOne(doc) {
    const { row, id } = docToRow(doc, this.columns);
    try {
      await this.store.insert(this.table, this._cols(), row);
    } catch (err) {
      if (this.dialect.isUniqueViolation(err)) {
        throw duplicateKeyError(err, this._uniqueDetail(doc));
      }
      throw err;
    }
    return { acknowledged: true, insertedId: id };
  }

  _uniqueDetail(doc) {
    for (const index of COLLECTIONS[this.name].indexes) {
      if (!index.unique) continue;
      if (index.keys.every((key) => doc[key] !== undefined && doc[key] !== null)) {
        return index.keys.join("+");
      }
    }
    return this.name;
  }

  /**
   * Mirrors the Mongo driver's `ordered: false` behaviour: every document is
   * attempted, successes are collected, and a BulkWriteError-shaped error is
   * thrown if at least one failed. Callers such as Comment.insertMany read
   * `err.result.insertedIds` to keep partial success.
   */
  async insertMany(docs, { ordered = true } = {}) {
    const insertedIds = {};
    const writeErrors = [];
    const prepared = [];

    docs.forEach((doc, index) => {
      let entry;
      try {
        entry = docToRow(doc, this.columns);
      } catch (err) {
        writeErrors.push({ index, errmsg: err.message, err });
        return;
      }
      prepared.push({ ...entry, index });
      insertedIds[index] = entry.id;
    });

    if (writeErrors.length && ordered) {
      const err = writeErrors[0].err;
      err.result = { insertedIds: {} };
      throw err;
    }

    for (const { row, id, index } of prepared) {
      try {
        await this.store.insert(this.table, this._cols(), row);
      } catch (err) {
        if (this.dialect.isUniqueViolation(err)) {
          const wrapped = duplicateKeyError(err, this._uniqueDetail(row));
          writeErrors.push({ index, errmsg: wrapped.message, err: wrapped });
          delete insertedIds[index];
          continue;
        }
        throw err;
      }
      void id;
    }

    if (writeErrors.length) {
      const err = new Error(
        `SQL store: ${writeErrors.length} document(s) failed to insert into ${this.name}`,
      );
      err.name = "BulkWriteError";
      err.result = { insertedIds };
      err.writeErrors = writeErrors;
      err.code = 11000;
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

  /**
   * Rows are read, mutated in JavaScript, and written back only when the value
   * actually differs. That is what makes `modifiedCount` mean the same thing
   * here as in Mongo, where a no-op update reports 0.
   */
  async _update(filter, update, { multi = false, upsert = false } = {}) {
    const rows = await this._matchingRows(filter, { multi });

    let modifiedCount = 0;
    for (const row of rows) {
      const doc = rowToDoc(row, this.columns);
      if (!applyUpdate(doc, update)) continue;
      await this._writeDoc(doc);
      modifiedCount += 1;
    }

    let upsertedId = null;
    if (!rows.length && upsert) {
      const doc = {};
      for (const [key, value] of Object.entries(filter || {})) {
        if (key.startsWith("$") || isPlainObjectFilter(value)) continue;
        doc[key] = value;
      }
      applyUpdate(doc, update);
      const { id } = await this.insertOne(doc);
      upsertedId = id;
    }

    return {
      acknowledged: true,
      matchedCount: rows.length,
      modifiedCount: modifiedCount + (upsertedId ? 1 : 0),
      upsertedCount: upsertedId ? 1 : 0,
      upsertedId,
    };
  }

  async _writeDoc(doc) {
    const { row } = docToRow(doc, this.columns);
    // `extra` carries fields the schema does not declare, so it must be
    // written too — otherwise an undeclared field would be dropped by an
    // update even though insertMany kept it.
    const written = [...this._cols(), EXTRA_COLUMN].filter(
      (name) => name !== "id",
    );
    const assignments = written
      .map((name) => `${this.dialect.quote(name)} = ?`)
      .join(", ");
    const params = written.map((name) => row[name]);

    try {
      await this.store.exec(
        `UPDATE ${this.table} SET ${assignments} WHERE ${this.dialect.quote("id")} = ?`,
        [...params, row.id],
      );
    } catch (err) {
      if (this.dialect.isUniqueViolation(err)) {
        throw duplicateKeyError(err, this._uniqueDetail(doc));
      }
      throw err;
    }
  }

  /** Accepts `{ updateOne: { filter, update } }` operations, like Mongo. */
  async bulkWrite(ops) {
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
        const r = await this.deleteMany(op.deleteOne.filter, { multi: false });
        matchedCount += r.deletedCount;
      }
    }
    return { acknowledged: true, matchedCount, modifiedCount };
  }

  async deleteOne(filter) {
    return this.deleteMany(filter, { multi: false });
  }

  async deleteMany(filter = {}, { multi = true } = {}) {
    const where = this.q.build(filter);

    if (!multi) {
      // In single mode only the FIRST match may go. `DELETE ... LIMIT` is a
      // MySQL extension and SQLite rejects it, so the id is selected first and
      // the row deleted by primary key.
      const row = await this.store.get(
        `SELECT ${this.dialect.quote("id")} AS id FROM ${this.table} WHERE ${where.sql} LIMIT 1`,
        where.params,
      );
      if (!row) return { acknowledged: true, deletedCount: 0 };
      const res = await this.store.exec(
        `DELETE FROM ${this.table} WHERE ${this.dialect.quote("id")} = ?`,
        [row.id],
      );
      return { acknowledged: true, deletedCount: Number(res && res.changes) || 0 };
    }

    const res = await this.store.exec(
      `DELETE FROM ${this.table} WHERE ${where.sql}`,
      where.params,
    );
    return {
      acknowledged: true,
      deletedCount: Number(res && res.changes ? res.changes : 0),
    };
  }
}

function isPlainObjectFilter(value) {
  return value !== null && typeof value === "object" && !(value instanceof Date);
}

// ---------------------------------------------------------------------------

class SqlStore {
  /**
   * @param driver  exec/all/get/insert/close, as described at the top of the file
   * @param dialect "sqlite" | "mysql"
   */
  constructor({ driver, dialect: dialectName }) {
    this.driver = driver;
    this.dialect = getDialect(dialectName);
    this.collections = new Map();
    for (const name of Object.keys(COLLECTIONS)) this.collection(name);
  }

  collection(name) {
    if (!this.collections.has(name)) {
      this.collections.set(name, new SqlCollection(this, name));
    }
    return this.collections.get(name);
  }

  async exec(sql, params = []) {
    return this.driver.exec(sql, params);
  }

  async all(sql, params = []) {
    return this.driver.all(sql, params);
  }

  async get(sql, params = []) {
    return this.driver.get(sql, params);
  }

  async insert(table, columns, row) {
    return this.driver.insert(table, columns, row);
  }

  async close() {
    if (this.driver && this.driver.close) await this.driver.close();
  }
}

module.exports = { SqlStore, SqlCollection, EXTRA_COLUMN };
