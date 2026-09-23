// models/Comment.js
// Handles the "comments" collection — the actual text rows to annotate.
// This is the biggest collection in the app.

const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");

const COLLECTION = "comments";

class Comment {
  static collection() {
    return getDB().collection(COLLECTION);
  }

  // Find one comment by _id.
  static async findById(id) {
    return this.collection().findOne({ _id: new ObjectId(id) });
  }

  // Find by arbitrary filter (e.g. { sourceId: "row-1", datasetId: ... }).
  static async findOne(filter) {
    return this.collection().findOne(filter);
  }

  // Flexible find with optional sort/skip/limit/projection.
  // This keeps pagination logic out of the service layer.
  static async find(filter, options = {}) {
    let cursor = this.collection().find(filter);
    if (options.sort) cursor = cursor.sort(options.sort);
    if (options.skip) cursor = cursor.skip(options.skip);
    if (options.limit) cursor = cursor.limit(options.limit);
    if (options.projection) cursor = cursor.project(options.projection);
    return cursor.toArray();
  }

  // Count how many comments match a filter.
  static async count(filter = {}) {
    return this.collection().countDocuments(filter);
  }

  // Insert one comment and return its _id.
  static async create(doc) {
    const result = await this.collection().insertOne(doc);
    return result.insertedId;
  }

  // Bulk insert — used by the background importer.
  // `ordered: false` lets valid rows succeed even if some fail (dupes).
  static async insertMany(docs, options = {}) {
    return this.collection().insertMany(docs, options);
  }

  // Update a comment by _id.
  static async updateById(id, updates) {
    return this.collection().updateOne(
      { _id: new ObjectId(id) },
      { $set: updates },
    );
  }

  // Update many comments at once (bulk assign / unassign).
  static async updateMany(filter, updates) {
    return this.collection().updateMany(filter, updates);
  }

  // Efficient mixed operations in one round-trip — used by bulk annotate
  // to update many comments while keeping versions consistent.
  static async bulkWrite(ops) {
    return this.collection().bulkWrite(ops);
  }

  static async deleteById(id) {
    return this.collection().deleteOne({ _id: new ObjectId(id) });
  }

  // Used when deleting a dataset — cascades to its comments.
  static async deleteMany(filter) {
    return this.collection().deleteMany(filter);
  }

  // Expose raw aggregation for analytics queries.
  static async aggregate(pipeline) {
    return this.collection().aggregate(pipeline).toArray();
  }

  // Convenience: get total/pending/annotated counts for one dataset in parallel.
  static async countByStatus(datasetId) {
    const [total, pending, annotated] = await Promise.all([
      this.count({ datasetId }),
      this.count({ datasetId, status: "pending" }),
      this.count({ datasetId, status: "annotated" }),
    ]);
    return { total, pending, annotated };
  }

  // Used by CSV/XLSX export — sorted oldest-first for stable output.
  static async findForExport(filter) {
    return this.collection().find(filter).sort({ createdAt: 1 }).toArray();
  }
}

module.exports = Comment;
