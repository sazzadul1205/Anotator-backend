const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const { connectDB, getDB } = require("./config/db");

const app = express();
app.use(helmet());
app.use(cors());
app.use(express.json());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    error: "Too many login attempts. Please try again after 15 minutes.",
  },
});

async function ensureIndexes() {
  try {
    const db = getDB();
    await Promise.all([
      db.collection("Users").createIndex({ username: 1 }, { unique: true }),
      db.collection("Users").createIndex({ email: 1 }, { unique: true }),
      db.collection("Projects").createIndex({ assignedTo: 1 }),
      db.collection("Projects").createIndex({ createdAt: -1 }),
      db.collection("Comments").createIndex({ projectId: 1, isValidated: 1 }),
      db.collection("Comments").createIndex({ projectId: 1, createdAt: -1 }),
      db.collection("ChangeLog").createIndex({ entityType: 1, entityId: 1, version: -1 }),
      db.collection("ChangeLog").createIndex({ projectId: 1, createdAt: -1 }),
      db.collection("ChangeLog").createIndex({ createdAt: -1 }),
    ]);
    console.log("✅ Indexes ensured");
  } catch (err) {
    console.error("Index creation failed:", err.message);
  }
}

(async () => {
  await connectDB();
  await ensureIndexes();

  const authRoutes = require("./routes/authRoutes");
  const projectRoutes = require("./routes/projectRoutes");
  const commentRoutes = require("./routes/commentRoutes");
  const versionRoutes = require("./routes/versionRoutes");

  app.use("/api/auth/login", loginLimiter);
  app.use("/api/auth", authRoutes);
  app.use("/api", projectRoutes);
  app.use("/api", commentRoutes);
  app.use("/api", versionRoutes);

  app.get("/", (req, res) =>
    res.json({ message: "Annotator backend is running" })
  );
  app.get("/health", (req, res) =>
    res.status(200).json({
      success: true,
      message: "Server is healthy",
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    })
  );

  app.use((req, res) =>
    res.status(404).json({
      success: false,
      error: "Route not found",
      path: req.originalUrl,
    })
  );

  const PORT = process.env.PORT || 5000;
  app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
})();