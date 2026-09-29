// models/document/Comment.js
// Document-store implementation of the Comment model.
//
// Method-for-method identical to models/mongo/Comment.js. The aggregation
// methods (groupByField, lengthHistogram) are computed in JavaScript instead
// of with $group / $bucket, but return exactly the same shapes.

const storage = require("../../config/storage");
const { stringIds } = require("../shared/ids");
const { commentToDTO } = require("../shared/dto");
const {
  commentFilter,
  dtoToDocument,
  sanitizePatch,
  COMMENT_REF_FIELDS,
  COMMENT_DOC_REF_FIELDS,
} = require("../shared/filters");
const { bucketByBoundaries, countBy } = require("../shared/aggregate");
const { DuplicateKeyError, ValidationError } = require("../errors");

const COLLECTION = "comments";

/** $strLenCP counts code points, not UTF-16 units. */
function codePointLength(text) {
  return Array.from(String(text || "")).length;
}

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

  // --- Reads ---------------------------------------------------------------

  static async findById(id) {
    const oid = stringIds.coerce(id);
    if (!oid) return null;
    const doc = await this.collection().findOne({ _id: oid });
    return commentToDTO(doc);
  }

  static async findOne(domainFilter) {
    const doc = await this.collection().findOne(
      commentFilter(domainFilter, stringIds),
    );
    return commentToDTO(doc);
  }

  static async findMany(domainFilter, options = {}) {
    const filter = commentFilter(domainFilter, stringIds);
    const page = Math.max(1, options.page || 1);
    const hardMax = options.internal === true ? 1_000_000 : 200;
    const limit = Math.min(hardMax, Math.max(1, options.limit || 50));
    const skip = (page - 1) * limit;
    const sortBy = options.sortBy || "createdAt";
    const sortDir = options.sortDir === "asc" ? 1 : -1;

    const [total, docs] = await Promise.all([
      this.collection().countDocuments(filter),
      this.collection().find(filter, {
        sort: { [sortBy]: sortDir },
        skip,
        limit,
      }),
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
    return this.collection().countDocuments(commentFilter(domainFilter, stringIds));
  }

  static async countByStatus(datasetId) {
    const oid = stringIds.coerce(datasetId);
    if (!oid) return { total: 0, pending: 0, annotated: 0 };

    const [total, pending, annotated] = await Promise.all([
      this.collection().countDocuments({ datasetId: oid }),
      this.collection().countDocuments({ datasetId: oid, status: "pending" }),
      this.collection().countDocuments({ datasetId: oid, status: "annotated" }),
    ]);

    return { total, pending, annotated };
  }

  static async groupByField(datasetId, field) {
    const filter = {};
    if (datasetId) {
      const oid = stringIds.coerce(datasetId);
      if (!oid) return [];
      filter.datasetId = oid;
    }
    const rows = await this.collection().find(filter);
    return [...countBy(rows, (d) => (d[field] === undefined || d[field] === null ? null : String(d[field])))]
      .map(([label, count]) => ({ label, count }));
  }

  static async lengthHistogram(datasetId, boundaries) {
    const oid = stringIds.coerce(datasetId);
    if (!oid) return [];
    const rows = await this.collection().find({ datasetId: oid });
    return bucketByBoundaries(
      rows,
      (d) => codePointLength(d.commentText),
      boundaries,
    );
  }

  static async findTextsForDuplicates(datasetId, limit = 2000) {
    const oid = stringIds.coerce(datasetId);
    if (!oid) return [];
    const docs = await this.collection().find(
      { datasetId: oid },
      { projection: { commentText: 1 }, limit },
    );
    return docs.map((d) => d.commentText || "");
  }

  static async findForExport(domainFilter) {
    const docs = await this.collection().find(commentFilter(domainFilter, stringIds), {
      sort: { createdAt: 1 },
    });
    return docs.map(commentToDTO);
  }

  static async findManyByIds(ids) {
    const keys = (ids || []).map((v) => stringIds.coerce(v)).filter(Boolean);
    if (!keys.length) return [];
    const docs = await this.collection().find({ _id: { $in: keys } });
    return docs.map(commentToDTO);
  }

  // --- Writes --------------------------------------------------------------

  static async create(dto) {
    if (!dto.datasetId || !dto.sourceId) {
      throw new ValidationError("datasetId and sourceId are required");
    }
    const doc = dtoToDocument(dto, stringIds, COMMENT_DOC_REF_FIELDS);
    try {
      const r = await this.collection().insertOne(doc);
      return { id: r.insertedId };
    } catch (err) {
      throw translateError(err);
    }
  }

  static async updateById(id, patch) {
    const oid = stringIds.coerce(id);
    if (!oid) return { matchedCount: 0, modifiedCount: 0 };
    const set = {
      ...sanitizePatch(patch, stringIds, COMMENT_REF_FIELDS),
      updatedAt: new Date(),
    };
    const r = await this.collection().updateOne({ _id: oid }, { $set: set });
    return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  static async updateMany(domainFilter, patch) {
    const set = {
      ...sanitizePatch(patch, stringIds, COMMENT_REF_FIELDS),
      updatedAt: new Date(),
    };
    const r = await this.collection().updateMany(
      commentFilter(domainFilter, stringIds),
      { $set: set },
    );
    return { modifiedCount: r.modifiedCount };
  }

  static async bulkUpdate(patches) {
    if (!patches || !patches.length) return { modifiedCount: 0 };
    const ops = patches.map(({ id, patch }) => {
      const set = {
        ...sanitizePatch(patch, stringIds, COMMENT_REF_FIELDS),
        updatedAt: new Date(),
      };
      return { updateOne: { filter: { _id: stringIds.coerce(id) }, update: { $set: set } } };
    });
    const r = await this.collection().bulkWrite(ops);
    return { modifiedCount: r.modifiedCount };
  }

  static async insertMany(dtos) {
    if (!dtos || !dtos.length) return [];

    const docs = dtos.map((dto) => dtoToDocument(dto, stringIds, COMMENT_DOC_REF_FIELDS));
    const indices = dtos.map((_, i) => i);

    let insertedIds;
    try {
      const result = await this.collection().insertMany(docs, { ordered: false });
      insertedIds = result.insertedIds || {};
    } catch (err) {
      // The JSON store throws a BulkWriteError-shaped error carrying the ids
      // that did get written, exactly like the Mongo driver does.
      insertedIds =
        (err && err.result && err.result.insertedIds) ||
        (err && err.insertedIds) ||
        (err && err.writeErrors && err.writeErrors.insertedIds) ||
        {};
    }

    const out = [];
    for (const [localIdx, newId] of Object.entries(insertedIds)) {
      const idx = Number(localIdx);
      if (!Number.isInteger(idx)) continue;
      out.push({ id: newId, index: indices[idx] });
    }
    return out;
  }

  static async deleteById(id) {
    const oid = stringIds.coerce(id);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteOne({ _id: oid });
    return { deletedCount: r.deletedCount };
  }

  static async deleteMany(domainFilter) {
    const r = await this.collection().deleteMany(
      commentFilter(domainFilter, stringIds),
    );
    return { deletedCount: r.deletedCount };
  }

  static async rawInsertMany(docs) {
    if (!docs.length) return [];
    const r = await this.collection().insertMany(docs);
    return Object.values(r.insertedIds).map((newId) => ({ id: newId }));
  }
}

module.exports = Comment;
