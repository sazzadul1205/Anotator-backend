// config/storage/sql/mysqlDriver.js
// The mysql2 driver, wrapped in the async interface the store expects.
//
// `mysql2` is required lazily, inside connect(), so the MySQL provider never
// loads the driver — or attempts a network connection — unless it is selected.
// A pool is used so concurrent requests reuse connections instead of opening
// one per query.
//
// Mysql2 returns BIGINT columns as strings to avoid precision loss. The store
// compares them numerically when it needs a count, and the column types in
// config/storage/sql/dialect.js keep every sortable value textual, so this is
// confined to COUNT(*) results.

class MysqlDriver {
  constructor({ pool }) {
    this.pool = pool;
  }

  async exec(sql, params = []) {
    const [result] = await this.pool.execute(sql, params);
    return { changes: result.affectedRows };
  }

  async all(sql, params = []) {
    const [rows] = await this.pool.execute(sql, params);
    return rows;
  }

  async get(sql, params = []) {
    const [rows] = await this.pool.execute(sql, params);
    return rows[0];
  }

  async insert(table, columns, row) {
    const marks = columns.map(() => "?").join(", ");
    const sql =
      `INSERT INTO ${table} (${columns.map((c) => `\`${c}\``).join(", ")}) ` +
      `VALUES (${marks})`;
    const [result] = await this.pool.execute(sql, columns.map((c) => row[c]));
    return { changes: result.affectedRows };
  }

  async close() {
    if (this.pool) await this.pool.end().catch(() => {});
  }
}

/** Normalises mysql2's error shape to the one the store checks. */
module.exports = { MysqlDriver };
