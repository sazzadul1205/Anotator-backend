// models/mongo/CommentVersion.js
// MongoDB implementation of the CommentVersion model — the immutable history
// trail appended on every comment mutation.

const storage = require("../../config/storage");
const { objectIds } = require("./oid");
const { commentVersionToDTO } = require("../shared/dto");
const { dtoToDocument } = require("../shared/filters");

const COLLECTION = "comment_versions";
const REF_FIELDS = ["commentId", "changedBy"];

class CommentVersion {
  static collection() {
    return storage.getStore().collection(COLLECTION);
  }

  static async create(dto) {
    const r = await this.collection().insertOne(
      dtoToDocument(dto, objectIds, REF_FIELDS),
    );
    return { id: r.insertedId.toString() };
  }

  static async insertMany(dtos) {
    if (!dtos || !dtos.length) return [];
    const docs = dtos.map((dto) => dtoToDocument(dto, objectIds, REF_FIELDS));
    const r = await this.collection().insertMany(docs);
    return Object.values(r.insertedIds).map((oid) => ({ id: oid.toString() }));
  }

  static async findByCommentId(commentId, options = {}) {
    const oid = objectIds.coerce(commentId);
    if (!oid) return [];
    let cursor = this.collection()
      .find({ commentId: oid })
      .sort({ version: -1 });
    if (options.skip) cursor = cursor.skip(options.skip);
    if (options.limit) cursor = cursor.limit(options.limit);
    const docs = await cursor.toArray();
    return docs.map(commentVersionToDTO);
  }

  static async countByCommentId(commentId) {
    const oid = objectIds.coerce(commentId);
    if (!oid) return 0;
    return this.collection().countDocuments({ commentId: oid });
  }

  static async findOne({ commentId, version }) {
    const oid = objectIds.coerce(commentId);
    if (!oid) return null;
    const doc = await this.collection().findOne({ commentId: oid, version });
    return commentVersionToDTO(doc);
  }

  static async deleteByCommentId(commentId) {
    const oid = objectIds.coerce(commentId);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteMany({ commentId: oid });
    return { deletedCount: r.deletedCount };
  }

  static async deleteByCommentIds(commentIds) {
    if (!commentIds || !commentIds.length) return { deletedCount: 0 };
    const oids = commentIds.map((v) => objectIds.coerce(v)).filter(Boolean);
    if (!oids.length) return { deletedCount: 0 };
    const r = await this.collection().deleteMany({ commentId: { $in: oids } });
    return { deletedCount: r.deletedCount };
  }

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

  static async activityByDateForDataset(datasetId) {
    const oid = objectIds.coerce(datasetId);
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

  static async findRawByCommentIds(commentIds) {
    if (!commentIds || !commentIds.length) return [];
    const oids = commentIds.map((v) => objectIds.coerce(v)).filter(Boolean);
    return this.collection().find({ commentId: { $in: oids } }).toArray();
  }

  static async rawInsertMany(docs) {
    if (!docs.length) return [];
    const r = await this.collection().insertMany(docs);
    return Object.values(r.insertedIds).map((oid) => ({ id: oid.toString() }));
  }
}

module.exports = CommentVersion;
