// models/json/Dataset.js
// JSON-provider implementation of the Dataset model.
//
// The two aggregation helpers that Mongo solves with $lookup + $group
// (findManyWithCounts, topByCommentCount) are resolved here with an in-process
// join over the comments collection.

const storage = require("../../config/storage");
const { stringIds } = require("../shared/ids");
const { datasetToDTO } = require("../shared/dto");
const { datasetFilter, sanitizePatch, DATASET_REF_FIELDS } = require("../shared/filters");
const { statusSummary } = require("../shared/aggregate");

const COLLECTION = "datasets";

/** Index comments by datasetId once, then reuse for every dataset. */
async function commentsByDataset() {
  const comments = await storage.getStore().collection("comments").find({});
  const index = new Map();
  for (const comment of comments) {
    const key = stringIds.toString(comment.datasetId);
    if (key === null) continue;
    if (!index.has(key)) index.set(key, []);
    index.get(key).push(comment);
  }
  return index;
}

class Dataset {
  static collection() {
    return storage.getStore().collection(COLLECTION);
  }

  // --- Reads ---------------------------------------------------------------

  static async findById(id) {
    const oid = stringIds.coerce(id);
    if (!oid) return null;
    const doc = await this.collection().findOne({ _id: oid });
    return datasetToDTO(doc);
  }

  static async findOne(domainFilter) {
    const doc = await this.collection().findOne(datasetFilter(domainFilter, stringIds));
    return datasetToDTO(doc);
  }

  /** List datasets, newest first. */
  static async findMany(domainFilter = {}) {
    const docs = await this.collection().find(datasetFilter(domainFilter, stringIds), {
      sort: { createdAt: -1 },
    });
    return docs.map(datasetToDTO);
  }

  /**
   * List datasets with per-dataset comment counts attached.
   * Returns DTO[] with a `summary: { total, annotated, pending }` field.
   */
  static async findManyWithCounts(domainFilter = {}) {
    const docs = await this.collection().find(datasetFilter(domainFilter, stringIds), {
      sort: { createdAt: -1 },
    });
    const byDataset = await commentsByDataset();

    return docs.map((doc) => {
      const rows = byDataset.get(stringIds.toString(doc._id)) || [];
      const summary = rows.length ? statusSummary(rows) : { total: 0, annotated: 0, pending: 0 };
      return { ...datasetToDTO(doc), summary };
    });
  }

  /** Ids (strings) of datasets assigned to a user. */
  static async findAssignedToIds(userId) {
    const oid = stringIds.coerce(userId);
    if (!oid) return [];
    const docs = await this.collection().find(
      { assignedTo: oid },
      { projection: { _id: 1 } },
    );
    return docs.map((d) => d._id.toString());
  }

  // --- Writes --------------------------------------------------------------

  /** Create a dataset. Returns { id }. */
  static async create(dto) {
    const now = new Date();
    const doc = sanitizePatch(dto, stringIds, DATASET_REF_FIELDS);
    doc.createdAt = now;
    doc.updatedAt = now;
    const r = await this.collection().insertOne(doc);
    return { id: r.insertedId };
  }

  /** Update a dataset by id. Returns { matchedCount, modifiedCount }. */
  static async updateById(id, patch) {
    const oid = stringIds.coerce(id);
    if (!oid) return { matchedCount: 0, modifiedCount: 0 };
    const set = { ...sanitizePatch(patch, stringIds, DATASET_REF_FIELDS), updatedAt: new Date() };
    const r = await this.collection().updateOne({ _id: oid }, { $set: set });
    return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  /** Replace the whole progress object. Used by the importer. */
  static async updateProgress(id, progress) {
    const oid = stringIds.coerce(id);
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
    const oid = stringIds.coerce(id);
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
   * Values are set to null rather than removed so DTO mappers always see a
   * defined value, and document shape stays uniform across all datasets.
   */
  static async clearTaxonomy(id) {
    const oid = stringIds.coerce(id);
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
    const oid = stringIds.coerce(id);
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
    const rows = await this.collection().find({});
    const counts = new Map();
    for (const row of rows) {
      const key = row.status || "unknown";
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].map(([status, count]) => ({ status, count }));
  }

  static async countAssignedTo(userId) {
    const oid = stringIds.coerce(userId);
    if (!oid) return 0;
    return this.collection().countDocuments({ assignedTo: oid });
  }

  /**
   * Top N datasets by comment count.
   * Returns [{ id, name, status, total, annotated }].
   */
  static async topByCommentCount(limit = 10) {
    const rows = await this.collection().find({});
    const byDataset = await commentsByDataset();

    return rows
      .map((doc) => {
        const comments = byDataset.get(stringIds.toString(doc._id)) || [];
        const summary = statusSummary(comments);
        return { doc, summary };
      })
      .filter(({ summary }) => summary.total > 0)
      .sort((a, b) => b.summary.total - a.summary.total)
      .slice(0, limit)
      .map(({ doc, summary }) => ({
        id: doc._id.toString(),
        name: doc.name,
        status: doc.status,
        total: summary.total,
        annotated: summary.annotated,
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
