// models/shared/dto.js
// Document -> DTO mappers shared by every provider implementation.
//
// A DTO is the only shape the rest of the application ever sees:
//   * `id` is a string, never a driver id
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

function commentToDTO(doc) {
  if (!doc) return null;
  return {
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
  };
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
  return dto;
}

function datasetToDTO(doc) {
  if (!doc) return null;
  return {
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
  };
}

function taxonomyToDTO(doc) {
  if (!doc) return null;
  return {
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
  };
}

function commentVersionToDTO(doc) {
  if (!doc) return null;
  return {
    id: idStr(doc._id),
    commentId: idStr(doc.commentId),
    version: doc.version,
    snapshot: doc.snapshot,
    changedFields: doc.changedFields || [],
    changeType: doc.changeType,
    restoredFrom: doc.restoredFrom ?? null,
    changedBy: idStr(doc.changedBy),
    createdAt: doc.createdAt,
  };
}

function auditLogToDTO(doc) {
  if (!doc) return null;
  return {
    id: idStr(doc._id),
    action: doc.action,
    actorId: idStr(doc.actorId),
    actorEmail: doc.actorEmail ?? null,
    actorRole: doc.actorRole ?? null,
    targetType: doc.targetType ?? null,
    targetId: idStr(doc.targetId),
    metadata: doc.metadata || {},
    at: doc.at,
  };
}

module.exports = {
  commentToDTO,
  userToDTO,
  datasetToDTO,
  taxonomyToDTO,
  commentVersionToDTO,
  auditLogToDTO,
};
