// models/CommentVersion.js
// Handles the "comment_versions" collection — an immutable audit trail.
// Every time a comment is created/updated/annotated/restored,
// we append ONE row here with a full snapshot of the state.

const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");

const COLLECTION = "comment_versions";

class CommentVersion {
  static collection() {
    return getDB().collection(COLLECTION);
  }

  // Append one version row.
  static async create(doc) {
    return this.collection().insertOne(doc);
  }

  // Append many version rows at once (used by importer & bulk ops).
  static async insertMany(docs) {
    return this.collection().insertMany(docs);
  }

  // Get the version history for one comment, NEWEST first.
  // Supports pagination via options.skip / options.limit.
  static async findByCommentId(commentId, options = {}) {
    let cursor = this.collection().find({ commentId: new ObjectId(commentId) });
    cursor = cursor.sort({ version: -1 });
    if (options.skip) cursor = cursor.skip(options.skip);
    if (options.limit) cursor = cursor.limit(options.limit);
    return cursor.toArray();
  }

  // Count how many versions a comment has (for pagination UI).
  static async countByCommentId(commentId) {
    return this.collection().countDocuments({
      commentId: new ObjectId(commentId),
    });
  }

  // Find a specific version row (used by the restore endpoint).
  static async findOne(filter) {
    return this.collection().findOne(filter);
  }

  // Cascade delete — when a comment is deleted, we purge its versions.
  static async deleteMany(filter) {
    return this.collection().deleteMany(filter);
  }

  // Group versions by day for the activity chart.
  // Example output: [{ _id: "2024-01-15", count: 42 }, ...]
  static async activityByDate(matchFilter, groupFormat = "%Y-%m-%d") {
    return this.collection()
      .aggregate([
        { $match: matchFilter },
        {
          $group: {
            _id: { $dateToString: { format: groupFormat, date: "$createdAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();
  }
}

module.exports = CommentVersion;
