// config/versioning.js
const { getDB } = require("./db");
const { ObjectId } = require("mongodb");

/**
 * Record a change into the ChangeLog collection.
 * Stores a full snapshot (for revert support) and a shallow diff.
 */
async function recordChange({
  entityType,        // "Comment" | "Project" | "User"
  entityId,          // ObjectId
  action,            // "create" | "update" | "delete" | "validate"
  before = null,     // document before change (or null for create)
  after = null,      // document after change (or null for delete)
  user = null,       // { userId, username }
  projectId = null,  // optional, for grouping
  metadata = {},     // any extra info
}) {
  const db = getDB();
  const ChangeLog = db.collection("ChangeLog");

  // Compute changed fields
  let changedFields = [];
  if (before && after) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) {
      if (k === "_id" || k === "updatedAt") continue;
      const b = JSON.stringify(before[k]);
      const a = JSON.stringify(after[k]);
      if (b !== a) changedFields.push(k);
    }
  } else if (action === "create") {
    changedFields = Object.keys(after || {}).filter((k) => k !== "_id");
  } else if (action === "delete") {
    changedFields = Object.keys(before || {}).filter((k) => k !== "_id");
  }

  // Get next version number for this entity
  const lastVersion = await ChangeLog.findOne(
    { entityType, entityId: new ObjectId(entityId) },
    { sort: { version: -1 } }
  );
  const version = (lastVersion?.version || 0) + 1;

  const entry = {
    entityType,
    entityId: new ObjectId(entityId),
    projectId: projectId ? new ObjectId(projectId) : null,
    version,
    action,
    changedFields,
    before,
    after,
    userId: user?.userId ? new ObjectId(user.userId) : null,
    username: user?.username || null,
    metadata,
    createdAt: new Date(),
  };

  const result = await ChangeLog.insertOne(entry);
  return { ...entry, _id: result.insertedId };
}

/**
 * Get version history for an entity.
 */
async function getHistory(entityType, entityId, { limit = 50, page = 1 } = {}) {
  const db = getDB();
  const ChangeLog = db.collection("ChangeLog");
  const filter = { entityType, entityId: new ObjectId(entityId) };
  const skip = (page - 1) * limit;

  const [items, total] = await Promise.all([
    ChangeLog.find(filter)
      .sort({ version: -1 })
      .skip(skip)
      .limit(limit)
      .toArray(),
    ChangeLog.countDocuments(filter),
  ]);

  return {
    items,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/**
 * Get a specific version snapshot.
 */
async function getVersion(entityType, entityId, version) {
  const db = getDB();
  const ChangeLog = db.collection("ChangeLog");
  return ChangeLog.findOne({
    entityType,
    entityId: new ObjectId(entityId),
    version: Number(version),
  });
}

/**
 * Revert an entity to a specific version.
 * Restores the `after` snapshot of that version.
 */
async function revertToVersion(entityType, entityId, version, user) {
  const db = getDB();
  const ChangeLog = db.collection("ChangeLog");
  const target = await getVersion(entityType, entityId, version);
  if (!target) throw new Error(`Version ${version} not found`);

  const snapshot = target.after;
  if (!snapshot) throw new Error(`Version ${version} has no snapshot to revert to`);

  const collectionName =
    entityType === "Comment" ? "Comments" :
    entityType === "Project" ? "Projects" :
    entityType === "User" ? "Users" : null;

  if (!collectionName) throw new Error(`Unknown entity type: ${entityType}`);

  const Collection = db.collection(collectionName);
  const current = await Collection.findOne({ _id: new ObjectId(entityId) });
  if (!current) throw new Error("Entity not found");

  // Strip _id from snapshot so we don't try to overwrite it
  const { _id, ...restore } = snapshot;
  restore.updatedAt = new Date();

  await Collection.updateOne(
    { _id: new ObjectId(entityId) },
    { $set: restore }
  );

  // Log the revert itself
  await recordChange({
    entityType,
    entityId,
    action: "revert",
    before: current,
    after: { ...current, ...restore },
    user,
    projectId: current.projectId,
    metadata: { revertedToVersion: version },
  });

  return await Collection.findOne({ _id: new ObjectId(entityId) });
}

module.exports = {
  recordChange,
  getHistory,
  getVersion,
  revertToVersion,
};