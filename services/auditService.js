// services/auditService.js
// Read-only access to audit log entries with filtering and pagination.

const { AuditLog } = require("../models");

/**
 * List audit entries with optional filters.
 * Query: page, limit, action, actorId, targetType, targetId, from, to.
 */
async function listAuditEntries(query) {
  const page = parseInt(query.page, 10) || 1;
  const limit = Math.min(parseInt(query.limit, 10) || 50, 200);

  // Build a domain filter — no $operators, no ObjectId
  const filter = {};
  if (query.action) filter.action = query.action;
  if (query.actorId) filter.actorId = query.actorId;
  if (query.targetType) filter.targetType = query.targetType;
  if (query.targetId) filter.targetId = query.targetId;
  if (query.from) filter.from = query.from;
  if (query.to) filter.to = query.to;

  const { entries, total } = await AuditLog.findMany(filter, { page, limit });

  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    entries,
  };
}

/**
 * Return the distinct list of actions recorded in the audit log.
 */
async function listActions() {
  const actions = await AuditLog.distinctActions();
  return actions.sort();
}

module.exports = { listAuditEntries, listActions };
