const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const { parse } = require("csv-parse/sync");
const ExcelJS = require("exceljs");
const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");
const { verifyToken, verifyAdmin } = require("../middleware/auth");
const { audit } = require("../utils/audit");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      file.mimetype === "text/csv" ||
      file.mimetype ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.originalname.match(/\.(csv|xlsx)$/i);
    if (!ok) return cb(new Error("Only .csv and .xlsx files allowed"));
    cb(null, true);
  },
});

function cellToString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value instanceof Date) return value.toISOString();

  if (typeof value === "object") {
    if (Array.isArray(value.richText)) {
      return value.richText.map((rt) => rt.text || "").join("");
    }
    if (value.result !== undefined) return cellToString(value.result);
    if (value.text) return String(value.text);
  }
  return String(value);
}

async function parseXlsx(fileBuffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer);

  const worksheet =
    workbook.worksheets.find((w) => w.name.toLowerCase() === "cmt") ||
    workbook.worksheets[0];

  if (!worksheet) return { sheetName: null, rows: [] };

  const headerRow = worksheet.getRow(1);
  const headers = {};
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const header = cellToString(cell.value).trim();
    if (header) headers[colNumber] = header;
  });

  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = {};
    Object.keys(headers).forEach((colNumber) => {
      const header = headers[colNumber];
      const cell = row.getCell(Number(colNumber));
      obj[header] = cellToString(cell.value);
    });
    rows.push(obj);
  });

  return { sheetName: worksheet.name, rows };
}

function parseCsv(fileBuffer) {
  const rows = parse(fileBuffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
  return { sheetName: null, rows };
}

async function parseFile(fileBuffer, originalName) {
  const isCsv = originalName.toLowerCase().endsWith(".csv");
  return isCsv ? parseCsv(fileBuffer) : parseXlsx(fileBuffer);
}

function normalizeRow(row) {
  const out = {};
  for (const key of Object.keys(row)) {
    const k = key.toLowerCase().replace(/[\s_]/g, "");
    if (k === "id") out.id = row[key];
    else if (k === "commenttext" || k === "comment" || k === "text")
      out.comment_text = row[key];
    else if (k === "sentiment") out.sentiment = row[key];
    else if (k === "type") out.type = row[key];
  }
  return out;
}

async function processImportInBackground({
  db,
  datasetId,
  fileBuffer,
  originalName,
  uploadedBy,
}) {
  const startedAt = new Date();

  try {
    await db
      .collection("datasets")
      .updateOne(
        { _id: datasetId },
        { $set: { status: "processing", updatedAt: startedAt } },
      );

    const { sheetName, rows } = await parseFile(fileBuffer, originalName);

    if (!rows.length) {
      throw new Error("File is empty");
    }

    const now = new Date();
    const commentsToInsert = [];
    let skipped = 0;
    const errors = [];
    const seenSourceIds = new Set();

    rows.forEach((raw, idx) => {
      const row = normalizeRow(raw);

      const sourceId =
        row.id !== undefined && row.id !== null ? String(row.id).trim() : "";
      const text =
        typeof row.comment_text === "string" ? row.comment_text.trim() : "";

      if (!sourceId || !text) {
        skipped++;
        return;
      }

      if (seenSourceIds.has(sourceId)) {
        skipped++;
        errors.push(`Row ${idx + 2}: duplicate id "${sourceId}"`);
        return;
      }
      seenSourceIds.add(sourceId);

      const rawSentiment = (row.sentiment || "").toLowerCase().trim();
      const rawType = (row.type || "").toLowerCase().trim();
      const sentiment = ["positive", "negative", "neutral"].includes(
        rawSentiment,
      )
        ? rawSentiment
        : "unannotated";
      const type = ["bangla", "english", "banglish"].includes(rawType)
        ? rawType
        : "unclassified";
      const status =
        sentiment === "unannotated" || type === "unclassified"
          ? "pending"
          : "annotated";

      commentsToInsert.push({
        datasetId,
        sourceId,
        commentText: text,
        sentiment,
        type,
        status,
        assignedTo: null,
        assignedAt: null,
        assignedBy: null,
        annotatedBy: status === "annotated" ? uploadedBy : null,
        annotatedAt: status === "annotated" ? now : null,
        annotationNote: null,
        version: 1,
        createdBy: uploadedBy,
        updatedBy: uploadedBy,
        createdAt: now,
        updatedAt: now,
      });
    });

    if (commentsToInsert.length === 0) {
      await db.collection("datasets").updateOne(
        { _id: datasetId },
        {
          $set: {
            status: "failed",
            skippedRows: skipped,
            importError: "No valid rows found",
            importErrors: errors.slice(0, 20),
            updatedAt: new Date(),
          },
        },
      );
      return;
    }

    const inserted = await db
      .collection("comments")
      .insertMany(commentsToInsert);

    const versionsToInsert = [];
    if (inserted.insertedIds) {
      Object.values(inserted.insertedIds).forEach((commentId, i) => {
        const c = commentsToInsert[i];
        versionsToInsert.push({
          commentId,
          version: 1,
          snapshot: {
            commentText: c.commentText,
            sentiment: c.sentiment,
            type: c.type,
            status: c.status,
            assignedTo: c.assignedTo,
            annotatedBy: c.annotatedBy,
            annotatedAt: c.annotatedAt,
            annotationNote: c.annotationNote,
          },
          changedFields: ["commentText", "sentiment", "type", "status"],
          changeType: "import",
          changedBy: uploadedBy,
          createdAt: now,
        });
      });
    }
    if (versionsToInsert.length) {
      await db.collection("comment_versions").insertMany(versionsToInsert);
    }

    await db.collection("datasets").updateOne(
      { _id: datasetId },
      {
        $set: {
          sheetName,
          totalRows: rows.length,
          importedRows: commentsToInsert.length,
          skippedRows: skipped,
          status: "completed",
          importErrors: errors.slice(0, 20),
          updatedAt: new Date(),
        },
      },
    );

    console.log(
      `dataset ${datasetId} completed in ${Date.now() - startedAt.getTime()}ms`,
    );
  } catch (err) {
    console.error(`dataset ${datasetId} failed:`, err.message);
    await db.collection("datasets").updateOne(
      { _id: datasetId },
      {
        $set: {
          status: "failed",
          importError: err.message,
          updatedAt: new Date(),
        },
      },
    );
  }
}

// ---------------------------------------------------------------------------
// Literal-path routes first
// ---------------------------------------------------------------------------

// --- Import ---

router.post(
  "/import",
  verifyToken,
  verifyAdmin,
  upload.single("file"),
  async (req, res) => {
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

      const db = getDB();
      const checksum = crypto
        .createHash("sha256")
        .update(req.file.buffer)
        .digest("hex");

      const existing = await db
        .collection("datasets")
        .findOne({ checksum }, { projection: { _id: 1, name: 1 } });
      if (existing) {
        return res.status(409).json({
          success: false,
          error: "This exact file has already been imported",
          datasetId: existing._id,
        });
      }

      const now = new Date();
      const uploadedBy = new ObjectId(req.user.userId);

      const datasetResult = await db.collection("datasets").insertOne({
        name: req.body.name || originalName.replace(/\.(csv|xlsx)$/i, ""),
        originalFileName: originalName,
        fileType,
        sheetName: null,
        checksum,
        totalRows: 0,
        importedRows: 0,
        skippedRows: 0,
        status: "pending",
        importError: null,
        importErrors: [],
        uploadedBy,
        assignedTo: null,
        assignedAt: null,
        createdAt: now,
        updatedAt: now,
      });

      const datasetId = datasetResult.insertedId;

      await audit({
        action: "dataset.import_started",
        actor: req.user,
        targetType: "dataset",
        targetId: datasetId.toString(),
        metadata: { fileName: originalName, fileType, checksum },
      });

      res.status(202).json({
        success: true,
        message: "Import started. Poll the dataset to track progress.",
        datasetId,
        status: "pending",
      });

      processImportInBackground({
        db,
        datasetId,
        fileBuffer: req.file.buffer,
        originalName,
        uploadedBy,
      }).catch((err) => console.error("uncaught background error:", err));
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

// --- Preview ---

router.post(
  "/preview",
  verifyToken,
  verifyAdmin,
  upload.single("file"),
  async (req, res) => {
    try {
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, error: "No file uploaded" });
      }

      const originalName = req.file.originalname;
      const { rows } = await parseFile(req.file.buffer, originalName);

      if (!rows.length) {
        return res.status(400).json({ success: false, error: "File is empty" });
      }

      const sample = [];
      const seenSourceIds = new Set();
      let valid = 0;
      let missingIdOrText = 0;
      let duplicates = 0;
      const previewErrors = [];

      rows.forEach((raw, idx) => {
        const row = normalizeRow(raw);
        const sourceId =
          row.id !== undefined && row.id !== null ? String(row.id).trim() : "";
        const text =
          typeof row.comment_text === "string" ? row.comment_text.trim() : "";

        if (!sourceId || !text) {
          missingIdOrText++;
          return;
        }
        if (seenSourceIds.has(sourceId)) {
          duplicates++;
          if (previewErrors.length < 10) {
            previewErrors.push(`Row ${idx + 2}: duplicate id "${sourceId}"`);
          }
          return;
        }
        seenSourceIds.add(sourceId);
        valid++;

        if (sample.length < 10) {
          sample.push({
            sourceId,
            commentText: text.length > 200 ? text.slice(0, 200) + "…" : text,
            sentiment: row.sentiment || null,
            type: row.type || null,
          });
        }
      });

      const checksum = crypto
        .createHash("sha256")
        .update(req.file.buffer)
        .digest("hex");

      const db = getDB();
      const existingDataset = await db
        .collection("datasets")
        .findOne({ checksum }, { projection: { _id: 1, name: 1 } });

      res.json({
        success: true,
        preview: {
          totalRows: rows.length,
          validRows: valid,
          missingIdOrText,
          duplicates,
          fileName: originalName,
          checksum,
          sample,
          errors: previewErrors,
          alreadyImported: existingDataset
            ? {
                datasetId: existingDataset._id,
                name: existingDataset.name,
              }
            : null,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

// --- Stats (dashboard) ---

router.get("/stats", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    const now = new Date();
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    const [
      totalDatasets,
      totalComments,
      annotatedComments,
      pendingComments,
      activeAnnotators,
      datasetsByStatus,
      recentComments,
    ] = await Promise.all([
      db.collection("datasets").countDocuments({}),
      db.collection("comments").countDocuments({}),
      db.collection("comments").countDocuments({ status: "annotated" }),
      db.collection("comments").countDocuments({ status: "pending" }),
      db
        .collection("users")
        .countDocuments({ role: "annotator", isActive: true }),
      db
        .collection("datasets")
        .aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }])
        .toArray(),
      db
        .collection("comment_versions")
        .aggregate([
          { $match: { createdAt: { $gte: sevenDaysAgo } } },
          {
            $group: {
              _id: {
                $dateToString: { format: "%Y-%m-%d", date: "$createdAt" },
              },
              count: { $sum: 1 },
            },
          },
          { $sort: { _id: 1 } },
        ])
        .toArray(),
    ]);

    const statusMap = { pending: 0, processing: 0, completed: 0, failed: 0 };
    datasetsByStatus.forEach((s) => {
      statusMap[s._id] = s.count;
    });

    const percentAnnotated =
      totalComments === 0
        ? 0
        : Math.round((annotatedComments / totalComments) * 1000) / 10;

    res.json({
      success: true,
      stats: {
        totalDatasets,
        totalComments,
        annotatedComments,
        pendingComments,
        activeAnnotators,
        percentAnnotated,
        datasetsByStatus: statusMap,
        activityLast7Days: recentComments.map((r) => ({
          date: r._id,
          count: r.count,
        })),
      },
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- List (with optional counts) ---

router.get("/", verifyToken, async (req, res) => {
  try {
    const db = getDB();

    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.uploadedBy && ObjectId.isValid(req.query.uploadedBy)) {
      filter.uploadedBy = new ObjectId(req.query.uploadedBy);
    }
    if (req.user.role !== "admin") {
      filter.assignedTo = new ObjectId(req.user.userId);
    }

    const includeCounts = req.query.includeCounts === "true";

    if (!includeCounts) {
      const datasets = await db
        .collection("datasets")
        .find(filter)
        .sort({ createdAt: -1 })
        .toArray();
      return res.json({ success: true, datasets });
    }

    const datasets = await db
      .collection("datasets")
      .aggregate([
        { $match: filter },
        { $sort: { createdAt: -1 } },
        {
          $lookup: {
            from: "comments",
            let: { dsId: "$_id" },
            pipeline: [
              { $match: { $expr: { $eq: ["$datasetId", "$$dsId"] } } },
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  annotated: {
                    $sum: { $cond: [{ $eq: ["$status", "annotated"] }, 1, 0] },
                  },
                  pending: {
                    $sum: { $cond: [{ $eq: ["$status", "pending"] }, 1, 0] },
                  },
                },
              },
            ],
            as: "counts",
          },
        },
        {
          $addFields: {
            summary: {
              $ifNull: [
                { $arrayElemAt: ["$counts", 0] },
                { total: 0, annotated: 0, pending: 0 },
              ],
            },
          },
        },
        { $project: { counts: 0 } },
      ])
      .toArray();

    const cleaned = datasets.map((d) => ({
      ...d,
      summary: {
        total: d.summary.total,
        annotated: d.summary.annotated,
        pending: d.summary.pending,
      },
    }));

    res.json({ success: true, datasets: cleaned });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Parameterized routes
// ---------------------------------------------------------------------------

router.get("/:id", verifyToken, async (req, res) => {
  try {
    const db = getDB();

    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: "Invalid id" });
    }
    const datasetId = new ObjectId(req.params.id);

    const dataset = await db.collection("datasets").findOne({ _id: datasetId });
    if (!dataset) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset not found" });
    }

    if (
      req.user.role !== "admin" &&
      (!dataset.assignedTo || dataset.assignedTo.toString() !== req.user.userId)
    ) {
      return res
        .status(403)
        .json({ success: false, error: "Not assigned to you" });
    }

    let summary = { total: 0, pending: 0, annotated: 0 };
    if (dataset.status === "completed") {
      const [total, pending, annotated] = await Promise.all([
        db.collection("comments").countDocuments({ datasetId }),
        db
          .collection("comments")
          .countDocuments({ datasetId, status: "pending" }),
        db
          .collection("comments")
          .countDocuments({ datasetId, status: "annotated" }),
      ]);
      summary = { total, pending, annotated };
    }

    res.json({ success: true, dataset, summary });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch("/:id/assign", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: "Invalid id" });
    }
    const datasetId = new ObjectId(req.params.id);

    const { assignedTo } = req.body;

    const dataset = await db.collection("datasets").findOne({ _id: datasetId });
    if (!dataset) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset not found" });
    }

    let newAssignee = null;
    if (assignedTo !== null && assignedTo !== undefined && assignedTo !== "") {
      if (!ObjectId.isValid(assignedTo)) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid assignedTo" });
      }
      newAssignee = new ObjectId(assignedTo);

      const user = await db.collection("users").findOne({ _id: newAssignee });
      if (!user) {
        return res
          .status(404)
          .json({ success: false, error: "Assignee not found" });
      }
      if (!user.isActive) {
        return res
          .status(400)
          .json({ success: false, error: "Assignee is inactive" });
      }
    }

    await db.collection("datasets").updateOne(
      { _id: datasetId },
      {
        $set: {
          assignedTo: newAssignee,
          assignedAt: newAssignee ? new Date() : null,
          updatedAt: new Date(),
        },
      },
    );

    await audit({
      action: newAssignee ? "dataset.assign" : "dataset.unassign",
      actor: req.user,
      targetType: "dataset",
      targetId: datasetId.toString(),
      metadata: { assignedTo: newAssignee?.toString() || null },
    });

    res.json({
      success: true,
      message: newAssignee ? "Dataset assigned" : "Dataset unassigned",
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/:id/duplicate", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: "Invalid id" });
    }
    const sourceId = new ObjectId(req.params.id);

    const source = await db.collection("datasets").findOne({ _id: sourceId });
    if (!source) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset not found" });
    }

    const userId = new ObjectId(req.user.userId);
    const now = new Date();

    const newName =
      (req.body && typeof req.body.name === "string" && req.body.name.trim()) ||
      `${source.name} (copy)`;

    const newDataset = {
      name: newName,
      originalFileName: source.originalFileName,
      fileType: source.fileType,
      sheetName: source.sheetName,
      checksum: source.checksum,
      totalRows: source.totalRows,
      importedRows: source.importedRows,
      skippedRows: source.skippedRows,
      status: "completed",
      importError: null,
      importErrors: [],
      uploadedBy: userId,
      assignedTo: null,
      assignedAt: null,
      createdAt: now,
      updatedAt: now,
      duplicatedFrom: sourceId,
    };

    const dsResult = await db.collection("datasets").insertOne(newDataset);
    const newDatasetId = dsResult.insertedId;

    const sourceComments = await db
      .collection("comments")
      .find({ datasetId: sourceId })
      .toArray();

    let copiedCount = 0;

    if (sourceComments.length > 0) {
      const idMap = new Map();

      const newComments = sourceComments.map((c) => {
        const newId = new ObjectId();
        idMap.set(c._id.toString(), newId);
        copiedCount++;

        return {
          ...c,
          _id: newId,
          datasetId: newDatasetId,
          createdBy: userId,
          updatedBy: userId,
          createdAt: now,
          updatedAt: now,
        };
      });

      await db.collection("comments").insertMany(newComments);

      const sourceVersions = await db
        .collection("comment_versions")
        .find({ commentId: { $in: sourceComments.map((c) => c._id) } })
        .toArray();

      if (sourceVersions.length > 0) {
        const newVersions = sourceVersions
          .map((v) => {
            const mappedCommentId = idMap.get(v.commentId.toString());
            if (!mappedCommentId) return null;
            return {
              ...v,
              _id: new ObjectId(),
              commentId: mappedCommentId,
              changedBy: userId,
              createdAt: now,
            };
          })
          .filter(Boolean);

        if (newVersions.length > 0) {
          await db.collection("comment_versions").insertMany(newVersions);
        }
      }
    }

    await audit({
      action: "dataset.duplicate",
      actor: req.user,
      targetType: "dataset",
      targetId: newDatasetId.toString(),
      metadata: {
        sourceId: sourceId.toString(),
        copiedComments: copiedCount,
      },
    });

    res.status(201).json({
      success: true,
      message: "Dataset duplicated",
      datasetId: newDatasetId,
      copiedComments: copiedCount,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.patch("/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    const { name } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return res
        .status(400)
        .json({ success: false, error: "name is required" });
    }

    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: "Invalid id" });
    }
    const datasetId = new ObjectId(req.params.id);

    const result = await db
      .collection("datasets")
      .updateOne(
        { _id: datasetId },
        { $set: { name: name.trim(), updatedAt: new Date() } },
      );

    if (result.matchedCount === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset not found" });
    }

    await audit({
      action: "dataset.rename",
      actor: req.user,
      targetType: "dataset",
      targetId: datasetId.toString(),
      metadata: { name: name.trim() },
    });

    res.json({ success: true, message: "Dataset updated" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.delete("/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: "Invalid id" });
    }
    const datasetId = new ObjectId(req.params.id);

    const dataset = await db.collection("datasets").findOne({ _id: datasetId });
    if (!dataset) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset not found" });
    }

    const comments = await db
      .collection("comments")
      .find({ datasetId }, { projection: { _id: 1 } })
      .toArray();
    const commentIds = comments.map((c) => c._id);

    if (commentIds.length) {
      await db
        .collection("comment_versions")
        .deleteMany({ commentId: { $in: commentIds } });
      await db.collection("comments").deleteMany({ datasetId });
    }
    await db.collection("datasets").deleteOne({ _id: datasetId });

    await audit({
      action: "dataset.delete",
      actor: req.user,
      targetType: "dataset",
      targetId: datasetId.toString(),
      metadata: {
        name: dataset.name,
        deletedComments: commentIds.length,
      },
    });

    res.json({
      success: true,
      message: "Dataset and all related data deleted",
      deletedComments: commentIds.length,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
