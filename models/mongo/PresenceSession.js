// models/mongo/PresenceSession.js
// MongoDB implementation of the presence-session model.
//
// Method-for-method identical to models/document/PresenceSession.js. The only
// difference is the id type (ObjectId vs string) — the reads and writes are
// expressed once, in shared/presenceFilters.js and shared/dto.js.

const storage = require("../../config/storage");
const { objectIds } = require("./oid");
const { presenceSessionToDTO } = require("../shared/dto");
const { presenceSessionFilter } = require("../shared/presenceFilters");
const { DuplicateKeyError, ValidationError } = require("../errors");

const COLLECTION = "presence_sessions";

class PresenceSession {
  static collection() {
    return storage.getStore().collection(COLLECTION);
  }

  // --- Reads ---------------------------------------------------------------

  /** The natural key. Presence is keyed per tab, not per user. */
  static async findByKey(userId, sessionKey) {
    const uid = objectIds.coerce(userId);
    const key = String(sessionKey || "");
    if (!uid || !key) return null;
    return presenceSessionToDTO(
      await this.collection().findOne({ userId: uid, sessionKey: key }),
    );
  }

  static async findById(id) {
    const oid = objectIds.coerce(id);
    if (!oid) return null;
    return presenceSessionToDTO(await this.collection().findOne({ _id: oid }));
  }

  static async findMany(domain = {}, options = {}) {
    const filter = presenceSessionFilter(domain, objectIds);
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(500, Math.max(1, options.limit || 200));
    const skip = (page - 1) * limit;
    const sort = options.sortBy
      ? { [options.sortBy]: options.sortDir || -1 }
      : { lastSeenAt: -1 };

    const [total, docs] = await Promise.all([
      this.collection().countDocuments(filter),
      this.collection().find(filter).sort(sort).skip(skip).limit(limit).toArray(),
    ]);

    return { sessions: docs.map(presenceSessionToDTO), total };
  }

  // --- Writes --------------------------------------------------------------

  static async create(dto) {
    if (!dto.userId) throw new ValidationError("userId is required");
    if (!dto.sessionKey) throw new ValidationError("sessionKey is required");

    const now = new Date();
    const doc = {
      userId: objectIds.coerce(dto.userId),
      sessionKey: String(dto.sessionKey),
      lastState: dto.lastState || "active",
      startedAt: now,
      lastSeenAt: now,
      lastActiveAt: dto.lastState === "active" ? now : null,
      activeMs: 0,
      idleMs: 0,
      heartbeats: 1,
      activeByDate: {},
      lastAction: null,
      lastActionAt: null,
      lastTargetType: null,
      lastTargetId: null,
      userAgent: dto.userAgent || null,
      ip: dto.ip || null,
      createdAt: now,
      updatedAt: now,
    };

    try {
      const r = await this.collection().insertOne(doc);
      return { id: r.insertedId.toString() };
    } catch (err) {
      // (userId, sessionKey) is unique. Two heartbeats racing on a fresh tab
      // collide here, and the loser should re-read and update instead.
      if (err && err.code === 11000) throw new DuplicateKeyError("sessionKey");
      throw err;
    }
  }

  static async updateById(id, patch) {
    const oid = objectIds.coerce(id);
    if (!oid) return { matchedCount: 0, modifiedCount: 0 };

    const set = { ...patch, updatedAt: new Date() };
    delete set.id;
    delete set._id;
    // Same normalisation the document strategy applies, so a service that
    // passes a raw reference gets the same stored value on every provider.
    if (set.userId) set.userId = objectIds.coerce(set.userId);
    if (set.lastTargetId) set.lastTargetId = objectIds.coerce(set.lastTargetId);

    const r = await this.collection().updateOne({ _id: oid }, { $set: set });
    return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  /** Closes out sessions nobody has checked in with for longer than `cutoff`. */
  static async deleteOlderThan(cutoff) {
    const r = await this.collection().deleteMany({ lastSeenAt: { $lt: cutoff } });
    return { deletedCount: r.deletedCount };
  }

  /** Cascade: a deleted user must not leave live-looking sessions behind. */
  static async deleteByUser(userId) {
    const uid = objectIds.coerce(userId);
    if (!uid) return { deletedCount: 0 };
    const r = await this.collection().deleteMany({ userId: uid });
    return { deletedCount: r.deletedCount };
  }
}

module.exports = PresenceSession;
