// models/AuditLog.js
// Handles the "audit_log" collection — an append-only action log.
// Every notable action (login, dataset import, taxonomy change, etc.)
// writes one row here. The utils/audit.js helper calls into this model.

const { getDB } = require("../config/db");

const COLLECTION = "audit_log";

class AuditLog {
  static collection() {
    return getDB().collection(COLLECTION);
  }

  // Append one audit entry. Never throws into the caller — the
  // caller (utils/audit.js) swallows any error here.
  static async create(doc) {
    return this.collection().insertOne(doc);
  }

  // List audit entries, newest first. Supports pagination.
  static async find(filter = {}, options = {}) {
    let cursor = this.collection().find(filter).sort({ at: -1 });
    if (options.skip) cursor = cursor.skip(options.skip);
    if (options.limit) cursor = cursor.limit(options.limit);
    return cursor.toArray();
  }

  // Count entries matching a filter (for pagination).
  static async count(filter = {}) {
    return this.collection().countDocuments(filter);
  }

  // Return every distinct `action` value ever logged.
  // Used to populate the action filter dropdown on the audit page.
  static async distinctActions() {
    return this.collection().distinct("action");
  }
}

module.exports = AuditLog;
