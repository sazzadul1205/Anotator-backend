const dns = require("dns");
dns.setServers(["8.8.8.8"]);

const { MongoClient, ServerApiVersion } = require("mongodb");

const client = new MongoClient(process.env.MONGO_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: false,
    deprecationErrors: true,
  },
});

let db = null;

async function connectDB() {
  if (db) return db;
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("✅ Connected to MongoDB");
    db = client.db(process.env.DB_NAME || "annotator_db");
    return db;
  } catch (error) {
    console.error("❌ MongoDB connection failed:", error);
    process.exit(1);
  }
}

function getDB() {
  return db;
}

module.exports = { connectDB, getDB };
