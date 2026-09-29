// models/mongo/Comment.js
// MongoDB implementation of the Comment model.
//
// The structure mirrors models/json/Comment.js method-for-method. Anything
// that is *not* about talking to Mongo — DTO shape, filter semantics, patch
// sanitising — is imported from ../shared so the two providers cannot drift.

const storage = require("../../config/storage");
const { objectIds } = require("./oid");
const {
  commentToDTO,
} = require("../shared/dto");
const {
  commentFilter,
  dtoToDocument,
  sanitizePatch,
  COMMENT_REF_FIELDS,
  COMMENT_DOC_REF_FIELDS,
} = require("../shared/filters");
const { DuplicateKeyError, ValidationError } = require("../errors");

const COLLECTION = "comments";

function translateError(err) {
  if (err && err.code === 11000) {
    return new DuplicateKeyError("sourceId");
  }
  return err;
}

class Comment {
  static collection() {
    return storage.getStore().collection(COLLECTION);
  }

  static async findById(id) {
    const oid = objectIds.coerce(id);
    if (!oid) return null;
    const doc = await this.collection().findOne({ _id: oid });
    return commentToDTO(doc);
  }

  static async findOne(domainFilter) {
    const doc = await this.collection().findOne(
      commentFilter(domainFilter, objectIds),
    );
    return commentToDTO(doc);
  }

  static async findMany(domainFilter, options = {}) {
    const mongoFilter = commentFilter(domainFilter, objectIds);
    const page = Math.max(1, options.page || 1);
    const hardMax = options.internal === true ? 1_000_000 : 200;
    const limit = Math.min(hardMax, Math.max(1, options.limit || 50));
    const skip = (page - 1) * limit;
    const sortBy = options.sortBy || "createdAt";
    const sortDir = options.sortDir === "asc" ? 1 : -1;

    const [total, docs] = await Promise.all([
      this.collection().countDocuments(mongoFilter),
      this.collection()
        .find(mongoFilter)
        .sort({ [sortBy]: sortDir })
        .skip(skip)
        .limit(limit)
        .toArray(),
    ]);

    return {
      comments: docs.map(commentToDTO),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  static async count(domainFilter) {
    return this.collection().countDocuments(commentFilter(domainFilter, objectIds));
  }

  static async countByStatus(datasetId) {
    const oid = objectIds.coerce(datasetId);
    if (!oid) return { total: 0, pending: 0, annotated: 0 };

    const [total, pending, annotated] = await Promise.all([
      this.collection().countDocuments({ datasetId: oid }),
      this.collection().countDocuments({ datasetId: oid, status: "pending" }),
      this.collection().countDocuments({ datasetId: oid, status: "annotated" }),
    ]);

    return { total, pending, annotated };
  }

  /**
   * Comments completed per annotator within a window — one round trip for the
   * whole team, mirroring MediaAnnotation.groupByUser.
   *
   * Counts on `annotatedAt`, not `updatedAt`: a comment that was assigned,
   * reopened and re-annotated is work the person did, and keying on updatedAt
   * would also credit them for edits that were not their finishing.
   *
   * Sorted by userId so both strategies agree row-for-row.
   */
  static async groupByAnnotatedBy(from, to) {
    const match = {};
    if (from || to) {
      match.annotatedAt = {};
      if (from) match.annotatedAt.$gte = from;
      if (to) match.annotatedAt.$lte = to;
    }
    const rows = await this.collection()
      .aggregate([
        { $match: match },
        { $group: { _id: "$annotatedBy", count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ])
      .toArray();
    return rows
      .filter((r) => r._id)
      .map((r) => ({ userId: r._id.toString(), count: r.count }));
  }

  static async groupByField(datasetId, field) {
    const match = {};
    if (datasetId) {
      const oid = objectIds.coerce(datasetId);
      if (!oid) return [];
      match.datasetId = oid;
    }

    const rows = await this.collection()
      .aggregate([
        { $match: match },
        { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      ])
      .toArray();

    return rows.map((r) => ({
      label: r._id === null ? null : String(r._id),
      count: r.count,
    }));
  }

  static async lengthHistogram(datasetId, boundaries) {
    const oid = objectIds.coerce(datasetId);
    if (!oid) return [];

    const rows = await this.collection()
      .aggregate([
        { $match: { datasetId: oid } },
        {
          $project: {
            len: { $strLenCP: { $ifNull: ["$commentText", ""] } },
          },
        },
        {
          $bucket: {
            groupBy: "$len",
            boundaries,
            default: "overflow",
            output: { count: { $sum: 1 } },
          },
        },
      ])
      .toArray();

    return rows.map((r) => {
      if (r._id === "overflow") {
        return {
          label: `${boundaries[boundaries.length - 1]}+`,
          count: r.count,
        };
      }
      const start = r._id;
      const idx = boundaries.indexOf(start);
      const end = boundaries[idx + 1] - 1;
      return { label: `${start}–${end}`, count: r.count };
    });
  }

  static async findTextsForDuplicates(datasetId, limit = 2000) {
    const oid = objectIds.coerce(datasetId);
    if (!oid) return [];
    const docs = await this.collection()
      .find({ datasetId: oid }, { projection: { commentText: 1 } })
      .limit(limit)
      .toArray();
    return docs.map((d) => d.commentText || "");
  }

  static async findForExport(domainFilter) {
    const docs = await this.collection()
      .find(commentFilter(domainFilter, objectIds))
      .sort({ createdAt: 1 })
      .toArray();
    return docs.map(commentToDTO);
  }

  static async findManyByIds(ids) {
    const objectIdsIn = (ids || []).map((v) => objectIds.coerce(v)).filter(Boolean);
    if (!objectIdsIn.length) return [];
    const docs = await this.collection()
      .find({ _id: { $in: objectIdsIn } })
      .toArray();
    return docs.map(commentToDTO);
  }

  static async create(dto) {
    if (!dto.datasetId || !dto.sourceId) {
      throw new ValidationError("datasetId and sourceId are required");
    }
    const doc = dtoToDocument(dto, objectIds, COMMENT_DOC_REF_FIELDS);
    try {
      const r = await this.collection().insertOne(doc);
      return { id: r.insertedId.toString() };
    } catch (err) {
      throw translateError(err);
    }
  }

  static async updateById(id, patch) {
    const oid = objectIds.coerce(id);
    if (!oid) return { matchedCount: 0, modifiedCount: 0 };
    const set = {
      ...sanitizePatch(patch, objectIds, COMMENT_REF_FIELDS),
      updatedAt: new Date(),
    };
    const r = await this.collection().updateOne({ _id: oid }, { $set: set });
    return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  static async updateMany(domainFilter, patch) {
    const set = {
      ...sanitizePatch(patch, objectIds, COMMENT_REF_FIELDS),
      updatedAt: new Date(),
    };
    const r = await this.collection().updateMany(
      commentFilter(domainFilter, objectIds),
      { $set: set },
    );
    return { modifiedCount: r.modifiedCount };
  }

  static async bulkUpdate(patches) {
    if (!patches || !patches.length) return { modifiedCount: 0 };
    const ops = patches.map(({ id, patch }) => {
      const set = {
        ...sanitizePatch(patch, objectIds, COMMENT_REF_FIELDS),
        updatedAt: new Date(),
      };
      return {
        updateOne: {
          filter: { _id: objectIds.coerce(id) },
          update: { $set: set },
        },
      };
    });
    const r = await this.collection().bulkWrite(ops);
    return { modifiedCount: r.modifiedCount };
  }

  static async insertMany(dtos) {
    if (!dtos || !dtos.length) return [];

    const docs = dtos.map((dto) => dtoToDocument(dto, objectIds, COMMENT_DOC_REF_FIELDS));
    const indices = dtos.map((_, i) => i);

    let insertedIds;
    try {
      const result = await this.collection().insertMany(docs, { ordered: false });
      insertedIds = result.insertedIds || {};
    } catch (err) {
      insertedIds =
        (err && err.result && err.result.insertedIds) ||
        (err && err.insertedIds) ||
        (err && err.writeErrors && err.writeErrors.insertedIds) ||
        {};
    }

    const out = [];
    for (const [localIdx, oid] of Object.entries(insertedIds)) {
      const idx = Number(localIdx);
      if (!Number.isInteger(idx)) continue;
      out.push({ id: oid.toString(), index: indices[idx] });
    }
    return out;
  }

  static async deleteById(id) {
    const oid = objectIds.coerce(id);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteOne({ _id: oid });
    return { deletedCount: r.deletedCount };
  }

  static async deleteMany(domainFilter) {
    const r = await this.collection().deleteMany(
      commentFilter(domainFilter, objectIds),
    );
    return { deletedCount: r.deletedCount };
  }

  static async rawInsertMany(docs) {
    if (!docs.length) return [];
    const r = await this.collection().insertMany(docs);
    return Object.values(r.insertedIds).map((oid) => ({ id: oid.toString() }));
  }
}

module.exports = Comment;
