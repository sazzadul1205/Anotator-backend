// controllers/commentController.js
// Thin HTTP wrappers around commentService.
// No DB access, no filter building, no ObjectId.

const commentService = require("../services/commentService");

/**
 * GET /api/comments
 * Paginated list of comments, scoped by role.
 */
async function list(req, res, next) {
  try {
    const result = await commentService.listComments(req.query, req.user);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/comments
 * Create a new comment.
 */
async function create(req, res, next) {
  try {
    const result = await commentService.createComment(req.body, req.user);
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/comments/bulk-annotate
 * Apply the same annotation to up to 200 comments.
 */
async function bulkAnnotate(req, res, next) {
  try {
    const result = await commentService.bulkAnnotate(req.body, req.user);
    res.json({ success: true, message: "Bulk annotation applied", ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/comments/bulk-assign
 * Assign or unassign up to 500 comments.
 */
async function bulkAssign(req, res, next) {
  try {
    const result = await commentService.bulkAssign(req.body, req.user);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/comments/export?format=csv|xlsx
 * Streams CSV or XLSX of the filtered comments.
 * The service returns { contentType, filename, body } — controller just sends.
 */
async function exportComments(req, res, next) {
  try {
    const format = (req.query.format || "csv").toLowerCase();
    const result = await commentService.exportComments({
      query: req.query,
      user: req.user,
      format,
    });

    res.setHeader("Content-Type", result.contentType);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${result.filename}"`,
    );
    res.send(result.body);
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/comments/:id
 * Fetch a single comment.
 */
async function getOne(req, res, next) {
  try {
    const comment = await commentService.getComment(req.params.id, req.user);
    res.json({ success: true, comment });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/comments/:id/text
 * Update only the comment's text.
 */
async function updateText(req, res, next) {
  try {
    const result = await commentService.updateCommentText(
      req.params.id,
      req.body.commentText,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/comments/:id/annotate
 * Save an annotation (sentiment and/or type and/or note).
 */
async function annotate(req, res, next) {
  try {
    const result = await commentService.annotateComment(
      req.params.id,
      req.body,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/comments/:id/versions
 * Paginated version history.
 */
async function getVersions(req, res, next) {
  try {
    const result = await commentService.getCommentVersions(
      req.params.id,
      req.query,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/comments/:id/versions/:version/restore
 * Restore a previous version. Writes a new version snapshot.
 */
async function restoreVersion(req, res, next) {
  try {
    const targetVersion = parseInt(req.params.version, 10);
    if (!targetVersion || targetVersion < 1) {
      return res.status(400).json({ success: false, error: "Invalid version" });
    }
    const result = await commentService.restoreCommentVersion(
      req.params.id,
      targetVersion,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * DELETE /api/comments/:id
 * Delete a comment and its version history.
 */
async function remove(req, res, next) {
  try {
    const result = await commentService.deleteComment(req.params.id, req.user);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  list,
  create,
  bulkAnnotate,
  bulkAssign,
  exportComments,
  getOne,
  updateText,
  annotate,
  getVersions,
  restoreVersion,
  remove,
};
