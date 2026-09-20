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

/* ------------------------------------------------------------------ */
/* Multer                                                              */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Parsing helpers                                                     */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* Background worker                                                   */
/* ------------------------------------------------------------------ */

async function processImportInBackground({
  db,
  datasetId,
  fileBuffer,
  originalName,
  uploadedBy,
  dedupeStrategy = "skip",
}) {
  const startedAt = new Date();
  const CHUNK_SIZE = 1000;
  const datasets = db.collection("datasets");

  // Set progress fields
  const setProgress = async (patch) => {
    await datasets.updateOne(
      { _id: datasetId },
      {
        $set: {
          progress: { ...patch, updatedAt: new Date() },
          updatedAt: new Date(),
        },
      },
    );
  };

  // Bump progress.processed without touching the whole object
  const bumpProcessed = async (processed) => {
    await datasets.updateOne(
      { _id: datasetId },
      {
        $set: {
          "progress.processed": processed,
          "progress.updatedAt": new Date(),
          updatedAt: new Date(),
        },
      },
    );
  };

  try {
    /* ---------- Phase: parsing ---------- */
    await datasets.updateOne(
      { _id: datasetId },
      {
        $set: {
          status: "processing",
          progress: {
            phase: "parsing",
            startedAt,
            updatedAt: startedAt,
          },
          updatedAt: startedAt,
        },
      },
    );

    const { sheetName, rows } = await parseFile(fileBuffer, originalName);

    if (!rows.length) {
      throw new Error("File is empty");
    }

    /* ---------- Build the insert batch ---------- */
    const now = new Date();
    const commentsToInsert = [];
    let skipped = 0;
    let renamed = 0;
    const errors = [];
    const usedSourceIds = new Set();
    const rawSourceIds = new Set();

    // Pre-scan to know every raw sourceId — so our generated -dupN
    // won't collide with a real row in the file
    rows.forEach((raw) => {
      const r = normalizeRow(raw);
      const sid =
        r.id !== undefined && r.id !== null ? String(r.id).trim() : "";
      if (sid) rawSourceIds.add(sid);
    });

    function makeUniqueSourceId(baseId) {
      let n = 1;
      let candidate;
      do {
        candidate = `${baseId}-dup${n}`;
        n++;
        if (n > 10000) {
          candidate = `${baseId}-dup${Date.now()}-${Math.floor(
            Math.random() * 1e6,
          )}`;
          break;
        }
      } while (rawSourceIds.has(candidate) || usedSourceIds.has(candidate));
      return candidate;
    }

    rows.forEach((raw, idx) => {
      const row = normalizeRow(raw);

      let sourceId =
        row.id !== undefined && row.id !== null ? String(row.id).trim() : "";
      const text =
        typeof row.comment_text === "string" ? row.comment_text.trim() : "";

      if (!sourceId || !text) {
        skipped++;
        return;
      }

      if (usedSourceIds.has(sourceId)) {
        if (dedupeStrategy === "rename") {
          const newId = makeUniqueSourceId(sourceId);
          errors.push(
            `Row ${idx + 2}: duplicate id "${sourceId}" renamed to "${newId}"`,
          );
          sourceId = newId;
          renamed++;
        } else {
          skipped++;
          errors.push(`Row ${idx + 2}: duplicate id "${sourceId}" skipped`);
          return;
        }
      }
      usedSourceIds.add(sourceId);

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
      await datasets.updateOne(
        { _id: datasetId },
        {
          $set: {
            status: "failed",
            skippedRows: skipped,
            importError: "No valid rows found",
            importErrors: errors.slice(0, 20),
            progress: {
              phase: "failed",
              updatedAt: new Date(),
            },
            updatedAt: new Date(),
          },
        },
      );
      return;
    }

    /* ---------- Phase: inserting ---------- */
    const totalToInsert = commentsToInsert.length;
    await setProgress({
      phase: "inserting",
      processed: 0,
      total: totalToInsert,
      startedAt: new Date(),
    });

    // Chunked inserts so progress can update along the way.
    // `insertedIds` in the chunk result is keyed by the index INSIDE the chunk.
    const insertedPairs = []; // { commentId, originalIndex }

    for (let i = 0; i < commentsToInsert.length; i += CHUNK_SIZE) {
      const chunk = commentsToInsert.slice(i, i + CHUNK_SIZE);
      let chunkResult;

      try {
        chunkResult = await db
          .collection("comments")
          .insertMany(chunk, { ordered: false });
      } catch (err) {
        // Bulk insert with unique index failures still gives partial success
        chunkResult = err.result || { insertedIds: {} };
        if (err.writeErrors) {
          err.writeErrors.slice(0, 5).forEach((we) => {
            errors.push(
              `Insert: ${we.err?.errmsg || we.errmsg || "duplicate"}`,
            );
          });
        }
      }

      const idsMap = chunkResult.insertedIds || {};
      for (const [localIdx, commentId] of Object.entries(idsMap)) {
        insertedPairs.push({
          commentId,
          originalIndex: i + Number(localIdx),
        });
      }

      await bumpProcessed(Math.min(i + CHUNK_SIZE, totalToInsert));
    }

    /* ---------- Phase: versions ---------- */
    const versionsToInsert = insertedPairs.map(
      ({ commentId, originalIndex }) => {
        const c = commentsToInsert[originalIndex];
        return {
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
        };
      },
    );

    const totalVersions = versionsToInsert.length;
    await setProgress({
      phase: "versions",
      processed: 0,
      total: totalVersions,
      startedAt: new Date(),
    });

    for (let i = 0; i < versionsToInsert.length; i += CHUNK_SIZE) {
      const chunk = versionsToInsert.slice(i, i + CHUNK_SIZE);
      await db.collection("comment_versions").insertMany(chunk);
      await bumpProcessed(Math.min(i + CHUNK_SIZE, totalVersions));
    }

    /* ---------- Phase: finalizing ---------- */
    await setProgress({
      phase: "finalizing",
      processed: totalToInsert,
      total: totalToInsert,
      startedAt: new Date(),
    });

    const actuallyInserted = insertedPairs.length;
    const failedInserts = commentsToInsert.length - actuallyInserted;

    await datasets.updateOne(
      { _id: datasetId },
      {
        $set: {
          sheetName,
          totalRows: rows.length,
          importedRows: actuallyInserted,
          skippedRows: skipped + failedInserts,
          renamedRows: renamed,
          status: "completed",
          importErrors: errors.slice(0, 20),
          progress: {
            phase: "completed",
            processed: totalToInsert,
            total: totalToInsert,
            startedAt,
            updatedAt: new Date(),
          },
          updatedAt: new Date(),
        },
      },
    );

    console.log(
      `dataset ${datasetId} completed in ${Date.now() - startedAt.getTime()}ms` +
        ` (imported=${actuallyInserted}, skipped=${skipped}, renamed=${renamed})`,
    );
  } catch (err) {
    console.error(`dataset ${datasetId} failed:`, err.message);
    await datasets.updateOne(
      { _id: datasetId },
      {
        $set: {
          status: "failed",
          importError: err.message,
          progress: {
            phase: "failed",
            updatedAt: new Date(),
          },
          updatedAt: new Date(),
        },
      },
    );
  }
}

/* ------------------------------------------------------------------ */
/* Literal-path routes first                                           */
/* ------------------------------------------------------------------ */

/* ---------- Import ---------- */

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

      // ----- Validate name -----
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

      // ----- Validate dedupe strategy -----
      const dedupeStrategy =
        req.body.dedupeStrategy === "rename" ? "rename" : "skip";

      const db = getDB();
      const checksum = crypto
        .createHash("sha256")
        .update(req.file.buffer)
        .digest("hex");

      const now = new Date();
      const uploadedBy = new ObjectId(req.user.userId);

      const datasetResult = await db.collection("datasets").insertOne({
        name: datasetName,
        originalFileName: originalName,
        fileType,
        sheetName: null,
        checksum, // fingerprint, not used to reject
        totalRows: 0,
        importedRows: 0,
        skippedRows: 0,
        renamedRows: 0,
        dedupeStrategy,
        status: "pending",
        importError: null,
        importErrors: [],
        progress: {
          phase: "queued",
          startedAt: now,
          updatedAt: now,
        },
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
        metadata: {
          fileName: originalName,
          fileType,
          checksum,
          dedupeStrategy,
          datasetName,
        },
      });

      res.status(202).json({
        success: true,
        message: "Import started. Poll the dataset to track progress.",
        datasetId,
        status: "pending",
        name: datasetName,
      });

      // Fire-and-forget
      processImportInBackground({
        db,
        datasetId,
        fileBuffer: req.file.buffer,
        originalName,
        uploadedBy,
        dedupeStrategy,
      }).catch((err) => console.error("uncaught background error:", err));
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

/* ---------- Preview ---------- */

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
      const seenSourceIds = new Map();
      const duplicateIds = [];
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
          duplicateIds.push(sourceId);
          if (previewErrors.length < 10) {
            previewErrors.push(
              `Row ${idx + 2}: duplicate id "${sourceId}" (first at row ${
                seenSourceIds.get(sourceId) + 2
              })`,
            );
          }
          return;
        }
        seenSourceIds.set(sourceId, idx);
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

      const uniqueDuplicateIds = [...new Set(duplicateIds)];

      res.json({
        success: true,
        preview: {
          totalRows: rows.length,
          validRows: valid,
          missingIdOrText,
          duplicates,
          uniqueDuplicateCount: uniqueDuplicateIds.length,
          duplicateIds: uniqueDuplicateIds.slice(0, 20),
          fileName: originalName,
          suggestedName: originalName.replace(/\.(csv|xlsx)$/i, ""),
          checksum,
          sample,
          errors: previewErrors,
        },
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

/* ---------- Stats ---------- */

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

/* ---------- List ---------- */

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

/* ------------------------------------------------------------------ */
/* Parameterized routes                                                */
/* ------------------------------------------------------------------ */

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
      renamedRows: source.renamedRows || 0,
      dedupeStrategy: source.dedupeStrategy || "skip",
      status: "completed",
      importError: null,
      importErrors: [],
      progress: {
        phase: "completed",
        processed: source.importedRows,
        total: source.importedRows,
        startedAt: now,
        updatedAt: now,
      },
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
