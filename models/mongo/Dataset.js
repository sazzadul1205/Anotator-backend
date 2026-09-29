// models/mongo/Dataset.js
// MongoDB implementation of the Dataset model.

const storage = require("../../config/storage");
const { objectIds } = require("./oid");
const { datasetToDTO } = require("../shared/dto");
const { datasetFilter, sanitizePatch, DATASET_REF_FIELDS } = require("../shared/filters");

const COLLECTION = "datasets";

const EMPTY_SUMMARY = { total: 0, annotated: 0, pending: 0 };

class Dataset {
  static collection() {
    return storage.getStore().collection(COLLECTION);
  }

  // --- Reads ---------------------------------------------------------------

  static async findById(id) {
    const oid = objectIds.coerce(id);
    if (!oid) return null;
    const doc = await this.collection().findOne({ _id: oid });
    return datasetToDTO(doc);
  }

  static async findOne(domainFilter) {
    const doc = await this.collection().findOne(
      datasetFilter(domainFilter, objectIds),
    );
    return datasetToDTO(doc);
  }

  /** List datasets, newest first. */
  static async findMany(domainFilter = {}) {
    const docs = await this.collection()
      .find(datasetFilter(domainFilter, objectIds))
      .sort({ createdAt: -1 })
      .toArray();
    return docs.map(datasetToDTO);
  }

  /**
   * List datasets with per-dataset comment counts attached.
   * Returns DTO[] with a `summary: { total, annotated, pending }` field.
   */
  static async findManyWithCounts(domainFilter = {}) {
    const docs = await this.collection()
      .aggregate([
        { $match: datasetFilter(domainFilter, objectIds) },
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
              $ifNull: [{ $arrayElemAt: ["$counts", 0] }, EMPTY_SUMMARY],
            },
          },
        },
        { $project: { counts: 0 } },
      ])
      .toArray();

    return docs.map((doc) => ({
      ...datasetToDTO(doc),
      summary: {
        total: doc.summary.total,
        annotated: doc.summary.annotated,
        pending: doc.summary.pending,
      },
    }));
  }

  /** Ids (strings) of datasets assigned to a user. */
  static async findAssignedToIds(userId) {
    const oid = objectIds.coerce(userId);
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
    const doc = sanitizePatch(dto, objectIds, DATASET_REF_FIELDS);
    doc.createdAt = now;
    doc.updatedAt = now;
    const r = await this.collection().insertOne(doc);
    return { id: r.insertedId.toString() };
  }

  /** Update a dataset by id. Returns { matchedCount, modifiedCount }. */
  static async updateById(id, patch) {
    const oid = objectIds.coerce(id);
    if (!oid) return { matchedCount: 0, modifiedCount: 0 };
    const set = { ...sanitizePatch(patch, objectIds, DATASET_REF_FIELDS), updatedAt: new Date() };
    const r = await this.collection().updateOne({ _id: oid }, { $set: set });
    return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  /** Replace the whole progress object. Used by the importer. */
  static async updateProgress(id, progress) {
    const oid = objectIds.coerce(id);
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
    const oid = objectIds.coerce(id);
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

  /**
   * Remove taxonomy fields (used by unassignFromDataset).
   * Values are set to null rather than unset so DTO mappers always see a
   * defined value, and document shape stays uniform across all datasets.
   */
  static async clearTaxonomy(id) {
    const oid = objectIds.coerce(id);
    if (!oid) return { matchedCount: 0 };
    return this.collection().updateOne(
      { _id: oid },
      {
        $set: {
          taxonomyId: null,
          taxonomyName: null,
          taxonomyAssignedAt: null,
          updatedAt: new Date(),
        },
      },
    );
  }

  static async deleteById(id) {
    const oid = objectIds.coerce(id);
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
    const oid = objectIds.coerce(userId);
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
              $ifNull: [{ $arrayElemAt: ["$counts", 0] }, { total: 0, annotated: 0 }],
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
