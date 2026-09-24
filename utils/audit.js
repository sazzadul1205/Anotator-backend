// utils/audit.js
// Append one entry to the audit log. Never throws into the caller.

const { AuditLog } = require("../models");

async function audit({ action, actor, targetType, targetId, metadata = {} }) {
  try {
    await AuditLog.create({
      action,
      actorId: actor?.userId || null,
      actorEmail: actor?.email || null,
      actorRole: actor?.role || null,
      targetType: targetType || null,
      targetId: targetId || null,
      metadata,
      at: new Date(),
    });
  } catch (err) {
    console.error("[audit]", err.message);
  }
}

module.exports = { audit };
