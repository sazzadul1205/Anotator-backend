// config/indexes.js
async function ensureIndexes(db) {
  await Promise.all([
    // Users
    db.collection("users").createIndex({ email: 1 }, { unique: true }),
    db.collection("users").createIndex({ role: 1 }),

    // Comments
    db.collection("comments").createIndex(
      { datasetId: 1, sourceId: 1 },
      { unique: true },
    ),
    db.collection("comments").createIndex({ datasetId: 1, status: 1 }),
    db.collection("comments").createIndex({ datasetId: 1, createdAt: -1 }),
    db.collection("comments").createIndex({ assignedTo: 1 }),
    db.collection("comments").createIndex({ status: 1 }),

    // Versions
    db
      .collection("comment_versions")
      .createIndex({ commentId: 1, version: -1 }),
    db.collection("comment_versions").createIndex({ createdAt: -1 }),

    // Datasets
    db.collection("datasets").createIndex({ assignedTo: 1 }),
    db.collection("datasets").createIndex({ createdAt: -1 }),
    db.collection("datasets").createIndex({ status: 1 }),
    db.collection("datasets").createIndex({ checksum: 1 }),

    // Audit log
    db.collection("audit_log").createIndex({ at: -1 }),
    db.collection("audit_log").createIndex({ actorId: 1, at: -1 }),
    db.collection("audit_log").createIndex({ action: 1, at: -1 }),
    db.collection("audit_log").createIndex({ targetType: 1, targetId: 1 }),

    // Bootstrap lock
    db.collection("system_locks").createIndex({ claimedAt: 1 }),
  ]);
  console.log("✅ DB indexes ensured");
}

async function cleanupStaleImports(db) {
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  const result = await db.collection("datasets").updateMany(
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
  if (result.modifiedCount > 0) {
    console.log(`🧹 Marked ${result.modifiedCount} stale imports as failed`);
  }
}

module.exports = { ensureIndexes, cleanupStaleImports };