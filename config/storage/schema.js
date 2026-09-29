// config/storage/schema.js
// One declaration of the logical schema, consumed by *every* provider.
//
//   • the Mongo provider turns each `indexes` entry into a `createIndex()` call
//   • the JSON provider turns the `unique: true` entries into in-code
//     constraint checks (there is no index engine in a JSON file)
//   • the SQL providers (SQLite, MySQL) turn `columns` into CREATE TABLE and
//     `indexes` into CREATE INDEX / UNIQUE constraints
//
// Adding a collection, a field or an index therefore happens in exactly one
// place, and the providers cannot silently drift apart.
//
// ---------------------------------------------------------------------------
// Field types
//
//   id    the document identity, always a 24-char hex string (TEXT PRIMARY KEY)
//   ref   a reference to another document's id — TEXT, indexable
//   str   short indexable text (VARCHAR); default for enums, emails, names
//   long  long free text (comment bodies, descriptions) — never indexed
//   int   whole number
//   bool  stored as 0/1
//   date  stored as an ISO-8601 UTC string, which sorts and compares
//         correctly as text and round-trips to a JavaScript Date
//   json  a nested object or array, stored as JSON text and decoded on read
//
// Anything a model writes that is not listed here is still accepted: the SQL
// layer keeps such fields in a per-row `extra` JSON column rather than
// dropping them, so an undeclared field degrades to "stored, not queryable"
// instead of "silently lost".

const COLLECTIONS = {
  users: {
    columns: {
      id: "id",
      email: "str",
      name: "str",
      password: "str",
      role: "str",
      isActive: "bool",
      tokenVersion: "int",
      createdAt: "date",
      updatedAt: "date",
    },
    indexes: [
      { keys: ["email"], unique: true },
      { keys: ["role"] },
    ],
  },

  comments: {
    columns: {
      id: "id",
      datasetId: "ref",
      sourceId: "str",
      commentText: "long",
      sentiment: "str",
      type: "str",
      status: "str",
      assignedTo: "ref",
      assignedAt: "date",
      assignedBy: "ref",
      annotatedBy: "ref",
      annotatedAt: "date",
      annotationNote: "long",
      version: "int",
      createdBy: "ref",
      updatedBy: "ref",
      createdAt: "date",
      updatedAt: "date",
    },
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
    columns: {
      id: "id",
      commentId: "ref",
      version: "int",
      snapshot: "json",
      changedFields: "json",
      changeType: "str",
      restoredFrom: "int",
      changedBy: "ref",
      createdAt: "date",
    },
    indexes: [
      { keys: ["commentId", "version"], direction: -1 },
      { keys: ["createdAt"], direction: -1 },
    ],
  },

  datasets: {
    columns: {
      id: "id",
      name: "str",
      originalFileName: "str",
      fileType: "str",
      sheetName: "str",
      checksum: "str",
      totalRows: "int",
      importedRows: "int",
      skippedRows: "int",
      renamedRows: "int",
      dedupeStrategy: "str",
      status: "str",
      importError: "long",
      importErrors: "json",
      progress: "json",
      taxonomyId: "ref",
      taxonomyName: "str",
      taxonomyAssignedAt: "date",
      uploadedBy: "ref",
      assignedTo: "ref",
      assignedAt: "date",
      duplicatedFrom: "ref",
      createdAt: "date",
      updatedAt: "date",
    },
    indexes: [
      { keys: ["assignedTo"] },
      { keys: ["uploadedBy"] },
      { keys: ["createdAt"], direction: -1 },
      { keys: ["status"] },
      { keys: ["taxonomyId"] },
    ],
  },

  audit_log: {
    columns: {
      id: "id",
      action: "str",
      actorId: "ref",
      actorEmail: "str",
      actorRole: "str",
      targetType: "str",
      targetId: "ref",
      metadata: "json",
      at: "date",
    },
    indexes: [
      { keys: ["at"], direction: -1 },
      { keys: ["actorId", "at"], direction: -1 },
      { keys: ["action", "at"], direction: -1 },
      { keys: ["targetType", "targetId"] },
    ],
  },

  system_locks: {
    // The lock name IS the _id (e.g. "admin_bootstrap"), so it is inherently
    // unique in every store. The index is declared on `_id` for the Mongo and
    // JSON providers; the SQL layer maps `_id` onto the `id` primary key.
    columns: {
      id: "id",
      claimedAt: "date",
    },
    indexes: [{ keys: ["_id"], unique: true }],
  },

  taxonomies: {
    columns: {
      id: "id",
      name: "str",
      description: "long",
      sentiment: "json",
      type: "json",
      isActive: "bool",
      createdBy: "ref",
      updatedBy: "ref",
      createdAt: "date",
      updatedAt: "date",
    },
    indexes: [{ keys: ["isActive"] }, { keys: ["name"] }],
  },
};

/** Flat list understood by the JSON provider's constraint checker. */
function indexSpecsFor(collection) {
  return COLLECTIONS[collection]?.indexes || [];
}

function columnsFor(collection) {
  return COLLECTIONS[collection]?.columns || {};
}

function collectionNames() {
  return Object.keys(COLLECTIONS);
}

module.exports = {
  COLLECTIONS,
  indexSpecsFor,
  columnsFor,
  collectionNames,
};
