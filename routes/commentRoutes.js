// commentRoutes.js
const express = require("express");
const router = express.Router();
const { getDB } = require("../config/db");
const { ObjectId } = require("mongodb");
const { authenticate, logRequest } = require("../middleware");
const { recordChange } = require("../config/versioning");

const VALID_LANGUAGES = ["Bangla", "English", "Banglish", "Emoji", "Other"];
const VALID_SENTIMENTS = ["Positive", "Negative", "Neutral"];

const checkProjectAccess = async (projectId, userId, userRole) => {
  const db = getDB();
  const project = await db
    .collection("Projects")
    .findOne({ _id: new ObjectId(projectId) });
  if (!project) return { hasAccess: false, project: null };
  const hasAccess =
    userRole === "Admin" ||
    project.assignedTo.toString() === userId.toString();
  return { hasAccess, project };
};

/* GET COMMENTS (paginated, filtered) */
router.get(
  "/projects/:projectId/comments",
  authenticate,
  logRequest,
  async (req, res) => {
    try {
      const db = getDB();
      const CommentsCollection = db.collection("Comments");
      const { projectId } = req.params;

      if (!ObjectId.isValid(projectId)) {
        return res.status(400).json({ success: false, error: "Invalid project ID" });
      }

      const { hasAccess } = await checkProjectAccess(
        projectId,
        req.user.userId,
        req.user.role
      );
      if (!hasAccess) {
        return res.status(403).json({ success: false, error: "Access denied" });
      }

      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;
      const skip = (page - 1) * limit;

      const filter = { projectId: new ObjectId(projectId) };

      if (req.query.isValidated !== undefined) {
        filter.isValidated = req.query.isValidated === "true";
      }
      if (req.query.language) filter.language = req.query.language;
      if (req.query.sentiment) filter.sentiment = req.query.sentiment;
      if (req.query.search) {
        filter.text = { $regex: req.query.search, $options: "i" };
      }

      const [comments, total] = await Promise.all([
        CommentsCollection.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .toArray(),
        CommentsCollection.countDocuments(filter),
      ]);

      res.status(200).json({
        success: true,
        data: {
          comments,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
      });
    } catch (err) {
      console.error("Get comments error:", err);
      res.status(500).json({ success: false, error: "Failed to fetch comments" });
    }
  }
);

/* ✅ CREATE SINGLE COMMENT (manual add) */
router.post(
  "/projects/:projectId/comments",
  authenticate,
  logRequest,
  async (req, res) => {
    try {
      const db = getDB();
      const CommentsCollection = db.collection("Comments");
      const ProjectsCollection = db.collection("Projects");
      const { projectId } = req.params;
      const { text, externalId, language, sentiment } = req.body;

      if (!ObjectId.isValid(projectId)) {
        return res.status(400).json({ success: false, error: "Invalid project ID" });
      }
      if (!text || !String(text).trim()) {
        return res.status(400).json({ success: false, error: "Text is required" });
      }
      if (language && !VALID_LANGUAGES.includes(language)) {
        return res.status(400).json({ success: false, error: "Invalid language" });
      }
      if (sentiment && !VALID_SENTIMENTS.includes(sentiment)) {
        return res.status(400).json({ success: false, error: "Invalid sentiment" });
      }

      const { hasAccess, project } = await checkProjectAccess(
        projectId,
        req.user.userId,
        req.user.role
      );
      if (!hasAccess) {
        return res.status(403).json({ success: false, error: "Access denied" });
      }
      if (req.user.role === "Viewer") {
        return res.status(403).json({ success: false, error: "Viewers cannot add comments" });
      }

      const doc = {
        externalId: externalId || `manual_${Date.now()}`,
        text: String(text).trim(),
        projectId: new ObjectId(projectId),
        language: language || null,
        sentiment: sentiment || null,
        isValidated: !!(language && sentiment),
        validatedBy: language && sentiment ? new ObjectId(req.user.userId) : null,
        validatedByUsername: language && sentiment ? req.user.username : null,
        validatedAt: language && sentiment ? new Date() : null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      const result = await CommentsCollection.insertOne(doc);

      await ProjectsCollection.updateOne(
        { _id: new ObjectId(projectId) },
        {
          $inc: {
            totalComments: 1,
            ...(doc.isValidated ? { validatedCount: 1 } : {}),
          },
          $set: { updatedAt: new Date() },
        }
      );

      await recordChange({
        entityType: "Comment",
        entityId: result.insertedId,
        action: "create",
        after: doc,
        user: req.user,
        projectId,
      });

      res.status(201).json({
        success: true,
        message: "Comment created",
        data: { ...doc, _id: result.insertedId },
      });
    } catch (err) {
      console.error("Create comment error:", err);
      res.status(500).json({ success: false, error: "Failed to create comment" });
    }
  }
);

/* ✅ UPDATE COMMENT TEXT */
router.put(
  "/comments/:commentId/text",
  authenticate,
  logRequest,
  async (req, res) => {
    try {
      const db = getDB();
      const CommentsCollection = db.collection("Comments");
      const { commentId } = req.params;
      const { text } = req.body;

      if (!ObjectId.isValid(commentId)) {
        return res.status(400).json({ success: false, error: "Invalid comment ID" });
      }
      if (!text || !String(text).trim()) {
        return res.status(400).json({ success: false, error: "Text is required" });
      }

      const comment = await CommentsCollection.findOne({
        _id: new ObjectId(commentId),
      });
      if (!comment) {
        return res.status(404).json({ success: false, error: "Comment not found" });
      }

      const { hasAccess } = await checkProjectAccess(
        comment.projectId,
        req.user.userId,
        req.user.role
      );
      if (!hasAccess) {
        return res.status(403).json({ success: false, error: "Access denied" });
      }
      if (req.user.role === "Viewer") {
        return res.status(403).json({ success: false, error: "Viewers cannot edit" });
      }

      const before = { ...comment };
      await CommentsCollection.updateOne(
        { _id: new ObjectId(commentId) },
        { $set: { text: String(text).trim(), updatedAt: new Date() } }
      );
      const after = await CommentsCollection.findOne({
        _id: new ObjectId(commentId),
      });

      await recordChange({
        entityType: "Comment",
        entityId: commentId,
        action: "update",
        before,
        after,
        user: req.user,
        projectId: comment.projectId,
      });

      res.status(200).json({ success: true, message: "Comment updated", data: after });
    } catch (err) {
      console.error("Update comment text error:", err);
      res.status(500).json({ success: false, error: "Failed to update comment" });
    }
  }
);

/* ✅ DELETE SINGLE COMMENT */
router.delete(
  "/comments/:commentId",
  authenticate,
  logRequest,
  async (req, res) => {
    try {
      const db = getDB();
      const CommentsCollection = db.collection("Comments");
      const ProjectsCollection = db.collection("Projects");
      const { commentId } = req.params;

      if (!ObjectId.isValid(commentId)) {
        return res.status(400).json({ success: false, error: "Invalid comment ID" });
      }

      const comment = await CommentsCollection.findOne({
        _id: new ObjectId(commentId),
      });
      if (!comment) {
        return res.status(404).json({ success: false, error: "Comment not found" });
      }

      const { hasAccess } = await checkProjectAccess(
        comment.projectId,
        req.user.userId,
        req.user.role
      );
      if (!hasAccess) {
        return res.status(403).json({ success: false, error: "Access denied" });
      }
      if (req.user.role === "Viewer") {
        return res.status(403).json({ success: false, error: "Viewers cannot delete" });
      }

      await CommentsCollection.deleteOne({ _id: new ObjectId(commentId) });

      await ProjectsCollection.updateOne(
        { _id: comment.projectId },
        {
          $inc: {
            totalComments: -1,
            ...(comment.isValidated ? { validatedCount: -1 } : {}),
          },
          $set: { updatedAt: new Date() },
        }
      );

      await recordChange({
        entityType: "Comment",
        entityId: commentId,
        action: "delete",
        before: comment,
        user: req.user,
        projectId: comment.projectId,
      });

      res.status(200).json({ success: true, message: "Comment deleted" });
    } catch (err) {
      console.error("Delete comment error:", err);
      res.status(500).json({ success: false, error: "Failed to delete comment" });
    }
  }
);

/* VALIDATE SINGLE COMMENT */
router.put(
  "/comments/:commentId",
  authenticate,
  logRequest,
  async (req, res) => {
    try {
      const db = getDB();
      const CommentsCollection = db.collection("Comments");
      const ProjectsCollection = db.collection("Projects");
      const { commentId } = req.params;
      const { language, sentiment } = req.body;

      if (!ObjectId.isValid(commentId)) {
        return res.status(400).json({ success: false, error: "Invalid comment ID" });
      }
      if (!language || !VALID_LANGUAGES.includes(language)) {
        return res.status(400).json({
          success: false,
          error: `Invalid language. Use: ${VALID_LANGUAGES.join(", ")}`,
        });
      }
      if (!sentiment || !VALID_SENTIMENTS.includes(sentiment)) {
        return res.status(400).json({
          success: false,
          error: `Invalid sentiment. Use: ${VALID_SENTIMENTS.join(", ")}`,
        });
      }

      const comment = await CommentsCollection.findOne({
        _id: new ObjectId(commentId),
      });
      if (!comment) {
        return res.status(404).json({ success: false, error: "Comment not found" });
      }

      const { hasAccess } = await checkProjectAccess(
        comment.projectId,
        req.user.userId,
        req.user.role
      );
      if (!hasAccess) {
        return res.status(403).json({ success: false, error: "Access denied" });
      }
      if (req.user.role === "Viewer") {
        return res.status(403).json({ success: false, error: "Viewers cannot validate" });
      }
      if (comment.isValidated) {
        return res.status(400).json({ success: false, error: "Comment already validated" });
      }

      const before = { ...comment };
      const updateFields = {
        language,
        sentiment,
        isValidated: true,
        validatedBy: new ObjectId(req.user.userId),
        validatedByUsername: req.user.username,
        validatedAt: new Date(),
        updatedAt: new Date(),
      };

      await CommentsCollection.updateOne(
        { _id: new ObjectId(commentId) },
        { $set: updateFields }
      );

      await ProjectsCollection.updateOne(
        { _id: new ObjectId(comment.projectId) },
        { $inc: { validatedCount: 1 }, $set: { updatedAt: new Date() } }
      );

      const after = await CommentsCollection.findOne({
        _id: new ObjectId(commentId),
      });

      await recordChange({
        entityType: "Comment",
        entityId: commentId,
        action: "validate",
        before,
        after,
        user: req.user,
        projectId: comment.projectId,
      });

      res.status(200).json({
        success: true,
        message: "Comment validated",
        data: after,
      });
    } catch (err) {
      console.error("Validate comment error:", err);
      res.status(500).json({ success: false, error: "Failed to validate comment" });
    }
  }
);

/* ✅ BULK VALIDATE */
router.post(
  "/projects/:projectId/comments/bulk-validate",
  authenticate,
  logRequest,
  async (req, res) => {
    try {
      const db = getDB();
      const CommentsCollection = db.collection("Comments");
      const ProjectsCollection = db.collection("Projects");
      const { projectId } = req.params;
      const { items } = req.body; // [{ commentId, language, sentiment }, ...]

      if (!ObjectId.isValid(projectId)) {
        return res.status(400).json({ success: false, error: "Invalid project ID" });
      }
      if (!Array.isArray(items) || items.length === 0) {
        return res.status(400).json({ success: false, error: "items array required" });
      }

      const { hasAccess } = await checkProjectAccess(
        projectId,
        req.user.userId,
        req.user.role
      );
      if (!hasAccess) {
        return res.status(403).json({ success: false, error: "Access denied" });
      }
      if (req.user.role === "Viewer") {
        return res.status(403).json({ success: false, error: "Viewers cannot validate" });
      }

      let successCount = 0;
      const errors = [];

      for (const item of items) {
        try {
          const { commentId, language, sentiment } = item;
          if (!ObjectId.isValid(commentId)) {
            errors.push({ commentId, error: "Invalid comment ID" });
            continue;
          }
          if (!VALID_LANGUAGES.includes(language)) {
            errors.push({ commentId, error: "Invalid language" });
            continue;
          }
          if (!VALID_SENTIMENTS.includes(sentiment)) {
            errors.push({ commentId, error: "Invalid sentiment" });
            continue;
          }

          const comment = await CommentsCollection.findOne({
            _id: new ObjectId(commentId),
            projectId: new ObjectId(projectId),
          });
          if (!comment) {
            errors.push({ commentId, error: "Not found in project" });
            continue;
          }
          if (comment.isValidated) {
            errors.push({ commentId, error: "Already validated" });
            continue;
          }

          const before = { ...comment };
          const updateFields = {
            language,
            sentiment,
            isValidated: true,
            validatedBy: new ObjectId(req.user.userId),
            validatedByUsername: req.user.username,
            validatedAt: new Date(),
            updatedAt: new Date(),
          };
          await CommentsCollection.updateOne(
            { _id: new ObjectId(commentId) },
            { $set: updateFields }
          );
          const after = await CommentsCollection.findOne({
            _id: new ObjectId(commentId),
          });

          await recordChange({
            entityType: "Comment",
            entityId: commentId,
            action: "validate",
            before,
            after,
            user: req.user,
            projectId,
            metadata: { bulk: true },
          });

          successCount++;
        } catch (e) {
          errors.push({ commentId: item.commentId, error: e.message });
        }
      }

      if (successCount > 0) {
        await ProjectsCollection.updateOne(
          { _id: new ObjectId(projectId) },
          { $inc: { validatedCount: successCount }, $set: { updatedAt: new Date() } }
        );
      }

      res.status(200).json({
        success: true,
        message: `Validated ${successCount} of ${items.length}`,
        data: { successCount, failureCount: errors.length, errors },
      });
    } catch (err) {
      console.error("Bulk validate error:", err);
      res.status(500).json({ success: false, error: "Failed to bulk validate" });
    }
  }
);

/* GET UNVALIDATED COUNT */
router.get(
  "/projects/:projectId/unvalidated-count",
  authenticate,
  logRequest,
  async (req, res) => {
    try {
      const db = getDB();
      const CommentsCollection = db.collection("Comments");
      const { projectId } = req.params;

      if (!ObjectId.isValid(projectId)) {
        return res.status(400).json({ success: false, error: "Invalid project ID" });
      }
      const { hasAccess } = await checkProjectAccess(
        projectId,
        req.user.userId,
        req.user.role
      );
      if (!hasAccess) {
        return res.status(403).json({ success: false, error: "Access denied" });
      }

      const count = await CommentsCollection.countDocuments({
        projectId: new ObjectId(projectId),
        isValidated: false,
      });

      res.status(200).json({ success: true, data: { unvalidatedCount: count } });
    } catch (err) {
      console.error("Get unvalidated count error:", err);
      res.status(500).json({ success: false, error: "Failed to get count" });
    }
  }
);

module.exports = router;