// models/json/CommentVersion.js
// JSON-provider implementation of the CommentVersion model — the immutable
// history trail appended on every comment mutation.

const storage = require("../../config/storage");
const { stringIds } = require("../shared/ids");
const { commentVersionToDTO } = require("../shared/dto");
const { dtoToDocument } = require("../shared/filters");
const { dateKey } = require("../shared/aggregate");

const COLLECTION = "comment_versions";
const REF_FIELDS = ["commentId", "changedBy"];

class CommentVersion {
  static collection() {
    return storage.getStore().collection(COLLECTION);
  }

  static async create(dto) {
    const r = await this.collection().insertOne(
      dtoToDocument(dto, stringIds, REF_FIELDS),
    );
    return { id: r.insertedId };
  }

  static async insertMany(dtos) {
    if (!dtos || !dtos.length) return [];
    const docs = dtos.map((dto) => dtoToDocument(dto, stringIds, REF_FIELDS));
    const r = await this.collection().insertMany(docs);
    return Object.values(r.insertedIds).map((newId) => ({ id: newId }));
  }

  static async findByCommentId(commentId, options = {}) {
    const oid = stringIds.coerce(commentId);
    if (!oid) return [];
    const docs = await this.collection().find(
      { commentId: oid },
      {
        sort: { version: -1 },
        skip: options.skip || 0,
        limit: options.limit || undefined,
      },
    );
    return docs.map(commentVersionToDTO);
  }

  static async countByCommentId(commentId) {
    const oid = stringIds.coerce(commentId);
    if (!oid) return 0;
    return this.collection().countDocuments({ commentId: oid });
  }

  static async findOne({ commentId, version }) {
    const oid = stringIds.coerce(commentId);
    if (!oid) return null;
    const doc = await this.collection().findOne({ commentId: oid, version });
    return commentVersionToDTO(doc);
  }

  static async deleteByCommentId(commentId) {
    const oid = stringIds.coerce(commentId);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteMany({ commentId: oid });
    return { deletedCount: r.deletedCount };
  }

  static async deleteByCommentIds(commentIds) {
    if (!commentIds || !commentIds.length) return { deletedCount: 0 };
    const oids = commentIds.map((v) => stringIds.coerce(v)).filter(Boolean);
    if (!oids.length) return { deletedCount: 0 };
    const r = await this.collection().deleteMany({ commentId: { $in: oids } });
    return { deletedCount: r.deletedCount };
  }

  static async activityByDate(since) {
    const rows = await this.collection().find({ createdAt: { $gte: since } });
    return tallyByDate(rows);
  }

  static async activityByDateForDataset(datasetId) {
    const oid = stringIds.coerce(datasetId);
    if (!oid) return [];

    // Mongo resolves this with $lookup into comments; the join is a plain
    // map here because versions carry no datasetId of their own.
    const comments = new Map(
      (await storage.getStore().collection("comments").find({})).map((c) => [
        c._id,
        c,
      ]),
    );
    const rows = (await this.collection().find({})).filter((version) => {
      const comment = comments.get(version.commentId);
      return comment && stringIds.toString(comment.datasetId) === oid;
    });
    return tallyByDate(rows);
  }

  static async findRawByCommentIds(commentIds) {
    if (!commentIds || !commentIds.length) return [];
    const oids = commentIds.map((v) => stringIds.coerce(v)).filter(Boolean);
    return this.collection().find({ commentId: { $in: oids } });
  }

  static async rawInsertMany(docs) {
    if (!docs.length) return [];
    const r = await this.collection().insertMany(docs);
    return Object.values(r.insertedIds).map((newId) => ({ id: newId }));
  }
}

/** Groups rows into [{ date, count }], ascending — the $dateToString + $group pair. */
function tallyByDate(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = dateKey(row.createdAt);
    if (key === null) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, count]) => ({ date, count }));
}

module.exports = CommentVersion;
