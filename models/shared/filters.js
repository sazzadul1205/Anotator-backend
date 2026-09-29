// models/shared/filters.js
// Domain filter -> storage query.
//
// Services describe *what* they want in plain, operator-free objects
// (`{ datasetId: "652f…", status: "pending" }`). Each provider turns that into
// its own query language. The translation rules — including the deliberate
// quirks documented below — live here, once, so the two providers cannot
// disagree about what a filter means.
//
// Parameter `ids` is the provider's id adapter (see ids.js). That is the only
// difference between the two builds of the same filter: Mongo substitutes
// ObjectIds, the JSON store keeps strings.
//
// Quirks preserved from the original Mongo-only implementation (they are
// observable behaviour, so both providers must agree):
//   1. Malformed ids are dropped, not rejected. A filter whose every id is
//      invalid becomes `$in: []`, i.e. "match nothing".
//   2. A malformed `datasetId` on its own is simply not applied, so the query
//      degrades to "all comments" rather than "no comments".
//   3. `status` and `excludeAnnotated` are mutually exclusive; `status` wins.

const { escapeRegex } = require("./ids");

/**
 * Reference fields on `comments` that an update *patch* may touch.
 * `datasetId` and `createdBy` are intentionally absent: a comment never
 * changes dataset, and provenance is not rewritable.
 */
const COMMENT_REF_FIELDS = [
  "assignedTo",
  "assignedBy",
  "annotatedBy",
  "updatedBy",
];

/** Reference fields on `comments` present on a full document. */
const COMMENT_DOC_REF_FIELDS = [
  "datasetId",
  ...COMMENT_REF_FIELDS,
  "createdBy",
];

/** Reference fields on `datasets`. */
const DATASET_REF_FIELDS = [
  "assignedTo",
  "uploadedBy",
  "taxonomyId",
  "duplicatedFrom",
];

function commentFilter(domain = {}, ids) {
  const f = {};

  if (Array.isArray(domain.ids)) {
    f._id = { $in: domain.ids.map((v) => ids.coerce(v)).filter(Boolean) };
  }

  if (Array.isArray(domain.datasetIds)) {
    const allowed = domain.datasetIds.map((v) => ids.coerce(v)).filter(Boolean);
    if (domain.datasetId) {
      const target = ids.coerce(domain.datasetId);
      const permitted = allowed.some((a) => ids.equal(a, target));
      f.datasetId = permitted ? target : { $in: [] };
    } else {
      f.datasetId = { $in: allowed };
    }
  } else if (domain.datasetId) {
    const target = ids.coerce(domain.datasetId);
    if (target) f.datasetId = target;
  }

  if (domain.sourceId !== undefined) {
    f.sourceId = String(domain.sourceId);
  }

  if (domain.status) {
    f.status = domain.status;
  } else if (domain.excludeAnnotated) {
    f.status = { $ne: "annotated" };
  }

  if (domain.sentiment) f.sentiment = domain.sentiment;
  if (domain.type) f.type = domain.type;

  if (domain.assignedTo !== undefined) {
    f.assignedTo = domain.assignedTo === null ? null : ids.coerce(domain.assignedTo);
  }

  if (domain.search) {
    const trimmed = String(domain.search).trim().slice(0, 100);
    if (trimmed) {
      f.commentText = { $regex: escapeRegex(trimmed), $options: "i" };
    }
  }

  return f;
}

function datasetFilter(domain = {}, ids) {
  const f = {};
  if (domain.status) f.status = domain.status;
  if (domain.assignedTo) f.assignedTo = ids.coerce(domain.assignedTo);
  if (domain.uploadedBy) f.uploadedBy = ids.coerce(domain.uploadedBy);
  if (domain.taxonomyId) f.taxonomyId = ids.coerce(domain.taxonomyId);
  return f;
}

// Neither filter touches an id, so both providers pass the same id adapter
// and neither needs it here. The parameter is kept for a uniform signature.
function userFilter(domain = {}) {
  const f = {};
  if (domain.role) f.role = domain.role;
  if (domain.isActive !== undefined) f.isActive = domain.isActive;
  if (domain.email) f.email = normalizeEmail(domain.email);
  return f;
}

function taxonomyFilter(domain = {}) {
  const f = {};
  if (domain.kind) f.kind = domain.kind;
  if (domain.isActive !== undefined) f.isActive = domain.isActive;
  return f;
}

function auditLogFilter(domain = {}, ids) {
  const f = {};
  if (domain.action) f.action = domain.action;
  if (domain.actorId) f.actorId = ids.coerce(domain.actorId);
  if (domain.targetType) f.targetType = domain.targetType;
  if (domain.targetId) f.targetId = ids.coerce(domain.targetId);
  if (domain.from || domain.to) {
    f.at = {};
    if (domain.from) f.at.$gte = new Date(domain.from);
    if (domain.to) f.at.$lte = new Date(domain.to);
  }
  return f;
}

/** Emails are stored lowercase and trimmed — both providers must agree. */
function normalizeEmail(email) {
  return String(email).toLowerCase().trim();
}

// ---------------------------------------------------------------------------
// Patch / DTO sanitising
// ---------------------------------------------------------------------------

/**
 * Strips identity fields from an incoming patch and coerces the reference
 * fields to the provider's id representation.
 */
function sanitizePatch(patch, ids, refFields = []) {
  const set = { ...patch };
  delete set.id;
  delete set._id;
  for (const key of refFields) {
    if (key in set) set[key] = set[key] ? ids.coerce(set[key]) : null;
  }
  if ("email" in set && set.email) set.email = normalizeEmail(set.email);
  return set;
}

/** Like sanitizePatch, but also removes the duplication bookkeeping field. */
function dtoToDocument(dto, ids, refFields = []) {
  const doc = sanitizePatch(dto, ids, refFields);
  delete doc._oldId;
  return doc;
}

module.exports = {
  commentFilter,
  datasetFilter,
  userFilter,
  taxonomyFilter,
  auditLogFilter,
  sanitizePatch,
  dtoToDocument,
  normalizeEmail,
  COMMENT_REF_FIELDS,
  COMMENT_DOC_REF_FIELDS,
  DATASET_REF_FIELDS,
};
