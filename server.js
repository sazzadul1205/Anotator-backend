const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const { connectDB, getDB } = require("./config/db");
const { ensureIndexes, cleanupStaleImports } = require("./config/indexes");
const { validateEnv } = require("./config/env");

validateEnv();

const app = express();

if (process.env.NODE_ENV === "production") {
  app.set("trust proxy", 1);
}

app.use(helmet());

const corsOptions = {
  origin:
    process.env.NODE_ENV === "production"
      ? (process.env.CORS_ORIGIN || "").split(",").filter(Boolean)
      : true,
  credentials: true,
};
app.use(cors(corsOptions));

app.use(express.json());

if (process.env.NODE_ENV === "production") {
  app.use(morgan("combined"));
} else {
  app.use(morgan("dev"));
}

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: process.env.NODE_ENV === "production" ? 300 : 10000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. Please slow down." },
});

app.use("/api", globalLimiter);

// DB readiness guard
app.use("/api", (req, res, next) => {
  const db = getDB();
  if (!db) {
    return res.status(503).json({
      success: false,
      error: "Database not ready. Try again shortly.",
    });
  }
  next();
});

app.get("/", (req, res) => {
  res.json({ message: "Annotator backend is running" });
});

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
app.use("/api/audit", require("./routes/auditRoute"));

// 404
app.use((req, res) =>
  res.status(404).json({
    success: false,
    error: "Route not found",
    path: req.originalUrl,
  }),
);

// Central error handler
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

const PORT = process.env.PORT || 5000;
let server;

async function start() {
  await connectDB();
  const db = getDB();

  await ensureIndexes(db);
  await cleanupStaleImports(db);

  server = app.listen(PORT, () => {
    console.log(
      `🚀 Server running on http://localhost:${PORT}  [NODE_ENV=${
        process.env.NODE_ENV || "development"
      }]`,
    );
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  if (!server) process.exit(0);
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