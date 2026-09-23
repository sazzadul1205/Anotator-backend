const { ObjectId } = require("mongodb");
const AuditLog = require("../models/AuditLog");

async function listAuditEntries(query) {
  const page = parseInt(query.page, 10) || 1;
  const limit = Math.min(parseInt(query.limit, 10) || 50, 200);
  const skip = (page - 1) * limit;

  const filter = {};
  if (query.action) filter.action = query.action;
  if (query.actorId && ObjectId.isValid(query.actorId))
    filter.actorId = query.actorId;
  if (query.targetType) filter.targetType = query.targetType;
  if (query.targetId && ObjectId.isValid(query.targetId))
    filter.targetId = query.targetId;
  if (query.from || query.to) {
    filter.at = {};
    if (query.from) filter.at.$gte = new Date(query.from);
    if (query.to) filter.at.$lte = new Date(query.to);
  }

  const [total, entries] = await Promise.all([
    AuditLog.count(filter),
    AuditLog.find(filter, { skip, limit }),
  ]);

  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    entries,
  };
}

async function listActions() {
  const actions = await AuditLog.distinctActions();
  return actions.sort();
}

module.exports = { listAuditEntries, listActions };
