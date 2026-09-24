// models/Dataset.js
// One document per imported file.

const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");

const COLLECTION = "datasets";

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
    name: doc.name,
    originalFileName: doc.originalFileName,
    fileType: doc.fileType,
    sheetName: doc.sheetName ?? null,
    checksum: doc.checksum,
    totalRows: doc.totalRows,
    importedRows: doc.importedRows,
    skippedRows: doc.skippedRows,
    renamedRows: doc.renamedRows || 0,
    dedupeStrategy: doc.dedupeStrategy || "skip",
    status: doc.status,
    importError: doc.importError ?? null,
    importErrors: doc.importErrors || [],
    progress: doc.progress || null,
    taxonomyId: idStr(doc.taxonomyId),
    taxonomyName: doc.taxonomyName ?? null,
    taxonomyAssignedAt: doc.taxonomyAssignedAt ?? null,
    uploadedBy: idStr(doc.uploadedBy),
    assignedTo: idStr(doc.assignedTo),
    assignedAt: doc.assignedAt ?? null,
    duplicatedFrom: idStr(doc.duplicatedFrom),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function toMongoFilter(domain = {}) {
  const f = {};
  if (domain.status) f.status = domain.status;
  if (domain.assignedTo) f.assignedTo = toOid(domain.assignedTo);
  if (domain.uploadedBy) f.uploadedBy = toOid(domain.uploadedBy);
  if (domain.taxonomyId) f.taxonomyId = toOid(domain.taxonomyId);
  return f;
}

function patchToSet(patch) {
  const set = { ...patch };
  delete set.id;
  delete set._id;
  for (const k of [
    "assignedTo",
    "uploadedBy",
    "taxonomyId",
    "duplicatedFrom",
  ]) {
    if (k in set) set[k] = set[k] ? toOid(set[k]) : null;
  }
  return set;
}

class Dataset {
  static collection() {
    return getDB().collection(COLLECTION);
  }

  // --- Reads ---------------------------------------------------------------

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

  /** List datasets, newest first. */
  static async findMany(domainFilter = {}) {
    const docs = await this.collection()
      .find(toMongoFilter(domainFilter))
      .sort({ createdAt: -1 })
      .toArray();
    return docs.map(toDTO);
  }

  /**
   * List datasets with per-dataset comment counts attached.
   * Returns DTO[] with a `summary: { total, annotated, pending }` field.
   */
  static async findManyWithCounts(domainFilter = {}) {
    const docs = await this.collection()
      .aggregate([
        { $match: toMongoFilter(domainFilter) },
        { $sort: { createdAt: -1 } },
        {
          $lookup: {
            from: "comments",
            let: { dsId: "$_id" },
            pipeline: [
              { $match: { $expr: { $eq: ["$datasetId", "$$dsId"] } } },
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  annotated: {
                    $sum: { $cond: [{ $eq: ["$status", "annotated"] }, 1, 0] },
                  },
                  pending: {
                    $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
                  },
                },
              },
            ],
            as: "counts",
          },
        },
        {
          $addFields: {
            summary: {
              $ifNull: [
                { $arrayElemAt: ["$counts", 0] },
                { total: 0, annotated: 0, pending: 0 },
              ],
            },
          },
        },
        { $project: { counts: 0 } },
      ])
      .toArray();

    return docs.map((doc) => ({
      ...toDTO(doc),
      summary: {
        total: doc.summary.total,
        annotated: doc.summary.annotated,
        pending: doc.summary.pending,
      },
    }));
  }

  /** Ids (strings) of datasets assigned to a user. */
  static async findAssignedToIds(userId) {
    const oid = toOid(userId);
    if (!oid) return [];
    const docs = await this.collection()
      .find({ assignedTo: oid }, { projection: { _id: 1 } })
      .toArray();
    return docs.map((d) => d._id.toString());
  }

  // --- Writes --------------------------------------------------------------

  /** Create a dataset. Returns { id }. */
  static async create(dto) {
    const now = new Date();
    const doc = {
      ...dto,
      taxonomyId: dto.taxonomyId ? toOid(dto.taxonomyId) : null,
      uploadedBy: dto.uploadedBy ? toOid(dto.uploadedBy) : null,
      assignedTo: dto.assignedTo ? toOid(dto.assignedTo) : null,
      duplicatedFrom: dto.duplicatedFrom ? toOid(dto.duplicatedFrom) : null,
      createdAt: now,
      updatedAt: now,
    };
    delete doc.id;
    const r = await this.collection().insertOne(doc);
    return { id: r.insertedId.toString() };
  }

  /** Update a dataset by id. Returns { matchedCount, modifiedCount }. */
  static async updateById(id, patch) {
    const oid = toOid(id);
    if (!oid) return { matchedCount: 0, modifiedCount: 0 };
    const set = { ...patchToSet(patch), updatedAt: new Date() };
    const r = await this.collection().updateOne({ _id: oid }, { $set: set });
    return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  /** Replace the whole progress object. Used by the importer. */
  static async updateProgress(id, progress) {
    const oid = toOid(id);
    if (!oid) return { matchedCount: 0 };
    return this.collection().updateOne(
      { _id: oid },
      {
        $set: {
          progress: { ...progress, updatedAt: new Date() },
          updatedAt: new Date(),
        },
      },
    );
  }

  /** Bump only progress.processed and timestamps. */
  static async setProgressProcessed(id, processed) {
    const oid = toOid(id);
    if (!oid) return { matchedCount: 0 };
    return this.collection().updateOne(
      { _id: oid },
      {
        $set: {
          "progress.processed": processed,
          "progress.updatedAt": new Date(),
          updatedAt: new Date(),
        },
      },
    );
  }

  /** Remove taxonomy fields (used by unassignFromDataset). */
  static async clearTaxonomy(id) {
    const oid = toOid(id);
    if (!oid) return { matchedCount: 0 };
    return this.collection().updateOne(
      { _id: oid },
      {
        $unset: { taxonomyId: "", taxonomyName: "", taxonomyAssignedAt: "" },
        $set: { updatedAt: new Date() },
      },
    );
  }

  static async deleteById(id) {
    const oid = toOid(id);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteOne({ _id: oid });
    return { deletedCount: r.deletedCount };
  }

  // --- Aggregations / counts ----------------------------------------------

  static async countAll() {
    return this.collection().countDocuments({});
  }

  /** Returns [{ status, count }]. */
  static async countByStatus() {
    const rows = await this.collection()
      .aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }])
      .toArray();
    return rows.map((r) => ({ status: r._id || "unknown", count: r.count }));
  }

  static async countAssignedTo(userId) {
    const oid = toOid(userId);
    if (!oid) return 0;
    return this.collection().countDocuments({ assignedTo: oid });
  }

  /**
   * Top N datasets by comment count.
   * Returns [{ id, name, status, total, annotated }].
   */
  static async topByCommentCount(limit = 10) {
    const rows = await this.collection()
      .aggregate([
        {
          $lookup: {
            from: "comments",
            let: { dsId: "$_id" },
            pipeline: [
              { $match: { $expr: { $eq: ["$datasetId", "$$dsId"] } } },
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  annotated: {
                    $sum: { $cond: [{ $eq: ["$status", "annotated"] }, 1, 0] },
                  },
                },
              },
            ],
            as: "counts",
          },
        },
        {
          $addFields: {
            summary: {
              $ifNull: [
                { $arrayElemAt: ["$counts", 0] },
                { total: 0, annotated: 0 },
              ],
            },
          },
        },
        { $match: { "summary.total": { $gt: 0 } } },
        { $sort: { "summary.total": -1 } },
        { $limit: limit },
        {
          $project: {
            name: 1,
            status: 1,
            total: "$summary.total",
            annotated: "$summary.annotated",
          },
        },
      ])
      .toArray();

    return rows.map((r) => ({
      id: r._id.toString(),
      name: r.name,
      status: r.status,
      total: r.total,
      annotated: r.annotated,
    }));
  }

  /** Mark stale pending/processing imports as failed. */
  static async cleanupStaleImports(cutoff) {
    const r = await this.collection().updateMany(
      {
        status: { $in: ["pending", "processing"] },
        updatedAt: { $lt: cutoff },
      },
      {
        $set: {
          status: "failed",
          importError: "Server restarted during import",
          updatedAt: new Date(),
        },
      },
    );
    return { modifiedCount: r.modifiedCount };
  }
}

module.exports = Dataset;
