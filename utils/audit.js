const { getDB } = require("../config/db");

async function audit({ action, actor, targetType, targetId, metadata = {} }) {
  try {
    const db = getDB();
    if (!db) return;

    await db.collection("audit_log").insertOne({
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
