// controllers/auditController.js
// Read-only access to the audit log.

const auditService = require("../services/auditService");

/**
 * GET /api/audit?page=&limit=&action=&actorId=&targetType=&targetId=&from=&to=
 * Paginated audit log.
 */
async function list(req, res, next) {
  try {
    const result = await auditService.listAuditEntries(req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/audit/actions
 * Distinct list of actions ever recorded (for filter dropdowns).
 */
async function actions(req, res, next) {
  try {
    const actions = await auditService.listActions();
    res.json({ success: true, actions });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, actions };
