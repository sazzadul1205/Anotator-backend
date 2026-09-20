// routes/auditRoute.js
const express = require("express");
const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

const router = express.Router();

// GET /api/audit ~ List audit entries (Admin only)
router.get("/", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    const page = parseInt(req.query.page, 10) || 1;
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
    const skip = (page - 1) * limit;

    const filter = {};
    if (req.query.action) filter.action = req.query.action;
    if (req.query.actorId && ObjectId.isValid(req.query.actorId)) {
      filter.actorId = req.query.actorId;
    }
    if (req.query.targetType) filter.targetType = req.query.targetType;
    if (req.query.targetId && ObjectId.isValid(req.query.targetId)) {
      filter.targetId = req.query.targetId;
    }
    if (req.query.from || req.query.to) {
      filter.at = {};
      if (req.query.from) filter.at.$gte = new Date(req.query.from);
      if (req.query.to) filter.at.$lte = new Date(req.query.to);
    }

    const [total, entries] = await Promise.all([
      db.collection("audit_log").countDocuments(filter),
      db
        .collection("audit_log")
        .find(filter)
        .sort({ at: -1 })
        .skip(skip)
        .limit(limit)
        .toArray(),
    ]);

    res.json({
      success: true,
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      entries,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /api/audit/actions ~ Distinct action names (for filter dropdowns)
router.get("/actions", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    const actions = await db.collection("audit_log").distinct("action");
    res.json({ success: true, actions: actions.sort() });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
