const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const { connectDB, getDB } = require("./config/db");

const app = express();

// Security
if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.use(helmet());
app.use(cors());
app.use(express.json());

// Request logging
if (process.env.NODE_ENV === "production") {
  app.use(morgan("combined"));
} else {
  app.use(morgan("dev"));
}

// Global rate limiter
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === "production" ? 300 : 10000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. Please slow down." },
});

// Apply global rate limiter
app.use("/api", globalLimiter);

// Check if DB is ready
app.use("/api", (req, res, next) => {
  const db = getDB();
  if (!db) {
    return res
      .status(503)
      .json({
        success: false,
        error: "Database not ready. Try again shortly.",
      });
  }
  next();
});

// Connect to MongoDB + startup cleanup
connectDB().then(async () => {
  try {
    const db = getDB();
    const result = await db.collection("datasets").updateMany(
      { status: { $in: ["pending", "processing"] } },
      {
        $set: {
          status: "failed",
          importError: "Server restarted during import",
          updatedAt: new Date(),
        },
      },
    );
    if (result.modifiedCount > 0) {
      console.log(
        `[startup] marked ${result.modifiedCount} stuck dataset(s) as failed`,
      );
    }
  } catch (err) {
    console.error("[startup] failed to reset stuck imports:", err.message);
  }
});

// Root
app.get("/", (req, res) => {
  res.json({ message: "Annotator backend is running" });
});

// Health check (pings DB)
app.get("/health", async (req, res) => {
  let dbStatus;
  try {
    const db = getDB();
    await db.command({ ping: 1 });
    dbStatus = "ok";
  } catch (err) {
    console.error(err);
    dbStatus = "error";
  }

  const healthy = dbStatus === "ok";
  res.status(healthy ? 200 : 503).json({
    success: healthy,
    message: healthy ? "Server is healthy" : "Database unavailable",
    db: dbStatus,
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Routes
app.use("/api/auth", require("./routes/authRoute"));
app.use("/api/users", require("./routes/userRoute"));
app.use("/api/datasets", require("./routes/datasetRoute"));
app.use("/api/comments", require("./routes/commentRoute"));

// 404
app.use((req, res) =>
  res.status(404).json({
    success: false,
    error: "Route not found",
    path: req.originalUrl,
  }),
);

// Centralized error handler (must be last, 4 args)
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error("[error]", err);
  res.status(err.status || 500).json({
    success: false,
    error:
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message,
  });
});

// Start server
const PORT = process.env.PORT || 5000;

const server = app.listen(PORT, () => {
  console.log(
    `Server running on http://localhost:${PORT}  [NODE_ENV=${process.env.NODE_ENV || "development"}]`,
  );
});

// Graceful shutdown
function shutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  server.close(() => {
    console.log("HTTP server closed.");
    process.exit(0);
  });

  setTimeout(() => {
    console.error("Forced shutdown after 10s.");
    process.exit(1);
  }, 10000);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
