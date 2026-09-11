// routes/commentRoute.js
const express = require("express");
const ExcelJS = require("exceljs");
const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();

// All comment routes require a valid token (admin or annotator).
router.use(verifyToken);

// Small helper: safely convert an id string to ObjectId.
function toObjectId(id) {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

// Helper: build the MongoDB filter from query params.
function buildCommentFilter(query) {
  const filter = {};

  if (query.datasetId) {
    const dsId = toObjectId(query.datasetId);
    if (dsId) filter.datasetId = dsId;
  }
  if (query.sentiment) filter.sentiment = query.sentiment;
  if (query.type) filter.type = query.type;
  if (query.status) filter.status = query.status;
  if (query.assignedTo) {
    const uid = toObjectId(query.assignedTo);
    if (uid) filter.assignedTo = uid;
  }
  if (query.search) {
    filter.commentText = { $regex: query.search, $options: "i" };
  }
  return filter;
}

// GET /api/comments
router.get("/", async (req, res) => {
  try {
    const db = getDB();
    const page = parseInt(req.query.page) || 1;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const skip = (page - 1) * limit;

    const filter = buildCommentFilter(req.query);

    const total = await db.collection("comments").countDocuments(filter);

    // Fetch comments
    const comments = await db
      .collection("comments")
      .find(filter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();

    res.json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      comments,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/comments
router.post("/", async (req, res) => {
  try {
    const db = getDB();
    const { datasetId, sourceId, commentText, sentiment, type } = req.body;

    // Ensure required fields are present
    if (!datasetId || !sourceId || !commentText) {
      return res.status(400).json({
        success: false,
        error: "datasetId, sourceId and commentText are required",
      });
    }

    // Ensure datasetId is valid
    const dsId = toObjectId(datasetId);
    if (!dsId) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid datasetId" });
    }

    // Ensure dataset exists
    const dataset = await db.collection("datasets").findOne({ _id: dsId });
    if (!dataset) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset not found" });
    }

    // Ensure sourceId is unique within the dataset
    const duplicate = await db
      .collection("comments")
      .findOne({ datasetId: dsId, sourceId: String(sourceId).trim() });
    if (duplicate) {
      return res.status(409).json({
        success: false,
        error: "sourceId already exists in this dataset",
      });
    }

    const userId = new ObjectId(req.user.userId);

    const validSentiment = ["positive", "negative", "neutral"].includes(
      sentiment,
    )
      ? sentiment
      : "unannotated";
    const validType = ["bangla", "english", "banglish"].includes(type)
      ? type
      : "unclassified";
    const status =
      validSentiment === "unannotated" || validType === "unclassified"
        ? "pending"
        : "annotated";

    // Create comment
    const result = await db.collection("comments").insertOne({
      datasetId: dsId,
      sourceId: String(sourceId).trim(),
      commentText: String(commentText).trim(),
      sentiment: validSentiment,
      type: validType,
      status,
      assignedTo: null,
      assignedAt: null,
      assignedBy: null,
      annotatedBy: status === "annotated" ? userId : null,
      annotatedAt: status === "annotated" ? new Date() : null,
      annotationNote: null,
      version: 1,
      createdBy: userId,
      updatedBy: userId,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    // Create initial version record
    await db.collection("comment_versions").insertOne({
      commentId: result.insertedId,
      version: 1,
      snapshot: {
        commentText: String(commentText).trim(),
        sentiment: validSentiment,
        type: validType,
        status,
        assignedTo: null,
        annotatedBy: status === "annotated" ? userId : null,
        annotatedAt: status === "annotated" ? new Date() : null,
        annotationNote: null,
      },
      changedFields: ["commentText", "sentiment", "type", "status"],
      changeType: "create",
      changedBy: userId,
      createdAt: new Date(),
    });

    res.status(201).json({
      success: true,
      message: "Comment created",
      commentId: result.insertedId,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/comments/export
router.get("/export", async (req, res) => {
  try {
    const db = getDB();
    const format = (req.query.format || "csv").toLowerCase();
    if (!["csv", "xlsx"].includes(format)) {
      return res
        .status(400)
        .json({ success: false, error: "format must be csv or xlsx" });
    }

    const filter = buildCommentFilter(req.query);

    const comments = await db
      .collection("comments")
      .find(filter)
      .sort({ createdAt: 1 })
      .toArray();

    // Column layout
    const header = [
      "id",
      "comment_text",
      "sentiment",
      "type",
      "status",
      "version",
      "annotatedAt",
    ];

    const rows = comments.map((c) => [
      c.sourceId,
      c.commentText,
      c.sentiment,
      c.type,
      c.status,
      c.version,
      c.annotatedAt ? new Date(c.annotatedAt).toISOString() : "",
    ]);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="comments-${timestamp}.csv"`,
      );

      // Manual CSV builder with proper escaping
      const escapeCsv = (v) => {
        const s = v === null || v === undefined ? "" : String(v);
        if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      };

      const lines = [
        header.join(","),
        ...rows.map((r) => r.map(escapeCsv).join(",")),
      ];
      // Prepend UTF-8 BOM so Excel opens Bangla correctly
      return res.send("\uFEFF" + lines.join("\r\n"));
    }

    // XLSX
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("comments");
    sheet.addRow(header);
    rows.forEach((r) => sheet.addRow(r));

    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="comments-${timestamp}.xlsx"`,
    );

    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/comments/:id
router.get("/:id", async (req, res) => {
  try {
    const db = getDB();
    const id = toObjectId(req.params.id);
    if (!id)
      return res.status(400).json({ success: false, error: "Invalid id" });

    const comment = await db.collection("comments").findOne({ _id: id });
    if (!comment) {
      return res
        .status(404)
        .json({ success: false, error: "Comment not found" });
    }

    res.json({ success: true, comment });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/comments/:id
router.patch("/:id", async (req, res) => {
  try {
    const db = getDB();
    const id = toObjectId(req.params.id);
    if (!id)
      return res.status(400).json({ success: false, error: "Invalid id" });

    const { commentText } = req.body;
    if (!commentText || typeof commentText !== "string") {
      return res
        .status(400)
        .json({ success: false, error: "commentText is required" });
    }

    const existing = await db.collection("comments").findOne({ _id: id });
    if (!existing) {
      return res
        .status(404)
        .json({ success: false, error: "Comment not found" });
    }

    const userId = new ObjectId(req.user.userId);
    const newVersion = existing.version + 1;

    const updated = {
      ...existing,
      commentText: commentText.trim(),
      version: newVersion,
      updatedBy: userId,
      updatedAt: new Date(),
    };

    await db.collection("comments").updateOne(
      { _id: id },
      {
        $set: {
          commentText: updated.commentText,
          version: newVersion,
          updatedBy: userId,
          updatedAt: new Date(),
        },
      },
    );

    // version record
    await db.collection("comment_versions").insertOne({
      commentId: id,
      version: newVersion,
      snapshot: {
        commentText: updated.commentText,
        sentiment: updated.sentiment,
        type: updated.type,
        status: updated.status,
        assignedTo: updated.assignedTo,
        annotatedBy: updated.annotatedBy,
        annotatedAt: updated.annotatedAt,
        annotationNote: updated.annotationNote,
      },
      changedFields: ["commentText"],
      changeType: "update",
      changedBy: userId,
      createdAt: new Date(),
    });

    res.json({
      success: true,
      message: "Comment updated",
      version: newVersion,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /api/comments/:id/annotation
router.patch("/:id/annotation", async (req, res) => {
  try {
    const db = getDB();
    const id = toObjectId(req.params.id);
    if (!id)
      return res.status(400).json({ success: false, error: "Invalid id" });

    const { sentiment, type, annotationNote } = req.body;

    const existing = await db.collection("comments").findOne({ _id: id });
    if (!existing) {
      return res
        .status(404)
        .json({ success: false, error: "Comment not found" });
    }

    const changed = [];

    let newSentiment = existing.sentiment;
    if (sentiment !== undefined) {
      if (
        !["positive", "negative", "neutral", "unannotated"].includes(sentiment)
      ) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid sentiment value" });
      }
      if (sentiment !== existing.sentiment) {
        newSentiment = sentiment;
        changed.push("sentiment");
      }
    }

    let newType = existing.type;
    if (type !== undefined) {
      if (!["bangla", "english", "banglish", "unclassified"].includes(type)) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid type value" });
      }
      if (type !== existing.type) {
        newType = type;
        changed.push("type");
      }
    }

    let newNote = existing.annotationNote;
    if (
      annotationNote !== undefined &&
      annotationNote !== existing.annotationNote
    ) {
      newNote = annotationNote;
      changed.push("annotationNote");
    }

    if (changed.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "Nothing to update" });
    }

    const userId = new ObjectId(req.user.userId);

    // status flips to "annotated" once both fields are set
    const fullyAnnotated =
      newSentiment !== "unannotated" && newType !== "unclassified";
    const newStatus = fullyAnnotated ? "annotated" : "pending";
    if (newStatus !== existing.status) changed.push("status");

    const newVersion = existing.version + 1;

    await db.collection("comments").updateOne(
      { _id: id },
      {
        $set: {
          sentiment: newSentiment,
          type: newType,
          annotationNote: newNote,
          status: newStatus,
          annotatedBy: userId,
          annotatedAt: new Date(),
          version: newVersion,
          updatedBy: userId,
          updatedAt: new Date(),
        },
      },
    );

    await db.collection("comment_versions").insertOne({
      commentId: id,
      version: newVersion,
      snapshot: {
        commentText: existing.commentText,
        sentiment: newSentiment,
        type: newType,
        status: newStatus,
        assignedTo: existing.assignedTo,
        annotatedBy: userId,
        annotatedAt: new Date(),
        annotationNote: newNote,
      },
      changedFields: changed,
      changeType: "annotation",
      changedBy: userId,
      createdAt: new Date(),
    });

    res.json({
      success: true,
      message: "Annotation saved",
      version: newVersion,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/comments/:id/versions
router.get("/:id/versions", async (req, res) => {
  try {
    const db = getDB();
    const id = toObjectId(req.params.id);
    if (!id)
      return res.status(400).json({ success: false, error: "Invalid id" });

    const versions = await db
      .collection("comment_versions")
      .find({ commentId: id })
      .sort({ version: -1 })
      .toArray();

    res.json({ success: true, total: versions.length, versions });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/comments/:id/restore/:version
router.post("/:id/restore/:version", async (req, res) => {
  try {
    const db = getDB();
    const id = toObjectId(req.params.id);
    if (!id)
      return res.status(400).json({ success: false, error: "Invalid id" });

    const targetVersion = parseInt(req.params.version);
    if (!targetVersion || targetVersion < 1) {
      return res.status(400).json({ success: false, error: "Invalid version" });
    }

    const existing = await db.collection("comments").findOne({ _id: id });
    if (!existing) {
      return res
        .status(404)
        .json({ success: false, error: "Comment not found" });
    }

    const versionRecord = await db.collection("comment_versions").findOne({
      commentId: id,
      version: targetVersion,
    });
    if (!versionRecord) {
      return res
        .status(404)
        .json({ success: false, error: "Version not found" });
    }

    const snap = versionRecord.snapshot;
    const userId = new ObjectId(req.user.userId);
    const newVersion = existing.version + 1;

    await db.collection("comments").updateOne(
      { _id: id },
      {
        $set: {
          commentText: snap.commentText,
          sentiment: snap.sentiment,
          type: snap.type,
          status: snap.status,
          annotationNote: snap.annotationNote,
          version: newVersion,
          updatedBy: userId,
          updatedAt: new Date(),
        },
      },
    );

    await db.collection("comment_versions").insertOne({
      commentId: id,
      version: newVersion,
      snapshot: {
        commentText: snap.commentText,
        sentiment: snap.sentiment,
        type: snap.type,
        status: snap.status,
        assignedTo: snap.assignedTo,
        annotatedBy: snap.annotatedBy,
        annotatedAt: snap.annotatedAt,
        annotationNote: snap.annotationNote,
      },
      changedFields: ["restore"],
      changeType: "restore",
      changedBy: userId,
      createdAt: new Date(),
    });

    res.json({
      success: true,
      message: `Restored to version ${targetVersion}`,
      newVersion,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/comments/:id
router.delete("/:id", async (req, res) => {
  try {
    const db = getDB();
    const id = toObjectId(req.params.id);
    if (!id)
      return res.status(400).json({ success: false, error: "Invalid id" });

    const comment = await db.collection("comments").findOne({ _id: id });
    if (!comment) {
      return res
        .status(404)
        .json({ success: false, error: "Comment not found" });
    }

    await db.collection("comment_versions").deleteMany({ commentId: id });
    await db.collection("comments").deleteOne({ _id: id });

    res.json({ success: true, message: "Comment deleted" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
