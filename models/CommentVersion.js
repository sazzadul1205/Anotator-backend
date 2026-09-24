// models/CommentVersion.js
// Immutable audit trail of comment state changes.
// Every create / update / annotate / restore appends one row here.

const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");

const COLLECTION = "comment_versions";

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
    commentId: idStr(doc.commentId),
    version: doc.version,
    snapshot: doc.snapshot,
    changedFields: doc.changedFields || [],
    changeType: doc.changeType,
    restoredFrom: doc.restoredFrom ?? null,
    changedBy: idStr(doc.changedBy),
    createdAt: doc.createdAt,
  };
}

function dtoToDoc(dto) {
  const doc = { ...dto };
  delete doc.id;
  if ("commentId" in doc) doc.commentId = toOid(doc.commentId);
  if ("changedBy" in doc) doc.changedBy = toOid(doc.changedBy);
  return doc;
}

class CommentVersion {
  static collection() {
    return getDB().collection(COLLECTION);
  }

  /** Append one version record. Returns { id }. */
  static async create(dto) {
    const r = await this.collection().insertOne(dtoToDoc(dto));
    return { id: r.insertedId.toString() };
  }

  /** Append many version records. Returns [{ id }]. */
  static async insertMany(dtos) {
    if (!dtos || !dtos.length) return [];
    const docs = dtos.map(dtoToDoc);
    const r = await this.collection().insertMany(docs);
    return Object.values(r.insertedIds).map((oid) => ({ id: oid.toString() }));
  }

  /**
   * List versions for one comment, newest first.
   * Options: { skip, limit }.
   */
  static async findByCommentId(commentId, options = {}) {
    const oid = toOid(commentId);
    if (!oid) return [];
    let cursor = this.collection()
      .find({ commentId: oid })
      .sort({ version: -1 });
    if (options.skip) cursor = cursor.skip(options.skip);
    if (options.limit) cursor = cursor.limit(options.limit);
    const docs = await cursor.toArray();
    return docs.map(toDTO);
  }

  /** Count versions for one comment. */
  static async countByCommentId(commentId) {
    const oid = toOid(commentId);
    if (!oid) return 0;
    return this.collection().countDocuments({ commentId: oid });
  }

  /** Find one specific version for one comment. */
  static async findOne({ commentId, version }) {
    const oid = toOid(commentId);
    if (!oid) return null;
    const doc = await this.collection().findOne({ commentId: oid, version });
    return toDTO(doc);
  }

  /** Delete all versions for a single comment. */
  static async deleteByCommentId(commentId) {
    const oid = toOid(commentId);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteMany({ commentId: oid });
    return { deletedCount: r.deletedCount };
  }

  /** Delete all versions for a set of comments. */
  static async deleteByCommentIds(commentIds) {
    if (!commentIds || !commentIds.length) return { deletedCount: 0 };
    const oids = commentIds.map(toOid).filter(Boolean);
    if (!oids.length) return { deletedCount: 0 };
    const r = await this.collection().deleteMany({
      commentId: { $in: oids },
    });
    return { deletedCount: r.deletedCount };
  }

  /**
   * Global per-day activity since a date.
   * Returns [{ date: "YYYY-MM-DD", count }] sorted ascending.
   */
  static async activityByDate(since) {
    const rows = await this.collection()
      .aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();
    return rows.map((r) => ({ date: r._id, count: r.count }));
  }

  /**
   * Per-day activity scoped to one dataset.
   * Uses $lookup because versions don't carry datasetId.
   * Returns [{ date: "YYYY-MM-DD", count }] sorted ascending.
   */
  static async activityByDateForDataset(datasetId) {
    const oid = toOid(datasetId);
    if (!oid) return [];
    const rows = await this.collection()
      .aggregate([
        {
          $lookup: {
            from: "comments",
            localField: "commentId",
            foreignField: "_id",
            as: "c",
          },
        },
        { $unwind: "$c" },
        { $match: { "c.datasetId": oid } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();
    return rows.map((r) => ({ date: r._id, count: r.count }));
  }

  /**
   * Find all versions for a set of comment ids.
   * Used by dataset duplication to copy history.
   * Returns raw Mongo docs so the caller can clone + re-key them.
   */
  static async findRawByCommentIds(commentIds) {
    if (!commentIds || !commentIds.length) return [];
    const oids = commentIds.map(toOid).filter(Boolean);
    return this.collection()
      .find({ commentId: { $in: oids } })
      .toArray();
  }

  /** Insert raw pre-shaped version documents (used by duplication). */
  static async rawInsertMany(docs) {
    if (!docs.length) return [];
    const r = await this.collection().insertMany(docs);
    return Object.values(r.insertedIds).map((oid) => ({ id: oid.toString() }));
  }
}

module.exports = CommentVersion;
