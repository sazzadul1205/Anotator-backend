const auditService = require("../services/auditService");

async function list(req, res, next) {
  try {
    const result = await auditService.listAuditEntries(req.query);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function actions(req, res, next) {
  try {
    const actions = await auditService.listActions();
    res.json({ success: true, actions });
  } catch (err) {
    next(err);
  }
}

module.exports = { list, actions };
