// models/shared/dto.js
// Document -> DTO mappers shared by every provider implementation.
//
// A DTO is the only shape the rest of the application ever sees:
//   * `id` is a string, never a driver id
//   * `_id` mirrors `id` — the client reads `_id` everywhere, so every
//     entity must carry it. Doing it here means no service can forget.
//   * every reference is a string or null
//   * optional fields get a stable default (`?? null`, `|| []`, `|| 0`)
//
// Because both providers hold the same logical document, these mappers are
// literally the same code for both. The only difference is what a reference
// field holds on disk (an ObjectId vs a string), and `idStr` normalises that.
//
// Caution: these are whitelists. Adding a field to a stored document without
// adding it here makes it invisible to services (see docs/models.md §7.4).

const { idStr } = require("./ids");

/**
 * Attach the `_id` alias to a DTO.
 *
 * The client reads `_id` on every entity (React keys, links, lookups), so the
 * alias belongs to the shape itself rather than to whichever service happens
 * to return the object. Doing it here keeps the two fields from drifting
 * apart and stops a new endpoint from silently shipping one without it.
 */
function withIdAlias(dto) {
  if (!dto) return null;
  return { ...dto, _id: dto.id };
}

function commentToDTO(doc) {
  if (!doc) return null;
  return withIdAlias({
    id: idStr(doc._id),
    datasetId: idStr(doc.datasetId),
    sourceId: doc.sourceId,
    commentText: doc.commentText,
    sentiment: doc.sentiment,
    type: doc.type,
    status: doc.status,
    assignedTo: idStr(doc.assignedTo),
    assignedAt: doc.assignedAt || null,
    assignedBy: idStr(doc.assignedBy),
    annotatedBy: idStr(doc.annotatedBy),
    annotatedAt: doc.annotatedAt || null,
    annotationNote: doc.annotationNote ?? null,
    version: doc.version,
    createdBy: idStr(doc.createdBy),
    updatedBy: idStr(doc.updatedBy),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}

function userToDTO(doc, { includePassword = false } = {}) {
  if (!doc) return null;
  const dto = {
    id: idStr(doc._id),
    email: doc.email,
    name: doc.name,
    role: doc.role,
    isActive: doc.isActive,
    tokenVersion: doc.tokenVersion ?? 0,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
  if (includePassword) dto.password = doc.password;
  return withIdAlias(dto);
}

function datasetToDTO(doc) {
  if (!doc) return null;
  return withIdAlias({
    id: idStr(doc._id),
    name: doc.name,
    originalFileName: doc.originalFileName,
    fileType: doc.fileType,
    sheetName: doc.sheetName ?? null,
    checksum: doc.checksum,
    totalRows: doc.totalRows,
    importedRows: doc.importedRows,
    skippedRows: doc.skippedRows,
    renamedRows: doc.renamedRows || 0,
    dedupeStrategy: doc.dedupeStrategy || "skip",
    status: doc.status,
    importError: doc.importError ?? null,
    importErrors: doc.importErrors || [],
    progress: doc.progress || null,
    taxonomyId: idStr(doc.taxonomyId),
    taxonomyName: doc.taxonomyName ?? null,
    taxonomyAssignedAt: doc.taxonomyAssignedAt ?? null,
    uploadedBy: idStr(doc.uploadedBy),
    assignedTo: idStr(doc.assignedTo),
    assignedAt: doc.assignedAt ?? null,
    duplicatedFrom: idStr(doc.duplicatedFrom),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}

function taxonomyToDTO(doc) {
  if (!doc) return null;
  return withIdAlias({
    id: idStr(doc._id),
    name: doc.name,
    description: doc.description ?? "",
    sentiment: doc.sentiment || [],
    type: doc.type || [],
    isActive: doc.isActive,
    createdBy: idStr(doc.createdBy),
    updatedBy: idStr(doc.updatedBy),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}

function commentVersionToDTO(doc) {
  if (!doc) return null;
  return withIdAlias({
    id: idStr(doc._id),
    commentId: idStr(doc.commentId),
    version: doc.version,
    snapshot: doc.snapshot,
    changedFields: doc.changedFields || [],
    changeType: doc.changeType,
    restoredFrom: doc.restoredFrom ?? null,
    changedBy: idStr(doc.changedBy),
    createdAt: doc.createdAt,
  });
}

function auditLogToDTO(doc) {
  if (!doc) return null;
  return withIdAlias({
    id: idStr(doc._id),
    action: doc.action,
    actorId: idStr(doc.actorId),
    actorEmail: doc.actorEmail ?? null,
    actorRole: doc.actorRole ?? null,
    targetType: doc.targetType ?? null,
    targetId: idStr(doc.targetId),
    metadata: doc.metadata || {},
    at: doc.at,
  });
}

// ---------------------------------------------------------------------------
// Media: images and videos
// ---------------------------------------------------------------------------

/**
 * A media label set. `labels` entries are `{ value, label, color }` where
 * `value` is the slug used in exports and `label` is the human-readable text.
 * `color` is for the annotator UI only; no export format uses it.
 */
function mediaLabelSetToDTO(doc) {
  if (!doc) return null;
  return withIdAlias({
    id: idStr(doc._id),
    name: doc.name,
    description: doc.description ?? "",
    labels: doc.labels || [],
    isActive: doc.isActive,
    createdBy: idStr(doc.createdBy),
    updatedBy: idStr(doc.updatedBy),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}

function mediaDatasetToDTO(doc) {
  if (!doc) return null;
  return withIdAlias({
    id: idStr(doc._id),
    name: doc.name,
    description: doc.description ?? "",
    mediaKind: doc.mediaKind,
    labelSetId: idStr(doc.labelSetId),
    labelSetName: doc.labelSetName ?? null,
    labelSetAssignedAt: doc.labelSetAssignedAt ?? null,
    totalAssets: doc.totalAssets || 0,
    annotatedAssets: doc.annotatedAssets || 0,
    annotatedRatio:
      doc.totalAssets > 0
        ? Math.round((doc.annotatedAssets / doc.totalAssets) * 100) / 100
        : 0,
    totalAnnotations: doc.totalAnnotations || 0,
    totalBytes: doc.totalBytes || 0,
    status: doc.status,
    createdBy: idStr(doc.createdBy),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}

/**
 * A media asset — one image or one video.
 *
 * `storagePath` is deliberately NOT exposed. The client never learns where a
 * file lives on disk; it asks for `/api/media/assets/:id/file` and the server
 * resolves the path itself. Exposing it would invite the client to build
 * filesystem paths, which is the thing config/media.js refuses to trust.
 */
function mediaAssetToDTO(doc) {
  if (!doc) return null;
  return withIdAlias({
    id: idStr(doc._id),
    datasetId: idStr(doc.datasetId),
    kind: doc.kind,
    originalFileName: doc.originalFileName,
    extension: doc.extension,
    mimeType: doc.mimeType ?? null,
    sizeBytes: doc.sizeBytes || 0,
    checksum: doc.checksum,
    width: doc.width ?? null,
    height: doc.height ?? null,
    durationMs: doc.durationMs ?? null,
    status: doc.status,
    annotationCount: doc.annotationCount || 0,
    assignedTo: idStr(doc.assignedTo),
    assignedAt: doc.assignedAt ?? null,
    assignedBy: idStr(doc.assignedBy),
    source: doc.source,
    createdBy: idStr(doc.createdBy),
    updatedBy: idStr(doc.updatedBy),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
    // Convenience URLs so the client does not have to build them by hand.
    fileUrl: `/api/media/assets/${idStr(doc._id)}/file`,
  });
}

/**
 * One annotation: a whole-image classification, or a bounding box.
 *
 * The box is exposed twice on purpose. `box` is the normalised 0..1 form the
 * client draws with and is resolution-independent; `boxPixels` is the absolute
 * form, present only when the asset's dimensions are known, because COCO
 * export and most drawing APIs want pixels. Returning both removes a class of
 * client-side rounding bug where the client converts and gets it subtly wrong.
 */
function mediaAnnotationToDTO(doc) {
  if (!doc) return null;
  const isBox = doc.kind === "bbox";
  const hasDims = isBox && doc.width > 0 && doc.height > 0;
  let boxPixels = null;
  if (hasDims) {
    boxPixels = {
      x: Math.round(doc.x * doc.width * 100) / 100,
      y: Math.round(doc.y * doc.height * 100) / 100,
      width: Math.round(doc.boxWidth * doc.width * 100) / 100,
      height: Math.round(doc.boxHeight * doc.height * 100) / 100,
    };
  }
  return withIdAlias({
    id: idStr(doc._id),
    assetId: idStr(doc.assetId),
    datasetId: idStr(doc.datasetId),
    kind: doc.kind,
    label: doc.label,
    // Width/height are denormalised onto the annotation by the asset service
    // so a client listing annotations does not need a second round-trip.
    width: doc.width ?? null,
    height: doc.height ?? null,
    box: isBox ? { x: doc.x, y: doc.y, width: doc.boxWidth, height: doc.boxHeight } : null,
    boxPixels,
    frameIndex: doc.frameIndex ?? null,
    timestampMs: doc.timestampMs ?? null,
    note: doc.note ?? null,
    revision: doc.revision || 1,
    createdBy: idStr(doc.createdBy),
    updatedBy: idStr(doc.updatedBy),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  });
}

function mediaAnnotationVersionToDTO(doc) {
  if (!doc) return null;
  return withIdAlias({
    id: idStr(doc._id),
    annotationId: idStr(doc.annotationId),
    assetId: idStr(doc.assetId),
    datasetId: idStr(doc.datasetId),
    revision: doc.revision,
    snapshot: doc.snapshot,
    changedFields: doc.changedFields || [],
    changeType: doc.changeType,
    restoredFrom: doc.restoredFrom ?? null,
    changedBy: idStr(doc.changedBy),
    createdAt: doc.createdAt,
  });
}

module.exports = {
  commentToDTO,
  userToDTO,
  datasetToDTO,
  taxonomyToDTO,
  commentVersionToDTO,
  auditLogToDTO,
  mediaLabelSetToDTO,
  mediaDatasetToDTO,
  mediaAssetToDTO,
  mediaAnnotationToDTO,
  mediaAnnotationVersionToDTO,
};
