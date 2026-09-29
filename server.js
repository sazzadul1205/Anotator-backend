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
const media = require("./config/media");
const { notFound, errorHandler } = require("./middleware/errorHandler");
const concurrency = require("./config/concurrency");
const { Dataset } = require("./models");
const presenceService = require("./services/presenceService");

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
  // Media is reported but does NOT affect the status code. It is an optional
  // capability, and taking the whole API to 503 because a disk is full would
  // break the text-annotation half of the app over a feature it does not use.
  const mediaReady = await media.ping();

  res.status(healthy ? 200 : 503).json({
    success: healthy,
    message: healthy ? "Server is healthy" : "Database unavailable",
    db: dbStatus,
    storage: storage.status(),
    media: { ...media.describe(), available: mediaReady },
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
app.use("/api/media", require("./routes/mediaRoute"));
app.use("/api/presence", require("./routes/presenceRoute"));

app.use(notFound);
app.use(errorHandler);

const PORT = config.port;
let server;

async function start() {
  // Connects the selected provider and applies its schema/indexes.
  await storage.init();

  // Media bytes live on local disk, which is a separate seam from the record
  // store. The directory is created here so the first upload does not have to
  // race mkdir, and so a misconfigured MEDIA_ROOT is reported at boot rather
  // than on the first upload an user makes.
  try {
    const root = await media.init();
    console.log(`🖼️  Media store ready at ${root}`);
  } catch (err) {
    // Not fatal. The text-annotation half of the app does not need media, and
    // a read-only or full volume should not stop the API from serving.
    console.warn(`⚠️  Media store unavailable: ${err.message}`);
    console.warn("   Image/video annotation will fail until this is fixed.");
  }

  // Model-owned cleanup of stale imports from a prior crash.
  const cutoff = new Date(Date.now() - 30 * 60 * 1000);
  const cleaned = await Dataset.cleanupStaleImports(cutoff);
  if (cleaned.modifiedCount > 0) {
    console.log(`🧹 Marked ${cleaned.modifiedCount} stale imports as failed`);
  }

  // Sweep presence sessions that aged out while the server was down.
  const swept = await presenceService.sweepStaleSessions();
  if (swept.deletedCount > 0) {
    console.log(
      `🧹 Swept ${swept.deletedCount} stale presence sessions (older than ${config.presence.retentionDays}d)`,
    );
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
    // The media store holds no connections to close — files are opened and
    // closed per request — so there is nothing to flush here. It is called out
    // because the JSON record store *does* need flushing, and the order matters
    // less than the fact that both are inside the same shutdown path.
    storage.close().finally(() => process.exit(0));
  };

  if (!server) return done();
  server.close(done);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

module.exports = { app, start, assertValid };
