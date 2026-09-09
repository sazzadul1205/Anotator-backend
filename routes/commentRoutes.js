const express = require("express");
const router = express.Router();
const { getDB } = require("../config/db");
const { ObjectId } = require("mongodb");
const { authenticate, logRequest } = require("../middleware");

// Helper to check project access (could be moved to a helper file if desired)
const checkProjectAccess = async (projectId, userId, userRole) => {
  const db = getDB();
  const project = await db.collection("Projects").findOne({ _id: new ObjectId(projectId) });
  if (!project) return { hasAccess: false, project: null };
  const hasAccess = userRole === "Admin" || project.assignedTo.toString() === userId.toString();
  return { hasAccess, project };
};

/* GET COMMENTS (paginated, filtered) */
router.get("/projects/:projectId/comments", authenticate, logRequest, async (req, res) => {
  try {
    const db = getDB();
    const CommentsCollection = db.collection("Comments");
    const { projectId } = req.params;

    if (!ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, error: "Invalid project ID" });
    }

    const { hasAccess } = await checkProjectAccess(projectId, req.user.userId, req.user.role);
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
        pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      },
    });
  } catch (err) {
    console.error("Get comments error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch comments" });
  }
});

/* VALIDATE SINGLE COMMENT */
router.put("/comments/:commentId", authenticate, logRequest, async (req, res) => {
  try {
    const db = getDB();
    const CommentsCollection = db.collection("Comments");
    const ProjectsCollection = db.collection("Projects");
    const { commentId } = req.params;
    const { language, sentiment } = req.body;

    if (!ObjectId.isValid(commentId)) {
      return res.status(400).json({ success: false, error: "Invalid comment ID" });
    }

    const validLanguages = ["Bangla", "English", "Banglish", "Emoji", "Other"];
    const validSentiments = ["Positive", "Negative", "Neutral"];

    if (!language || !validLanguages.includes(language)) {
      return res.status(400).json({
        success: false,
        error: `Invalid language. Use: ${validLanguages.join(", ")}`,
      });
    }
    if (!sentiment || !validSentiments.includes(sentiment)) {
      return res.status(400).json({
        success: false,
        error: `Invalid sentiment. Use: ${validSentiments.join(", ")}`,
      });
    }

    const comment = await CommentsCollection.findOne({ _id: new ObjectId(commentId) });
    if (!comment) {
      return res.status(404).json({ success: false, error: "Comment not found" });
    }

    const { hasAccess, project } = await checkProjectAccess(
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

    const updateFields = {
      language,
      sentiment,
      isValidated: true,
      validatedBy: new ObjectId(req.user.userId),
      validatedByUsername: req.user.username,
      validatedAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await CommentsCollection.updateOne(
      { _id: new ObjectId(commentId) },
      { $set: updateFields }
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, error: "Comment not found" });
    }

    await ProjectsCollection.updateOne(
      { _id: new ObjectId(comment.projectId) },
      { $inc: { validatedCount: 1 }, $set: { updatedAt: new Date() } }
    );

    const updatedComment = await CommentsCollection.findOne({ _id: new ObjectId(commentId) });
    res.status(200).json({
      success: true,
      message: "Comment validated",
      data: updatedComment,
    });
  } catch (err) {
    console.error("Validate comment error:", err);
    res.status(500).json({ success: false, error: "Failed to validate comment" });
  }
});

/* GET UNVALIDATED COMMENTS COUNT */
router.get("/projects/:projectId/unvalidated-count", authenticate, logRequest, async (req, res) => {
  try {
    const db = getDB();
    const CommentsCollection = db.collection("Comments");
    const { projectId } = req.params;

    if (!ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, error: "Invalid project ID" });
    }

    const { hasAccess } = await checkProjectAccess(projectId, req.user.userId, req.user.role);
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
});

module.exports = router;