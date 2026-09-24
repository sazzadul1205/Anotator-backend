// controllers/datasetController.js
// Thin HTTP wrappers around datasetService and importService.

const datasetService = require("../services/datasetService");
const importService = require("../services/importService");

/**
 * POST /api/datasets/import
 * Accepts a multipart file upload, validates it, creates the dataset
 * record, and kicks off the background import.
 */
async function importDataset(req, res, next) {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, error: "No file uploaded" });
    }

    const originalName = req.file.originalname;
    const fileType = originalName.toLowerCase().endsWith(".csv")
      ? "csv"
      : "xlsx";

    if (!["csv", "xlsx"].includes(fileType)) {
      return res.status(400).json({
        success: false,
        error: "Only .csv and .xlsx files allowed",
      });
    }
    if (!req.file.buffer || req.file.buffer.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "Uploaded file is empty" });
    }

    // Reject early if the import queue is full — before we touch the DB.
    if (!importService.canAcceptImport()) {
      return res.status(503).json({
        success: false,
        error: "Import queue is full. Try again shortly.",
        queue: importService.importQueueSnapshot(),
      });
    }

    // Dataset name from body or filename fallback
    let datasetName = "";
    if (typeof req.body.name === "string") {
      datasetName = req.body.name.trim();
    } else if (Array.isArray(req.body.name) && req.body.name.length > 0) {
      datasetName = String(req.body.name[0]).trim();
    }
    if (datasetName.length > 120) {
      return res.status(400).json({
        success: false,
        error: "Dataset name must be 120 characters or fewer",
      });
    }
    if (!datasetName) {
      datasetName = originalName.replace(/\.(csv|xlsx)$/i, "");
    }

    const dedupeStrategy =
      req.body.dedupeStrategy === "rename" ? "rename" : "skip";

    const result = await importService.startImport({
      fileBuffer: req.file.buffer,
      originalName,
      fileType,
      datasetName,
      dedupeStrategy,
      taxonomyId: req.body.taxonomyId || null,
      uploadedBy: req.user.userId,
      actor: req.user,
    });

    res.status(202).json({
      success: true,
      message: "Import started. Poll the dataset to track progress.",
      datasetId: result.datasetId,
      status: "pending",
      name: result.name,
      taxonomyId: result.taxonomyId,
      taxonomyName: result.taxonomyName,
    });

    // Kick off background processing (fire-and-forget, queued).
    importService
      .processImportInBackground({
        datasetId: result.datasetId,
        fileBuffer: req.file.buffer,
        originalName,
        uploadedBy: req.user.userId,
        dedupeStrategy,
      })
      .catch((err) => console.error("uncaught background error:", err));
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/datasets/preview
 * Inspect an uploaded file without importing it.
 */
async function previewDataset(req, res, next) {
  try {
    if (!req.file) {
      return res
        .status(400)
        .json({ success: false, error: "No file uploaded" });
    }
    const preview = await importService.previewFile(
      req.file.buffer,
      req.file.originalname,
    );
    res.json({ success: true, preview });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/datasets/stats
 */
async function getStats(req, res, next) {
  try {
    const stats = await datasetService.getStats();
    res.json({ success: true, stats });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/datasets
 */
async function list(req, res, next) {
  try {
    const datasets = await datasetService.listDatasets(req.query, req.user);
    res.json({ success: true, datasets });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/datasets/:id
 */
async function getOne(req, res, next) {
  try {
    const result = await datasetService.getDataset(req.params.id, req.user);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/datasets/:id/assign
 */
async function assign(req, res, next) {
  try {
    const result = await datasetService.assignDataset(
      req.params.id,
      req.body.assignedTo,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/datasets/:id/duplicate
 */
async function duplicate(req, res, next) {
  try {
    const result = await datasetService.duplicateDataset(
      req.params.id,
      req.body && req.body.name,
      req.user,
    );
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/datasets/:id/rename
 */
async function rename(req, res, next) {
  try {
    const result = await datasetService.renameDataset(
      req.params.id,
      req.body.name,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/datasets/:id
 */
async function remove(req, res, next) {
  try {
    const result = await datasetService.deleteDataset(req.params.id, req.user);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  importDataset,
  previewDataset,
  getStats,
  list,
  getOne,
  assign,
  duplicate,
  rename,
  remove,
};
