// versionRoutes.js
const express = require("express");
const router = express.Router();
const { ObjectId } = require("mongodb");
const { authenticate, logRequest } = require("../middleware");
const { getHistory, getVersion, revertToVersion } = require("../config/versioning");

const VALID_ENTITIES = ["Comment", "Project", "User"];

/* GET HISTORY FOR ANY ENTITY */
router.get(
  "/versions/:entityType/:entityId",
  authenticate,
  logRequest,
  async (req, res) => {
    try {
      const { entityType, entityId } = req.params;
      if (!VALID_ENTITIES.includes(entityType)) {
        return res.status(400).json({ success: false, error: "Invalid entity type" });
      }
      if (!ObjectId.isValid(entityId)) {
        return res.status(400).json({ success: false, error: "Invalid entity ID" });
      }

      const page = parseInt(req.query.page) || 1;
      const limit = parseInt(req.query.limit) || 50;

      const result = await getHistory(entityType, entityId, { page, limit });

      res.status(200).json({
        success: true,
        data: {
          entityType,
          entityId,
          versions: result.items,
          pagination: result.pagination,
        },
      });
    } catch (err) {
      console.error("Get history error:", err);
      res.status(500).json({ success: false, error: "Failed to fetch history" });
    }
  }
);

/* GET A SPECIFIC VERSION */
router.get(
  "/versions/:entityType/:entityId/:version",
  authenticate,
  logRequest,
  async (req, res) => {
    try {
      const { entityType, entityId, version } = req.params;
      if (!VALID_ENTITIES.includes(entityType)) {
        return res.status(400).json({ success: false, error: "Invalid entity type" });
      }
      if (!ObjectId.isValid(entityId)) {
        return res.status(400).json({ success: false, error: "Invalid entity ID" });
      }

      const doc = await getVersion(entityType, entityId, version);
      if (!doc) {
        return res.status(404).json({ success: false, error: "Version not found" });
      }

      res.status(200).json({ success: true, data: doc });
    } catch (err) {
      console.error("Get version error:", err);
      res.status(500).json({ success: false, error: "Failed to fetch version" });
    }
  }
);

/* REVERT TO A VERSION (Admin only) */
router.post(
  "/versions/:entityType/:entityId/:version/revert",
  authenticate,
  logRequest,
  async (req, res) => {
    try {
      if (req.user.role !== "Admin") {
        return res.status(403).json({ success: false, error: "Admin only" });
      }
      const { entityType, entityId, version } = req.params;
      if (!VALID_ENTITIES.includes(entityType)) {
        return res.status(400).json({ success: false, error: "Invalid entity type" });
      }
      if (!ObjectId.isValid(entityId)) {
        return res.status(400).json({ success: false, error: "Invalid entity ID" });
      }

      const restored = await revertToVersion(
        entityType,
        entityId,
        version,
        req.user
      );

      res.status(200).json({
        success: true,
        message: `Reverted ${entityType} to version ${version}`,
        data: restored,
      });
    } catch (err) {
      console.error("Revert error:", err);
      res.status(500).json({ success: false, error: err.message || "Failed to revert" });
    }
  }
);

module.exports = router;