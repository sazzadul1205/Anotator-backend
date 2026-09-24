// controllers/analyticsController.js
// Thin HTTP wrappers around analyticsService.
// No DB access. No ObjectId. No filter building.

const analyticsService = require("../services/analyticsService");

/**
 * GET /api/analytics/dataset/:id
 * Per-dataset analytics.
 */
async function datasetAnalytics(req, res, next) {
  try {
    const result = await analyticsService.getDatasetAnalytics(
      req.params.id,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/analytics/global
 * Global (admin) analytics.
 */
async function globalAnalytics(req, res, next) {
  try {
    const result = await analyticsService.getGlobalAnalytics();
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/analytics/dataset/:id/export-ml?format=jsonl|csv|xlsx&split=0.8,0.1,0.1
 * Streams an ML-ready export of annotated comments.
 * All validation, splitting, and formatting lives in the service.
 */
async function exportML(req, res, next) {
  try {
    const result = await analyticsService.exportMLDataset({
      datasetId: req.params.id,
      user: req.user,
      format: (req.query.format || "jsonl").toLowerCase(),
      split: req.query.split,
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

module.exports = { datasetAnalytics, globalAnalytics, exportML };
