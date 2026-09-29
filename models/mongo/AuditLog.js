// models/mongo/AuditLog.js
// MongoDB implementation of the AuditLog model — append-only action log.

const storage = require("../../config/storage");
const { objectIds } = require("./oid");
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
      actorId: dto.actorId ? objectIds.coerce(dto.actorId) : null,
      actorEmail: dto.actorEmail || null,
      actorRole: dto.actorRole || null,
      targetType: dto.targetType || null,
      targetId: dto.targetId ? objectIds.coerce(dto.targetId) : null,
      metadata: dto.metadata || {},
      at: dto.at || new Date(),
    };
    return this.collection().insertOne(doc);
  }

  static async findMany(domainFilter = {}, options = {}) {
    const mongoFilter = auditLogFilter(domainFilter, objectIds);
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(200, Math.max(1, options.limit || 50));
    const skip = (page - 1) * limit;

    const [total, docs] = await Promise.all([
      this.collection().countDocuments(mongoFilter),
      this.collection()
        .find(mongoFilter)
        .sort({ at: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
    ]);

    return { entries: docs.map(auditLogToDTO), total };
  }

  static async count(domainFilter = {}) {
    return this.collection().countDocuments(auditLogFilter(domainFilter, objectIds));
  }

  static async distinctActions() {
    return this.collection().distinct("action");
  }
}

module.exports = AuditLog;
