// models/AuditLog.js
// Append-only action log.

const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");

const COLLECTION = "audit_log";

function toOid(id) {
  if (!id) return null;
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

function idStr(v) {
  if (v === null) return null;
  return typeof v === "string" ? v : v.toString();
}

function toDTO(doc) {
  if (!doc) return null;
  return {
    id: idStr(doc._id),
    action: doc.action,
    actorId: idStr(doc.actorId),
    actorEmail: doc.actorEmail ?? null,
    actorRole: doc.actorRole ?? null,
    targetType: doc.targetType ?? null,
    targetId: idStr(doc.targetId),
    metadata: doc.metadata || {},
    at: doc.at,
  };
}

function toMongoFilter(domain = {}) {
  const f = {};
  if (domain.action) f.action = domain.action;
  if (domain.actorId) f.actorId = toOid(domain.actorId);
  if (domain.targetType) f.targetType = domain.targetType;
  if (domain.targetId) f.targetId = toOid(domain.targetId);
  if (domain.from || domain.to) {
    f.at = {};
    if (domain.from) f.at.$gte = new Date(domain.from);
    if (domain.to) f.at.$lte = new Date(domain.to);
  }
  return f;
}

class AuditLog {
  static collection() {
    return getDB().collection(COLLECTION);
  }

  /**
   * Append one audit entry.
   * Accepts the shaped payload used by utils/audit.js and normalizes ids.
   */
  static async create(dto) {
    const doc = {
      action: dto.action,
      actorId: dto.actorId ? toOid(dto.actorId) : null,
      actorEmail: dto.actorEmail || null,
      actorRole: dto.actorRole || null,
      targetType: dto.targetType || null,
      targetId: dto.targetId ? toOid(dto.targetId) : null,
      metadata: dto.metadata || {},
      at: dto.at || new Date(),
    };
    return this.collection().insertOne(doc);
  }

  /**
   * List audit entries, newest first, paginated.
   * Returns { entries: DTO[], total }.
   */
  static async findMany(domainFilter = {}, options = {}) {
    const mongoFilter = toMongoFilter(domainFilter);
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

    return { entries: docs.map(toDTO), total };
  }

  static async count(domainFilter = {}) {
    return this.collection().countDocuments(toMongoFilter(domainFilter));
  }

  /** Distinct list of `action` values ever recorded. */
  static async distinctActions() {
    return this.collection().distinct("action");
  }
}

module.exports = AuditLog;
