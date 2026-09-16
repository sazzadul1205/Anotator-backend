const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const { parse } = require("csv-parse/sync");
const ExcelJS = require("exceljs");
const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

const router = express.Router();

// In-memory upload. Max 20 MB. Only CSV/XLSX.
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

// Cell value → plain string (handles richText / formula / hyperlink / Date)
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

// Parse .xlsx buffer
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

// Parse .csv buffer
function parseCsv(fileBuffer) {
  const rows = parse(fileBuffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
  return { sheetName: null, rows };
}

// Unified parser
async function parseFile(fileBuffer, originalName) {
  const isCsv = originalName.toLowerCase().endsWith(".csv");
  return isCsv ? parseCsv(fileBuffer) : parseXlsx(fileBuffer);
}

// Normalize row keys → { id, comment_text, sentiment, type }
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

// BACKGROUND WORKER
async function processImportInBackground({
  db,
  datasetId,
  fileBuffer,
  originalName,
  uploadedBy,
}) {
  const startedAt = new Date();

  try {
    // Mark as processing
    await db
      .collection("datasets")
      .updateOne(
        { _id: datasetId },
        { $set: { status: "processing", updatedAt: startedAt } },
      );

    // 1. Parse
    const { sheetName, rows } = await parseFile(fileBuffer, originalName);

    if (!rows.length) {
      throw new Error("File is empty");
    }

    // 2. Validate + build inserts
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

    // 3. Insert comments
    const inserted = await db
      .collection("comments")
      .insertMany(commentsToInsert);

    // 4. Insert version records
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

    // 5. Finalize
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

// POST /api/datasets/import ~ Import Dataset
router.post(
  "/import",
  verifyToken,
  verifyAdmin,
  upload.single("file"),
  async (req, res) => {
    try {
      // Check if a file was uploaded
      if (!req.file) {
        return res
          .status(400)
          .json({ success: false, error: "No file uploaded" });
      }

      // Parse file
      const originalName = req.file.originalname;
      const fileType = originalName.toLowerCase().endsWith(".csv")
        ? "csv"
        : "xlsx";

      // Check file type
      if (!["csv", "xlsx"].includes(fileType)) {
        return res
          .status(400)
          .json({ success: false, error: "Only .csv and .xlsx files allowed" });
      }

      // Check if file is empty
      if (!req.file.buffer || req.file.buffer.length === 0) {
        return res
          .status(400)
          .json({ success: false, error: "Uploaded file is empty" });
      }

      const db = getDB();
      // Generate checksum
      const checksum = crypto
        .createHash("sha256")
        .update(req.file.buffer)
        .digest("hex");

      const now = new Date();
      const uploadedBy = new ObjectId(req.user.userId);

      // Create dataset
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
        createdAt: now,
        updatedAt: now,
      });

      const datasetId = datasetResult.insertedId;

      // Response
      res.status(202).json({
        success: true,
        message: "Import started. Poll the dataset to track progress.",
        datasetId,
        status: "pending",
      });

      // Start Background Process
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

// GET /api/datasets ~ Get all Datasets
router.get("/", verifyToken, async (req, res) => {
  try {
    const db = getDB();

    const filter = {};
    if (req.query.status) filter.status = req.query.status;
    if (req.query.uploadedBy)
      filter.uploadedBy = new ObjectId(req.query.uploadedBy);

    // Annotators only see datasets assigned to them
    if (req.user.role !== "admin") {
      filter.assignedTo = new ObjectId(req.user.userId);
    }

    const datasets = await db
      .collection("datasets")
      .find(filter)
      .sort({ createdAt: -1 })
      .toArray();

    res.json({
      success: true,
      datasets,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/datasets/:id ~ Get Dataset By Id
router.get("/:id", verifyToken, async (req, res) => {
  try {
    const db = getDB();

    let datasetId;
    try {
      datasetId = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ success: false, error: "Invalid id" });
    }

    const dataset = await db.collection("datasets").findOne({ _id: datasetId });
    if (!dataset) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset not found" });
    }

    // Annotators can only view datasets assigned to them
    if (
      req.user.role !== "admin" &&
      (!dataset.assignedTo || dataset.assignedTo.toString() !== req.user.userId)
    ) {
      return res
        .status(403)
        .json({ success: false, error: "Not assigned to you" });
    }

    // Comment counts (only meaningful after import completes)
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

// PATCH /api/datasets/:id/assign ~ Assign dataset to a user (Admin)
router.patch("/:id/assign", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    let datasetId;
    try {
      datasetId = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ success: false, error: "Invalid id" });
    }

    const { assignedTo } = req.body;

    const dataset = await db.collection("datasets").findOne({ _id: datasetId });
    if (!dataset) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset not found" });
    }

    let newAssignee = null;
    if (assignedTo !== null && assignedTo !== undefined && assignedTo !== "") {
      try {
        newAssignee = new ObjectId(assignedTo);
      } catch {
        return res
          .status(400)
          .json({ success: false, error: "Invalid assignedTo" });
      }

      const user = await db.collection("users").findOne({ _id: newAssignee });
      if (!user) {
        return res
          .status(404)
          .json({ success: false, error: "Assignee not found" });
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

    res.json({
      success: true,
      message: newAssignee ? "Dataset assigned" : "Dataset unassigned",
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/datasets/:id/duplicate ~ Duplicate dataset + its comments
router.post("/:id/duplicate", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();

    let sourceId;
    try {
      sourceId = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ success: false, error: "Invalid id" });
    }

    const source = await db.collection("datasets").findOne({ _id: sourceId });
    if (!source) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset not found" });
    }

    const userId = new ObjectId(req.user.userId);
    const now = new Date();

    // Body can override the copy's name
    const newName =
      (req.body && typeof req.body.name === "string" && req.body.name.trim()) ||
      `${source.name} (copy)`;

    // 1. Create the new dataset row
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

    // 2. Copy every comment, remapping _id and datasetId
    const sourceComments = await db
      .collection("comments")
      .find({ datasetId: sourceId })
      .toArray();

    let copiedCount = 0;

    if (sourceComments.length > 0) {
      // Build the new comment documents with fresh _ids
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

      // 3. Copy every version, remapping commentId
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

// PATCH /api/datasets/:id ~ Update Dataset
router.patch("/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    const { name } = req.body;

    if (!name) {
      return res
        .status(400)
        .json({ success: false, error: "name is required" });
    }

    let datasetId;
    try {
      datasetId = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ success: false, error: "Invalid id" });
    }

    const result = await db
      .collection("datasets")
      .updateOne({ _id: datasetId }, { $set: { name, updatedAt: new Date() } });

    if (result.matchedCount === 0) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset not found" });
    }

    res.json({ success: true, message: "Dataset updated" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/datasets/:id ~ Delete Dataset
router.delete("/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    let datasetId;
    try {
      datasetId = new ObjectId(req.params.id);
    } catch {
      return res.status(400).json({ success: false, error: "Invalid id" });
    }

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
