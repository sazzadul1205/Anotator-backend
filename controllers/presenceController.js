// controllers/presenceController.js
// Thin HTTP wrappers around presenceService.

const presenceService = require("../services/presenceService");

/**
 * POST /api/presence/heartbeat
 * Any authenticated user. Returns the interval to use next.
 */
async function heartbeat(req, res, next) {
  try {
    const { sessionKey, state, action, targetType, targetId } = req.body;
    if (!sessionKey) {
      const err = new Error("sessionKey is required");
      err.status = 400;
      throw err;
    }
    const result = await presenceService.heartbeat({
      user: req.user,
      sessionKey,
      state,
      action,
      targetType,
      targetId,
      ip: req.ip,
      userAgent: req.headers["user-agent"],
    });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/presence/me
 * The caller's own presence, for their header indicator.
 */
async function me(req, res, next) {
  try {
    const presence = await presenceService.getMyPresence(req.user);
    res.json({ success: true, ...presence });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/presence/board
 * Admin: the live team board.
 */
async function board(req, res, next) {
  try {
    const board = await presenceService.getBoard();
    res.json({ success: true, ...board });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/presence/users/:userId
 * Admin: one annotator's detailed activity history.
 */
async function userDetail(req, res, next) {
  try {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 14));
    const activity = await presenceService.getUserActivity(req.params.userId, {
      days,
    });
    res.json({ success: true, ...activity });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/presence/sweep
 * Admin: manual cleanup of stale sessions.
 */
async function sweep(req, res, next) {
  try {
    const result = await presenceService.sweepStaleSessions();
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  heartbeat,
  me,
  board,
  userDetail,
  sweep,
};