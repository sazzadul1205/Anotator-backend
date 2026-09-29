// config/storage/sql/sqliteDriver.js
// The `node:sqlite` driver, wrapped in the async interface the store expects.
//
// Uses Node's built-in SQLite module, so the SQLite provider needs no
// dependency at all — nothing to install, nothing to compile, nothing to
// audit. Requires Node 22.5+ (Node 24 here).
//
// node:sqlite is synchronous. The wrapper is async so SQLite and MySQL are
// interchangeable to everything above; SQLite is only ever a local file, so the
// blocking cost is contained.

const fsp = require("fs/promises");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

class SqliteDriver {
  constructor({ file, dialect }) {
    this.file = file;
    this.dialect = dialect;
    this.db = new DatabaseSync(file);
    // WAL keeps readers from blocking the writer, and foreign_keys stays off
    // because this schema manages its own references in application code.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  async exec(sql, params = []) {
    const stmt = this.db.prepare(sql);
    const result = stmt.run(...params);
    return { changes: Number(result.changes) };
  }

  async all(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.all(...params);
  }

  async get(sql, params = []) {
    const stmt = this.db.prepare(sql);
    return stmt.get(...params);
  }

  async insert(table, columns, row) {
    const marks = columns.map(() => "?").join(", ");
    const sql =
      `INSERT INTO ${table} (${columns.map((c) => `"${c}"`).join(", ")}) ` +
      `VALUES (${marks})`;
    const result = this.db.prepare(sql).run(...columns.map((c) => row[c]));
    return { changes: Number(result.changes) };
  }

  async close() {
    try {
      this.db.close();
    } catch {
      /* already closed */
    }
  }

  /** Ensure the parent directory exists before the file is created. */
  static async prepareDir(file) {
    await fsp.mkdir(path.dirname(file), { recursive: true });
  }
}

module.exports = { SqliteDriver };
