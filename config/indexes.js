// config/indexes.js
// Database indexes for the Mongo adapter.
// Stale-import cleanup is owned by the Dataset model
// (models/Dataset.js → cleanupStaleImports).

async function ensureIndexes(db) {
  await Promise.all([
    db.collection("users").createIndex({ email: 1 }, { unique: true }),
    db.collection("users").createIndex({ role: 1 }),

    db
      .collection("comments")
      .createIndex({ datasetId: 1, sourceId: 1 }, { unique: true }),
    db.collection("comments").createIndex({ datasetId: 1, status: 1 }),
    db.collection("comments").createIndex({ datasetId: 1, createdAt: -1 }),
    db.collection("comments").createIndex({ assignedTo: 1 }),
    db.collection("comments").createIndex({ status: 1 }),
    db.collection("comments").createIndex({ datasetId: 1, sentiment: 1 }),
    db.collection("comments").createIndex({ datasetId: 1, type: 1 }),
    db
      .collection("comments")
      .createIndex({ datasetId: 1, status: 1, sentiment: 1 }),

    db
      .collection("comment_versions")
      .createIndex({ commentId: 1, version: -1 }),
    db.collection("comment_versions").createIndex({ createdAt: -1 }),

    db.collection("datasets").createIndex({ assignedTo: 1 }),
    db.collection("datasets").createIndex({ createdAt: -1 }),
    db.collection("datasets").createIndex({ status: 1 }),
    db.collection("datasets").createIndex({ taxonomyId: 1 }),

    db.collection("audit_log").createIndex({ at: -1 }),
    db.collection("audit_log").createIndex({ actorId: 1, at: -1 }),
    db.collection("audit_log").createIndex({ action: 1, at: -1 }),
    db.collection("audit_log").createIndex({ targetType: 1, targetId: 1 }),

    db.collection("system_locks").createIndex({ claimedAt: 1 }),

    db.collection("taxonomies").createIndex({ isActive: 1 }),
    db.collection("taxonomies").createIndex({ name: 1 }),
  ]);
  console.log("✅ DB indexes ensured");
}

module.exports = { ensureIndexes };
