// server.js
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const { config, assertValid } = require("./config/app");
const { validateEnv } = require("./config/env");
const storage = require("./config/storage");
const { notFound, errorHandler } = require("./middleware/errorHandler");
const concurrency = require("./config/concurrency");
const { Dataset } = require("./models");

validateEnv();

const app = express();

if (config.isProduction) {
  app.set("trust proxy", 1);
}

app.use(helmet());

const corsOptions = {
  // Development reflects the request origin; production uses CORS_ORIGIN.
  origin: config.isProduction ? config.corsOrigin : true,
  credentials: true,
};
app.use(cors(corsOptions));

app.use(express.json());

app.use(morgan(config.isProduction ? "combined" : "dev"));

const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: config.rateLimit.global || (config.isProduction ? 300 : 10000),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: "Too many requests. Please slow down." },
});

app.use("/api", globalLimiter);

// Storage readiness guard. Provider-neutral: `storage.getStore()` returns the
// Mongo Db handle or the JSON store, and is null until connected.
app.use("/api", (req, res, next) => {
  if (!storage.getStore()) {
    return res.status(503).json({
      success: false,
      error: "Database not ready. Try again shortly.",
    });
  }
  next();
});

app.get("/", (req, res) => {
  res.json({
    message: "Annotator backend is running",
    storage: storage.providerName(),
  });
});

app.get("/health", async (req, res) => {
  const dbStatus = (await storage.ping()) ? "ok" : "error";
  const healthy = dbStatus === "ok";

  res.status(healthy ? 200 : 503).json({
    success: healthy,
    message: healthy ? "Server is healthy" : "Database unavailable",
    db: dbStatus,
    storage: storage.status(),
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    queues: {
      imports: concurrency.imports.snapshot(),
      exports: concurrency.exports.snapshot(),
    },
  });
});

// Routes
app.use("/api/auth", require("./routes/authRoute"));
app.use("/api/users", require("./routes/userRoute"));
app.use("/api/datasets", require("./routes/datasetRoute"));
app.use("/api/comments", require("./routes/commentRoute"));
app.use("/api/taxonomies", require("./routes/taxonomyRoute"));
app.use("/api/audit", require("./routes/auditRoute"));
app.use("/api/analytics", require("./routes/analyticsRoute"));

app.use(notFound);
app.use(errorHandler);

const PORT = config.port;
let server;

async function start() {
  // Connects the selected provider and applies its schema/indexes.
  await storage.init();

  // Model-owned cleanup of stale imports from a prior crash.
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  const cleaned = await Dataset.cleanupStaleImports(cutoff);
  if (cleaned.modifiedCount > 0) {
    console.log(`🧹 Marked ${cleaned.modifiedCount} stale imports as failed`);
  }

  server = app.listen(PORT, () => {
    console.log(
      `🚀 Server running on http://localhost:${PORT}  ` +
        `[NODE_ENV=${config.env}] [storage=${storage.providerName()}]`,
    );
  });
}

start().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

function shutdown(signal) {
  console.log(`\nReceived ${signal}. Shutting down gracefully...`);
  const force = setTimeout(() => {
    console.error("Forced shutdown after 10s.");
    process.exit(1);
  }, 10000);
  force.unref();

  const done = () => {
    console.log("HTTP server closed.");
    storage.close().finally(() => process.exit(0));
  };

  if (!server) return done();
  server.close(done);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

module.exports = { app, start, assertValid };
