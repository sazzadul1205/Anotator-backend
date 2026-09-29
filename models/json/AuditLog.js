// models/json/AuditLog.js
// JSON-provider implementation of the AuditLog model — append-only action log.

const storage = require("../../config/storage");
const { stringIds } = require("../shared/ids");
const { auditLogToDTO } = require("../shared/dto");
const { auditLogFilter } = require("../shared/filters");

const COLLECTION = "audit_log";

class AuditLog {
  static collection() {
    return storage.getStore().collection(COLLECTION);
  }

  static async create(dto) {
    const doc = {
      action: dto.action,
      actorId: dto.actorId ? stringIds.coerce(dto.actorId) : null,
      actorEmail: dto.actorEmail || null,
      actorRole: dto.actorRole || null,
      targetType: dto.targetType || null,
      targetId: dto.targetId ? stringIds.coerce(dto.targetId) : null,
      metadata: dto.metadata || {},
      at: dto.at || new Date(),
    };
    return this.collection().insertOne(doc);
  }

  static async findMany(domainFilter = {}, options = {}) {
    const filter = auditLogFilter(domainFilter, stringIds);
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(200, Math.max(1, options.limit || 50));
    const skip = (page - 1) * limit;

    const [total, docs] = await Promise.all([
      this.collection().countDocuments(filter),
      this.collection().find(filter, { sort: { at: -1 }, skip, limit }),
    ]);

    return { entries: docs.map(auditLogToDTO), total };
  }

  static async count(domainFilter = {}) {
    return this.collection().countDocuments(auditLogFilter(domainFilter, stringIds));
  }

  static async distinctActions() {
    return this.collection().distinct("action");
  }
}

module.exports = AuditLog;
