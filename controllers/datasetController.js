const { ObjectId } = require("mongodb");
const crypto = require("crypto");
const datasetService = require("../services/datasetService");
const importService = require("../services/importService");
const Taxonomy = require("../models/Taxonomy");
const { audit } = require("../utils/audit");

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
      return res
        .status(400)
        .json({ success: false, error: "Only .csv and .xlsx files allowed" });
    }
    if (!req.file.buffer || req.file.buffer.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "Uploaded file is empty" });
    }

    let datasetName = "";
    if (typeof req.body.name === "string") {
      datasetName = req.body.name.trim();
    } else if (Array.isArray(req.body.name) && req.body.name.length > 0) {
      datasetName = String(req.body.name[0]).trim();
    }

    if (datasetName.length > 120) {
      return res
        .status(400)
        .json({
          success: false,
          error: "Dataset name must be 120 characters or fewer",
        });
    }

    if (!datasetName) {
      datasetName = originalName.replace(/\.(csv|xlsx)$/i, "");
    }

    const dedupeStrategy =
      req.body.dedupeStrategy === "rename" ? "rename" : "skip";

    let taxonomyId = null;
    let taxonomyName = null;
    if (req.body.taxonomyId) {
      let tid;
      try {
        tid = new ObjectId(req.body.taxonomyId);
      } catch {
        tid = null;
      }
      if (!tid) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid taxonomyId" });
      }
      const tax = await Taxonomy.findById(tid);
      if (!tax || !tax.isActive) {
        return res
          .status(404)
          .json({ success: false, error: "Taxonomy not found or inactive" });
      }
      taxonomyId = tid;
      taxonomyName = tax.name;
    }

    const checksum = crypto
      .createHash("sha256")
      .update(req.file.buffer)
      .digest("hex");
    const uploadedBy = new ObjectId(req.user.userId);

    const datasetId = await importService.createDatasetRecord({
      name: datasetName,
      originalFileName: originalName,
      fileType,
      checksum,
      dedupeStrategy,
      taxonomyId,
      taxonomyName,
      uploadedBy,
    });

    await audit({
      action: "dataset.import_started",
      actor: req.user,
      targetType: "dataset",
      targetId: datasetId.toString(),
      metadata: {
        fileName: originalName,
        fileType,
        checksum,
        dedupeStrategy,
        datasetName,
        taxonomyId: taxonomyId ? taxonomyId.toString() : null,
        taxonomyName,
      },
    });

    res.status(202).json({
      success: true,
      message: "Import started. Poll the dataset to track progress.",
      datasetId,
      status: "pending",
      name: datasetName,
      taxonomyId: taxonomyId ? taxonomyId.toString() : null,
      taxonomyName,
    });

    importService
      .processImportInBackground({
        datasetId,
        fileBuffer: req.file.buffer,
        originalName,
        uploadedBy,
        dedupeStrategy,
      })
      .catch((err) => console.error("uncaught background error:", err));
  } catch (err) {
    next(err);
  }
}

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

async function getStats(req, res, next) {
  try {
    const stats = await datasetService.getStats();
    res.json({ success: true, stats });
  } catch (err) {
    next(err);
  }
}

async function list(req, res, next) {
  try {
    const datasets = await datasetService.listDatasets(req.query, req.user);
    res.json({ success: true, datasets });
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const result = await datasetService.getDataset(req.params.id, req.user);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

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
