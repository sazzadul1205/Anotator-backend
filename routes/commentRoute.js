const express = require("express");
const ExcelJS = require("exceljs");
const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

const router = express.Router();

router.use(verifyToken);

function toObjectId(id) {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

function buildCommentFilter(query) {
  const filter = {};

  if (query.datasetId) {
    const dsId = toObjectId(query.datasetId);
    if (dsId) filter.datasetId = dsId;
  }
  if (query.sentiment) filter.sentiment = query.sentiment;
  if (query.type) filter.type = query.type;
  if (query.assignedTo) {
    const uid = toObjectId(query.assignedTo);
    if (uid) filter.assignedTo = uid;
  }
  if (query.status) {
    filter.status = query.status;
  } else if (query.hideAnnotated === "true") {
    filter.status = { $ne: "annotated" };
  }
  if (query.search) {
    filter.commentText = { $regex: query.search, $options: "i" };
  }
  return filter;
}

// Returns null for admin (no restriction), else array of ObjectIds.
async function getAllowedDatasetIds(db, user) {
  if (user.role === "admin") return null;
  const datasets = await db
    .collection("datasets")
    .find({ assignedTo: new ObjectId(user.userId) }, { projection: { _id: 1 } })
    .toArray();
  return datasets.map((d) => d._id);
}

async function assertCanAccessComment(db, comment, user) {
  if (user.role === "admin") return true;
  const dataset = await db
    .collection("datasets")
    .findOne({ _id: comment.datasetId }, { projection: { assignedTo: 1 } });
  if (!dataset?.assignedTo) return false;
  return dataset.assignedTo.toString() === user.userId;
}

// List
router.get("/", async (req, res) => {
  try {
    const db = getDB();
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const skip = (page - 1) * limit;

    const filter = buildCommentFilter(req.query);

    // Scope annotators to their assigned datasets
    const allowedIds = await getAllowedDatasetIds(db, req.user);
    if (allowedIds !== null) {
      if (filter.datasetId) {
        if (!allowedIds.some((id) => id.equals(filter.datasetId))) {
          return res
            .status(403)
            .json({ success: false, error: "Not assigned to you" });
        }
      } else {
        filter.datasetId = { $in: allowedIds };
      }
    }

    const total = await db.collection("comments").countDocuments(filter);
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

// Create
router.post("/", async (req, res) => {
  try {
    const db = getDB();
    const { datasetId, sourceId, commentText, sentiment, type } = req.body;

    if (!datasetId || !sourceId || !commentText) {
      return res.status(400).json({
        success: false,
        error: "datasetId, sourceId and commentText are required",
      });
    }

    const dsId = toObjectId(datasetId);
    if (!dsId) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid datasetId" });
    }

    const dataset = await db.collection("datasets").findOne({ _id: dsId });
    if (!dataset) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset not found" });
    }

    // Annotators can only add to their own datasets
    if (req.user.role !== "admin") {
      if (
        !dataset.assignedTo ||
        dataset.assignedTo.toString() !== req.user.userId
      ) {
        return res
          .status(403)
          .json({ success: false, error: "Not assigned to you" });
      }
    }

    const trimmedSourceId = String(sourceId).trim();
    const trimmedText = String(commentText).trim();

    const duplicate = await db
      .collection("comments")
      .findOne({ datasetId: dsId, sourceId: trimmedSourceId });
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

    const now = new Date();

    let result;
    try {
      result = await db.collection("comments").insertOne({
        datasetId: dsId,
        sourceId: trimmedSourceId,
        commentText: trimmedText,
        sentiment: validSentiment,
        type: validType,
        status,
        assignedTo: null,
        assignedAt: null,
        assignedBy: null,
        annotatedBy: status === "annotated" ? userId : null,
        annotatedAt: status === "annotated" ? now : null,
        annotationNote: null,
        version: 1,
        createdBy: userId,
        updatedBy: userId,
        createdAt: now,
        updatedAt: now,
      });
    } catch (err) {
      if (err.code === 11000) {
        return res.status(409).json({
          success: false,
          error: "sourceId already exists in this dataset",
        });
      }
      throw err;
    }

    await db.collection("comment_versions").insertOne({
      commentId: result.insertedId,
      version: 1,
      snapshot: {
        commentText: trimmedText,
        sentiment: validSentiment,
        type: validType,
        status,
        assignedTo: null,
        annotatedBy: status === "annotated" ? userId : null,
        annotatedAt: status === "annotated" ? now : null,
        annotationNote: null,
      },
      changedFields: ["commentText", "sentiment", "type", "status"],
      changeType: "create",
      changedBy: userId,
      createdAt: now,
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

// Export
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

    const allowedIds = await getAllowedDatasetIds(db, req.user);
    if (allowedIds !== null) {
      if (filter.datasetId) {
        if (!allowedIds.some((id) => id.equals(filter.datasetId))) {
          return res
            .status(403)
            .json({ success: false, error: "Not assigned to you" });
        }
      } else {
        filter.datasetId = { $in: allowedIds };
      }
    }

    const comments = await db
      .collection("comments")
      .find(filter)
      .sort({ createdAt: 1 })
      .toArray();

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

      // Escape + neutralize formula injection
      const escapeCsv = (v) => {
        let s = v === null || v === undefined ? "" : String(v);
        // Formula injection guard
        if (/^[=+\-@]/.test(s)) s = "'" + s;
        if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      };

      const lines = [
        header.join(","),
        ...rows.map((r) => r.map(escapeCsv).join(",")),
      ];
      return res.send("\uFEFF" + lines.join("\r\n"));
    }

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

// Single comment
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

    if (!(await assertCanAccessComment(db, comment, req.user))) {
      return res
        .status(403)
        .json({ success: false, error: "Not assigned to you" });
    }

    res.json({ success: true, comment });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Update Comment
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

    if (!(await assertCanAccessComment(db, existing, req.user))) {
      return res
        .status(403)
        .json({ success: false, error: "Not assigned to you" });
    }

    const userId = new ObjectId(req.user.userId);
    const newVersion = existing.version + 1;
    const now = new Date();
    const newText = commentText.trim();

    await db.collection("comments").updateOne(
      { _id: id },
      {
        $set: {
          commentText: newText,
          version: newVersion,
          updatedBy: userId,
          updatedAt: now,
        },
      },
    );

    await db.collection("comment_versions").insertOne({
      commentId: id,
      version: newVersion,
      snapshot: {
        commentText: newText,
        sentiment: existing.sentiment,
        type: existing.type,
        status: existing.status,
        assignedTo: existing.assignedTo,
        annotatedBy: existing.annotatedBy,
        annotatedAt: existing.annotatedAt,
        annotationNote: existing.annotationNote,
      },
      changedFields: ["commentText"],
      changeType: "update",
      changedBy: userId,
      createdAt: now,
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

// 
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

    if (!(await assertCanAccessComment(db, existing, req.user))) {
      return res
        .status(403)
        .json({ success: false, error: "Not assigned to you" });
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
    const now = new Date();

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
          annotatedAt: now,
          version: newVersion,
          updatedBy: userId,
          updatedAt: now,
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
        annotatedAt: now,
        annotationNote: newNote,
      },
      changedFields: changed,
      changeType: "annotation",
      changedBy: userId,
      createdAt: now,
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

router.get("/:id/versions", async (req, res) => {
  try {
    const db = getDB();
    const id = toObjectId(req.params.id);
    if (!id)
      return res.status(400).json({ success: false, error: "Invalid id" });

    const comment = await db
      .collection("comments")
      .findOne({ _id: id }, { projection: { datasetId: 1 } });
    if (!comment) {
      return res
        .status(404)
        .json({ success: false, error: "Comment not found" });
    }
    if (!(await assertCanAccessComment(db, comment, req.user))) {
      return res
        .status(403)
        .json({ success: false, error: "Not assigned to you" });
    }

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

router.post("/:id/restore/:version", async (req, res) => {
  try {
    const db = getDB();
    const id = toObjectId(req.params.id);
    if (!id)
      return res.status(400).json({ success: false, error: "Invalid id" });

    const targetVersion = parseInt(req.params.version, 10);
    if (!targetVersion || targetVersion < 1) {
      return res.status(400).json({ success: false, error: "Invalid version" });
    }

    const existing = await db.collection("comments").findOne({ _id: id });
    if (!existing) {
      return res
        .status(404)
        .json({ success: false, error: "Comment not found" });
    }

    if (!(await assertCanAccessComment(db, existing, req.user))) {
      return res
        .status(403)
        .json({ success: false, error: "Not assigned to you" });
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
    const now = new Date();

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
          updatedAt: now,
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
      restoredFrom: targetVersion,
      changedBy: userId,
      createdAt: now,
    });

    res.json({
      success: true,
      message: `Restored from v${targetVersion}`,
      newVersion,
      restoredFrom: targetVersion,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Admin-only delete
router.delete("/:id", verifyAdmin, async (req, res) => {
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
