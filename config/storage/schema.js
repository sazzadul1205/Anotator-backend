// config/storage/schema.js
// One declaration of the logical schema, consumed by *both* providers.
//
//   • the Mongo provider turns each entry into a real `createIndex()` call
//   • the JSON provider turns the `unique: true` entries into in-code
//     constraint checks (there is no index engine in a JSON file)
//
// Adding a collection or an index therefore happens in exactly one place, and
// the two providers cannot silently drift apart.

const COLLECTIONS = {
  users: {
    indexes: [
      { keys: ["email"], unique: true },
      { keys: ["role"] },
    ],
  },
  comments: {
    indexes: [
      { keys: ["datasetId", "sourceId"], unique: true },
      { keys: ["datasetId", "status"] },
      { keys: ["datasetId", "createdAt"], direction: -1 },
      { keys: ["assignedTo"] },
      { keys: ["status"] },
      { keys: ["datasetId", "sentiment"] },
      { keys: ["datasetId", "type"] },
      { keys: ["datasetId", "status", "sentiment"] },
    ],
  },
  comment_versions: {
    indexes: [
      { keys: ["commentId", "version"], direction: -1 },
      { keys: ["createdAt"], direction: -1 },
    ],
  },
  datasets: {
    indexes: [
      { keys: ["assignedTo"] },
      { keys: ["uploadedBy"] },
      { keys: ["createdAt"], direction: -1 },
      { keys: ["status"] },
      { keys: ["taxonomyId"] },
    ],
  },
  audit_log: {
    indexes: [
      { keys: ["at"], direction: -1 },
      { keys: ["actorId", "at"], direction: -1 },
      { keys: ["action", "at"], direction: -1 },
      { keys: ["targetType", "targetId"] },
    ],
  },
  system_locks: {
    // _id is the lock name and is inherently unique in every store.
    indexes: [{ keys: ["_id"], unique: true }],
  },
  taxonomies: {
    indexes: [{ keys: ["isActive"] }, { keys: ["name"] }],
  },
};

/** Flat list understood by the JSON provider's constraint checker. */
function indexSpecsFor(collection) {
  return COLLECTIONS[collection]?.indexes || [];
}

function collectionNames() {
  return Object.keys(COLLECTIONS);
}

module.exports = { COLLECTIONS, indexSpecsFor, collectionNames };
