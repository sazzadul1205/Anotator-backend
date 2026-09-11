// scripts/init-indexes.js
// Run once: node scripts/init-indexes.js
// Safe to re-run — creates indexes only if they don't exist.

require("dotenv").config();
const dns = require("dns");
dns.setServers(["8.8.8.8"]);

const { MongoClient, ServerApiVersion } = require("mongodb");

async function main() {
  const client = new MongoClient(process.env.MONGO_URI, {
    serverApi: {
      version: ServerApiVersion.v1,
      strict: false,
      deprecationErrors: true,
    },
  });

  try {
    await client.connect();
    const db = client.db(process.env.DB_NAME || "annotator_db");

    console.log("Creating indexes...");

    // ---- users ----
    await db.collection("users").createIndex({ email: 1 }, { unique: true });
    await db.collection("users").createIndex({ role: 1, isActive: 1 });
    console.log("  users done");

    // ---- datasets ----
    await db.collection("datasets").createIndex({ uploadedBy: 1, createdAt: -1 });
    await db.collection("datasets").createIndex({ status: 1 });
    console.log("  datasets done");

    // ---- comments ----
    // Unique: prevents duplicate sourceId within the same dataset (race-safe).
    await db
      .collection("comments")
      .createIndex({ datasetId: 1, sourceId: 1 }, { unique: true });

    // Common filters
    await db.collection("comments").createIndex({ datasetId: 1, status: 1 });
    await db.collection("comments").createIndex({ datasetId: 1, sentiment: 1 });
    await db.collection("comments").createIndex({ datasetId: 1, type: 1 });
    await db.collection("comments").createIndex({ status: 1, assignedTo: 1 });
    await db.collection("comments").createIndex({ createdAt: -1 });

    // Text search on commentText
    await db.collection("comments").createIndex({ commentText: "text" });
    console.log("  comments done");

    // ---- comment_versions ----
    await db
      .collection("comment_versions")
      .createIndex({ commentId: 1, version: -1 });
    await db.collection("comment_versions").createIndex({ commentId: 1 });
    console.log("  comment_versions done");

    console.log("\nAll indexes created successfully.");
  } catch (err) {
    console.error("Index creation failed:", err);
    process.exit(1);
  } finally {
    await client.close();
  }
}

main();