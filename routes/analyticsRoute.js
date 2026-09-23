const express = require("express");
const analyticsController = require("../controllers/analyticsController");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

const router = express.Router();

router.get("/dataset/:id", verifyToken, analyticsController.datasetAnalytics);
router.get(
  "/global",
  verifyToken,
  verifyAdmin,
  analyticsController.globalAnalytics,
);
router.get("/dataset/:id/export-ml", verifyToken, analyticsController.exportML);

module.exports = router;
