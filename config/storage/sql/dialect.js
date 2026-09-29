// config/storage/sql/dialect.js
// The differences between SQLite and MySQL, isolated in one file.
//
// Everything above this — the store, the query translator, the providers — is
// written once against a small driver interface:
//
//   exec(sql, params)      -> { changes }
//   all(sql, params)       -> rows[]
//   get(sql, params)       -> row | undefined
//   close()
//
// A dialect supplies the pieces that genuinely differ: placeholder style,
// column type mapping, DDL, identifier quoting, and how a unique-constraint
// violation is recognised so it can be reported as Mongo-shaped code 11000.

/** MySQL needs a database to exist before tables can be created. */
const MYSQL_TYPE = {
  id: "VARCHAR(64)",
  ref: "VARCHAR(64)",
  str: "VARCHAR(255)",
  long: "LONGTEXT",
  int: "BIGINT",
  bool: "TINYINT(1)",
  date: "VARCHAR(32)",
  json: "LONGTEXT",
};

const SQLITE_TYPE = {
  id: "TEXT",
  ref: "TEXT",
  str: "TEXT",
  long: "TEXT",
  int: "INTEGER",
  bool: "INTEGER",
  // ISO-8601 UTC strings sort and compare correctly as text.
  date: "TEXT",
  json: "TEXT",
};

/**
 * Both dialects are declared here; the provider picks one by name. Values that
 * are compared must keep a stable textual form, so dates are ISO strings and
 * booleans are 0/1 integers rather than native types.
 */
const SQLITE = {
  name: "sqlite",
  placeholder: () => "?",

  quote(identifier) {
    return `"${identifier}"`;
  },

  type(kind) {
    return SQLITE_TYPE[kind] || "TEXT";
  },

  /** `CREATE TABLE IF NOT EXISTS` + a `CREATE INDEX` per schema entry. */
  tableDdl(table, columns) {
    const cols = Object.entries(columns)
      .map(([name, kind]) => {
        const primary = kind === "id" ? " PRIMARY KEY" : "";
        return `${this.quote(name)} ${this.type(kind)}${primary}`;
      })
      .concat(`${this.quote(EXTRA_COLUMN)} ${this.type("json")}`);
    return `CREATE TABLE IF NOT EXISTS ${this.quote(table)} (\n    ${cols.join(
      ",\n    ",
    )}\n  )`;
  },

  indexDdl(table, index, name) {
    const cols = index.keys
      .map((key) => this.quote(columnForKey(key)))
      .join(", ");
    const unique = index.unique ? "UNIQUE " : "";
    return `CREATE ${unique}INDEX IF NOT EXISTS ${this.quote(name)} ON ${this.quote(table)} (${cols})`;
  },

  /** SQLite reports a UNIQUE violation with this message. */
  isUniqueViolation(err) {
    return /UNIQUE constraint failed/i.test(String(err && err.message));
  },

  // SQLite has no backslash escaping in string literals, so one backslash
  // reaches the parser as one backslash.
  likeEscape: "ESCAPE '\\'",

  upsertSuffix() {
    return "";
  },
};

const MYSQL = {
  name: "mysql",
  placeholder: () => "?",

  quote(identifier) {
    return `\`${identifier}\``;
  },

  type(kind) {
    return MYSQL_TYPE[kind] || "VARCHAR(255)";
  },

  tableDdl(table, columns) {
    const cols = Object.entries(columns)
      .map(([name, kind]) => {
        const primary = kind === "id" ? " PRIMARY KEY" : "";
        return `${this.quote(name)} ${this.type(kind)}${primary}`;
      })
      .concat(`${this.quote(EXTRA_COLUMN)} ${this.type("json")}`);
    // utf8mb4 so emoji and non-Latin comment text survive; InnoDB for real
    // transactions and row-level locking.
    return (
      `CREATE TABLE IF NOT EXISTS ${this.quote(table)} (\n    ${cols.join(
        ",\n    ",
      )}\n  )` +
      " ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci"
    );
  },

  indexDdl(table, index, name) {
    const cols = index.keys
      .map((key) => this.quote(columnForKey(key)))
      .join(", ");
    const unique = index.unique ? "UNIQUE " : "";
    // MySQL has no CREATE INDEX IF NOT EXISTS; the error is swallowed by the
    // store, which treats "already exists" as success.
    return `CREATE ${unique}INDEX ${this.quote(name)} ON ${this.quote(table)} (${cols})`;
  },

  isUniqueViolation(err) {
    return err && (err.code === "ER_DUP_ENTRY" || err.errno === 1062);
  },

  // MySQL *does* honour backslash escapes inside string literals, so the same
  // single backslash has to be written twice to survive parsing. Without this
  // the ESCAPE clause is an unterminated string.
  likeEscape: "ESCAPE '\\\\'",

  upsertSuffix() {
    return " ON DUPLICATE KEY UPDATE id = id";
  },
};

/** `_id` is the document identity; in SQL it lives in the `id` column. */
function columnForKey(key) {
  return key === "_id" ? "id" : key;
}

/**
 * The reserved column holding fields the schema does not declare. It exists in
 * every table so an undeclared field is stored-but-not-queryable rather than
 * silently dropped.
 */
const EXTRA_COLUMN = "extra";

function getDialect(name) {
  if (name === "sqlite") return SQLITE;
  if (name === "mysql") return MYSQL;
  throw new Error(`Unknown SQL dialect "${name}". Known: sqlite, mysql`);
}

module.exports = { getDialect, columnForKey, EXTRA_COLUMN, SQLITE, MYSQL };
