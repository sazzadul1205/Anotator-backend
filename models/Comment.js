// models/Comment.js
// Handles the "comments" collection.

const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");
const { DuplicateKeyError, ValidationError } = require("./errors");

const COLLECTION = "comments";

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

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

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toMongoFilter(domain = {}) {
  const f = {};

  // --- fix: support { ids: [...] } ---
  if (Array.isArray(domain.ids)) {
    f._id = { $in: domain.ids.map(toOid).filter(Boolean) };
  }

  if (Array.isArray(domain.datasetIds)) {
    const allowed = domain.datasetIds.map(toOid).filter(Boolean);
    if (domain.datasetId) {
      const oid = toOid(domain.datasetId);
      f.datasetId = allowed.some((a) => a.equals(oid)) ? oid : { $in: [] };
    } else {
      f.datasetId = { $in: allowed };
    }
  } else if (domain.datasetId) {
    const oid = toOid(domain.datasetId);
    if (oid) f.datasetId = oid;
  }

  if (domain.status) {
    f.status = domain.status;
  } else if (domain.excludeAnnotated) {
    f.status = { $ne: "annotated" };
  }

  if (domain.sentiment) f.sentiment = domain.sentiment;
  if (domain.type) f.type = domain.type;

  if (domain.assignedTo !== undefined) {
    f.assignedTo = domain.assignedTo === null ? null : toOid(domain.assignedTo);
  }

  if (domain.search) {
    const trimmed = String(domain.search).trim().slice(0, 100);
    if (trimmed) {
      f.commentText = { $regex: escapeRegex(trimmed), $options: "i" };
    }
  }

  return f;
}

function toDTO(doc) {
  if (!doc) return null;
  return {
    id: idStr(doc._id),
    datasetId: idStr(doc.datasetId),
    sourceId: doc.sourceId,
    commentText: doc.commentText,
    sentiment: doc.sentiment,
    type: doc.type,
    status: doc.status,
    assignedTo: idStr(doc.assignedTo),
    assignedAt: doc.assignedAt || null,
    assignedBy: idStr(doc.assignedBy),
    annotatedBy: idStr(doc.annotatedBy),
    annotatedAt: doc.annotatedAt || null,
    annotationNote: doc.annotationNote ?? null,
    version: doc.version,
    createdBy: idStr(doc.createdBy),
    updatedBy: idStr(doc.updatedBy),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function dtoToDoc(dto) {
  const doc = { ...dto };
  delete doc.id;
  delete doc._oldId; // --- fix: don't persist internal bookkeeping ---
  if ("datasetId" in doc) doc.datasetId = toOid(doc.datasetId);
  if ("assignedTo" in doc)
    doc.assignedTo = doc.assignedTo ? toOid(doc.assignedTo) : null;
  if ("assignedBy" in doc)
    doc.assignedBy = doc.assignedBy ? toOid(doc.assignedBy) : null;
  if ("annotatedBy" in doc)
    doc.annotatedBy = doc.annotatedBy ? toOid(doc.annotatedBy) : null;
  if ("createdBy" in doc)
    doc.createdBy = doc.createdBy ? toOid(doc.createdBy) : null;
  if ("updatedBy" in doc)
    doc.updatedBy = doc.updatedBy ? toOid(doc.updatedBy) : null;
  return doc;
}

function patchToSet(patch) {
  const set = { ...patch };
  delete set.id;
  delete set._id;
  for (const k of ["assignedTo", "assignedBy", "annotatedBy", "updatedBy"]) {
    if (k in set) set[k] = set[k] ? toOid(set[k]) : null;
  }
  return set;
}

function translateError(err) {
  if (err && err.code === 11000) {
    return new DuplicateKeyError("sourceId");
  }
  return err;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

class Comment {
  static collection() {
    return getDB().collection(COLLECTION);
  }

  static async findById(id) {
    const oid = toOid(id);
    if (!oid) return null;
    const doc = await this.collection().findOne({ _id: oid });
    return toDTO(doc);
  }

  static async findOne(domainFilter) {
    const doc = await this.collection().findOne(toMongoFilter(domainFilter));
    return toDTO(doc);
  }

  static async findMany(domainFilter, options = {}) {
    const mongoFilter = toMongoFilter(domainFilter);
    const page = Math.max(1, options.page || 1);
    const limit = Math.min(200, Math.max(1, options.limit || 50));
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
      comments: docs.map(toDTO),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  static async count(domainFilter) {
    return this.collection().countDocuments(toMongoFilter(domainFilter));
  }

  static async countByStatus(datasetId) {
    const oid = toOid(datasetId);
    if (!oid) return { total: 0, pending: 0, annotated: 0 };

    const [total, pending, annotated] = await Promise.all([
      this.collection().countDocuments({ datasetId: oid }),
      this.collection().countDocuments({ datasetId: oid, status: "pending" }),
      this.collection().countDocuments({ datasetId: oid, status: "annotated" }),
    ]);

    return { total, pending, annotated };
  }

  static async groupByField(datasetId, field) {
    const oid = toOid(datasetId);
    if (!oid) return [];

    const rows = await this.collection()
      .aggregate([
        { $match: { datasetId: oid } },
        { $group: { _id: `$${field}`, count: { $sum: 1 } } },
      ])
      .toArray();

    return rows.map((r) => ({
      label: r._id === null ? null : String(r._id),
      count: r.count,
    }));
  }

  static async lengthHistogram(datasetId, boundaries) {
    const oid = toOid(datasetId);
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
    const oid = toOid(datasetId);
    if (!oid) return [];
    const docs = await this.collection()
      .find({ datasetId: oid }, { projection: { commentText: 1 } })
      .limit(limit)
      .toArray();
    return docs.map((d) => d.commentText || "");
  }

  static async findForExport(domainFilter) {
    const docs = await this.collection()
      .find(toMongoFilter(domainFilter))
      .sort({ createdAt: 1 })
      .toArray();
    return docs.map(toDTO);
  }

  static async findManyByIds(ids) {
    const objectIds = (ids || []).map(toOid).filter(Boolean);
    if (!objectIds.length) return [];
    const docs = await this.collection()
      .find({ _id: { $in: objectIds } })
      .toArray();
    return docs.map(toDTO);
  }

  static async create(dto) {
    if (!dto.datasetId || !dto.sourceId) {
      throw new ValidationError("datasetId and sourceId are required");
    }
    const doc = dtoToDoc(dto);
    try {
      const r = await this.collection().insertOne(doc);
      return { id: r.insertedId.toString() };
    } catch (err) {
      throw translateError(err);
    }
  }

  static async updateById(id, patch) {
    const oid = toOid(id);
    if (!oid) return { matchedCount: 0, modifiedCount: 0 };
    const set = { ...patchToSet(patch), updatedAt: new Date() };
    const r = await this.collection().updateOne({ _id: oid }, { $set: set });
    return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  static async updateMany(domainFilter, patch) {
    const set = { ...patchToSet(patch), updatedAt: new Date() };
    const r = await this.collection().updateMany(toMongoFilter(domainFilter), {
      $set: set,
    });
    return { modifiedCount: r.modifiedCount };
  }

  static async bulkUpdate(patches) {
    if (!patches || !patches.length) return { modifiedCount: 0 };
    const ops = patches.map(({ id, patch }) => {
      const set = { ...patchToSet(patch), updatedAt: new Date() };
      return {
        updateOne: {
          filter: { _id: toOid(id) },
          update: { $set: set },
        },
      };
    });
    const r = await this.collection().bulkWrite(ops);
    return { modifiedCount: r.modifiedCount };
  }

  /**
   * Bulk-insert comments.
   * Returns [{ id, index }] for successfully inserted rows.
   * The `index` refers to the position in the input array.
   */
  static async insertMany(dtos) {
    if (!dtos || !dtos.length) return [];

    // fix: keep _importIndex out of the stored doc
    const docs = dtos.map((dto) => dtoToDoc(dto));
    const indices = dtos.map((_, i) => i);

    let result;
    try {
      result = await this.collection().insertMany(docs, { ordered: false });
    } catch (err) {
      result = (err && err.result) || { insertedIds: {} };
    }

    const insertedIds = result.insertedIds || {};
    const out = [];
    for (const [localIdx, oid] of Object.entries(insertedIds)) {
      const idx = Number(localIdx);
      out.push({ id: oid.toString(), index: indices[idx] });
    }
    return out;
  }

  static async deleteById(id) {
    const oid = toOid(id);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteOne({ _id: oid });
    return { deletedCount: r.deletedCount };
  }

  static async deleteMany(domainFilter) {
    const r = await this.collection().deleteMany(toMongoFilter(domainFilter));
    return { deletedCount: r.deletedCount };
  }

  static async rawInsertMany(docs) {
    if (!docs.length) return [];
    const r = await this.collection().insertMany(docs);
    return Object.values(r.insertedIds).map((oid) => ({ id: oid.toString() }));
  }
}

module.exports = Comment;
