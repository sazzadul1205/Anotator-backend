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
//   float a fixed-point decimal (normalised bounding-box coordinates) — use
//         this, not `int`, for any value that can fall between 0 and 1
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

  // -------------------------------------------------------------------------
  // Media: images and videos
  // -------------------------------------------------------------------------
  // A parallel domain to `datasets`/`comments`, not an extension of them. The
  // unit of work is an *asset* (one image or one video) carrying zero or more
  // *annotations* (a whole-image label or a bounding box). The text domain's
  // `sentiment` + `type` pair has no meaning here, so the two are kept apart
  // rather than overloading `comments` with geometry.
  //
  // Only metadata lives in these collections. The file bytes are on disk under
  // `config.media.root`; see config/media.js.

  media_label_sets: {
    // The detection label vocabulary for a dataset — the equivalent of a
    // taxonomy, but a flat list of class names rather than two label axes.
    // `labels` is a JSON array of { value, label, color } entries, because
    // COCO/YOLO exports need a stable class index and annotators need a
    // swatch, neither of which the label text alone provides.
    columns: {
      id: "id",
      name: "str",
      description: "long",
      labels: "json",
      isActive: "bool",
      createdBy: "ref",
      updatedBy: "ref",
      createdAt: "date",
      updatedAt: "date",
    },
    indexes: [{ keys: ["isActive"] }, { keys: ["name"] }],
  },

  media_datasets: {
    columns: {
      id: "id",
      name: "str",
      description: "long",
      // "image" | "video" | "mixed" — mixed means the dataset holds both,
      // which is allowed but blocks per-dataset format assumptions.
      mediaKind: "str",
      labelSetId: "ref",
      labelSetName: "str",
      labelSetAssignedAt: "date",
      // Denormalised counters, kept in step by the asset service so the list
      // view is one query rather than an aggregate per row.
      totalAssets: "int",
      annotatedAssets: "int",
      totalAnnotations: "int",
      // `int`, not `long`: `long` is a TEXT type, so a byte count declared as
      // `long` would round-trip as the string "12345" and break every
      // arithmetic comparison on it.
      totalBytes: "int",
      status: "str",
      createdBy: "ref",
      createdAt: "date",
      updatedAt: "date",
    },
    indexes: [
      { keys: ["createdAt"], direction: -1 },
      { keys: ["labelSetId"] },
      { keys: ["status"] },
    ],
  },

  media_assets: {
    columns: {
      id: "id",
      datasetId: "ref",
      // "image" | "video"
      kind: "str",
      // The client-supplied name, recorded for display only. It never
      // influences where the file is written — see config/media.js.
      originalFileName: "str",
      extension: "str",
      mimeType: "str",
      // `int`, not `long` — see media_datasets.totalBytes.
      sizeBytes: "int",
      // Content hash of the file bytes. Gives a cheap exact-duplicate check on
      // upload, which is the single most common data-quality problem when
      // assembling a training set from a scrape.
      checksum: "str",
      width: "int",
      height: "int",
      // Video only. Null when the container is not parseable (WebM, MKV).
      durationMs: "int",
      // Path relative to the media root. Derived from generated ids only.
      storagePath: "str",
      // "pending" (no annotations) | "annotated" (at least one) — derived, and
      // the same shape the text domain uses so analytics code reads alike.
      status: "str",
      annotationCount: "int",
      assignedTo: "ref",
      assignedAt: "date",
      assignedBy: "ref",
      // Provenance: "upload" today. Reserved so a future COCO-import can
      // coexist with hand-drawn data without a migration.
      source: "str",
      createdBy: "ref",
      updatedBy: "ref",
      createdAt: "date",
      updatedAt: "date",
    },
    indexes: [
      // One copy of a given file per dataset, so re-uploading a scrape cannot
      // silently duplicate a training example.
      { keys: ["datasetId", "checksum"], unique: true },
      { keys: ["datasetId", "createdAt"], direction: -1 },
      { keys: ["datasetId", "status"] },
      { keys: ["assignedTo"] },
      { keys: ["kind"] },
    ],
  },

  media_annotations: {
    columns: {
      id: "id",
      assetId: "ref",
      // Denormalised from the asset so "every annotation in this dataset" is a
      // single indexed query. The cascade delete and the exporters both need
      // that shape, and the SQL layer can only filter on declared fields.
      datasetId: "ref",
      // "bbox" (a region) | "classification" (a whole-image label)
      kind: "str",
      // The label *value* from the dataset's label set. A slug, not a display
      // name, because that is what both COCO (`category_name`) and YOLO (the
      // class index row) ultimately key on.
      label: "str",
      // Normalised 0..1, top-left origin. Null for `classification`.
      x: "float",
      y: "float",
      boxWidth: "float",
      boxHeight: "float",
      // Video only. Both null for images.
      frameIndex: "int",
      timestampMs: "int",
      // The parent asset's pixel dimensions, copied at write time. This is
      // denormalisation on purpose: the annotator UI lists every annotation of
      // an asset at once and needs to convert to pixels for each one, and a
      // join per row to recover two numbers that never change is pure waste.
      // They are also the audit trail: if an asset's dimensions are ever
      // corrected, old annotations keep the geometry they were drawn against.
      width: "int",
      height: "int",
      note: "long",
      // Monotonic per asset, so a client's optimistic-concurrency check can
      // reject an edit based on a stale view.
      revision: "int",
      createdBy: "ref",
      updatedBy: "ref",
      createdAt: "date",
      updatedAt: "date",
    },
    indexes: [
      { keys: ["assetId", "createdAt"] },
      { keys: ["datasetId", "label"] },
      { keys: ["datasetId", "kind"] },
      { keys: ["createdAt"], direction: -1 },
    ],
  },

  media_annotation_versions: {
    // Mirrors comment_versions: every create/update/delete of an annotation
    // appends an immutable snapshot, so annotation history is as auditable as
    // text history. Restoring appends a new revision rather than rewriting.
    columns: {
      id: "id",
      annotationId: "ref",
      assetId: "ref",
      datasetId: "ref",
      revision: "int",
      snapshot: "json",
      changedFields: "json",
      changeType: "str",
      restoredFrom: "int",
      changedBy: "ref",
      createdAt: "date",
    },
    indexes: [
      { keys: ["annotationId", "revision"], direction: -1 },
      { keys: ["assetId", "createdAt"], direction: -1 },
    ],
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
