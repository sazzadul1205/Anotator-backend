// models/Dataset.js
// Handles the "datasets" collection — one document per imported file.
// A dataset tracks import status, ownership, taxonomy, and progress.

const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");

const COLLECTION = "datasets";

class Dataset {
  static collection() {
    return getDB().collection(COLLECTION);
  }

  // Standard find by _id.
  static async findById(id) {
    return this.collection().findOne({ _id: new ObjectId(id) });
  }

  // Find by any filter object (e.g. { status: "completed" }).
  static async findOne(filter) {
    return this.collection().findOne(filter);
  }

  // List datasets, newest first.
  // eslint-disable-next-line no-unused-vars
  static async findAll(filter = {}, options = {}) {
    return this.collection().find(filter).sort({ createdAt: -1 }).toArray();
  }

  // Create a new dataset. Auto-stamps createdAt/updatedAt.
  static async create(doc) {
    const now = new Date();
    const result = await this.collection().insertOne({
      ...doc,
      createdAt: now,
      updatedAt: now,
    });
    return result.insertedId;
  }

  // Update any fields on a dataset; auto-bumps updatedAt.
  static async updateById(id, updates) {
    return this.collection().updateOne(
      { _id: new ObjectId(id) },
      { $set: { ...updates, updatedAt: new Date() } },
    );
  }

  // Update ONLY the progress object. Used by the background importer
  // to report phase / processed / total without touching other fields.
  static async updateProgress(id, progress) {
    return this.collection().updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          progress: { ...progress, updatedAt: new Date() },
          updatedAt: new Date(),
        },
      },
    );
  }

  static async deleteById(id) {
    return this.collection().deleteOne({ _id: new ObjectId(id) });
  }

  // --- Stats helpers ---

  static async countAll() {
    return this.collection().countDocuments({});
  }

  // Returns e.g. [{ _id: "completed", count: 5 }, { _id: "failed", count: 1 }]
  static async countByStatus() {
    return this.collection()
      .aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }])
      .toArray();
  }

  // Used before deleting a user — we block deletion if they still own datasets.
  static async countAssignedTo(userId) {
    return this.collection().countDocuments({
      assignedTo: new ObjectId(userId),
    });
  }

  // Startup cleanup: if the server crashed mid-import, any dataset left
  // in "pending"/"processing" older than `cutoff` gets marked "failed".
  static async cleanupStaleImports(cutoff) {
    return this.collection().updateMany(
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
  }

  // Returns datasets WITH per-dataset comment counts (total/annotated/pending).
  // Uses MongoDB's $lookup (like a SQL JOIN) to combine datasets + comments
  // in a single database round-trip.
  static async findWithCounts(filter = {}) {
    return this.collection()
      .aggregate([
        { $match: filter },
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
        // Attach the first (and only) count object as `summary`,
        // or a zeroed fallback if the dataset has no comments.
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
        // Remove the raw `counts` array — we only want `summary`.
        { $project: { counts: 0 } },
      ])
      .toArray();
  }
}

module.exports = Dataset;
