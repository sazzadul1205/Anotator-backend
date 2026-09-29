// models/shared/mediaFilters.js
// Domain filter -> provider query, and patch sanitising, for the media domain.
//
// Kept in `shared/` for the same reason as `filters.js`: it is the single
// translation point between what a service asks for and what a provider
// executes. If this were duplicated per strategy, the providers could disagree
// about what a filter means, and the parity suite would catch it only after
// someone shipped the divergence.
//
// Every field referenced here MUST be declared in `config/storage/schema.js`,
// because the SQL layer refuses to filter on an undeclared field rather than
// scanning a JSON blob.

const { stringIds } = require("./ids");

// Fields a caller may filter an asset by.
const ASSET_FILTERABLE = [
  "kind",
  "status",
  "assignedTo",
  "checksum",
  "extension",
];

// Fields a caller may filter an annotation by.
//
// `createdBy` is filterable because the presence/activity board has to answer
// "how many annotations did this person produce in the last hour" without
// scanning every annotation in the store.
const ANNOTATION_FILTERABLE = ["kind", "label", "assetId", "frameIndex", "createdBy"];

/**
 * Builds an asset filter.
 *
 * `status` and `excludeAnnotated` are mutually exclusive, and `status` wins —
 * the same precedence `filters.js` uses for comments, kept identical so a
 * caller who learned one does not get a different rule here.
 */
function mediaAssetFilter(domain = {}, ids = stringIds) {
  const f = {};
  const datasetId = ids.coerce(domain.datasetId);
  if (datasetId) f.datasetId = datasetId;

  if (domain.id) {
    const id = ids.coerce(domain.id);
    if (id) f._id = id;
  }

  for (const field of ASSET_FILTERABLE) {
    if (domain[field] === undefined) continue;
    if (field === "assignedTo") {
      const id = ids.coerce(domain.assignedTo);
      // An explicitly null assignedTo means "unassigned", which in Mongo is a
      // match on null-or-absent. That is the query the UI needs for a
      // "claim an unassigned image" queue, so it is preserved rather than
      // dropped.
      f.assignedTo = domain.assignedTo === null ? null : id;
      continue;
    }
    f[field] = domain[field];
  }

  if (domain.status) {
    f.status = domain.status;
  } else if (domain.excludeAnnotated) {
    f.status = { $ne: "annotated" };
  }

  if (domain.checksumIn && Array.isArray(domain.checksumIn)) {
    const list = domain.checksumIn.map((c) => String(c)).filter(Boolean);
    // An empty `$in` must match nothing (see the parity rules), not everything.
    f.checksum = { $in: list };
  }

  return f;
}

/** Builds an annotation filter. `datasetId` and `assetId` are both accepted. */
function mediaAnnotationFilter(domain = {}, ids = stringIds) {
  const f = {};
  const datasetId = ids.coerce(domain.datasetId);
  if (datasetId) f.datasetId = datasetId;

  const assetId = ids.coerce(domain.assetId);
  if (assetId) f.assetId = assetId;

  for (const field of ANNOTATION_FILTERABLE) {
    if (domain[field] === undefined) continue;
    if (field === "assetId") continue; // already handled above
    if (field === "createdBy") {
      f.createdBy = ids.coerce(domain.createdBy);
      continue;
    }
    f[field] = domain[field];
  }

  // Creation time window. Used by the activity board to bucket a person's
  // output per day without paging the whole collection into memory.
  if (domain.createdAtFrom || domain.createdAtTo) {
    f.createdAt = {};
    if (domain.createdAtFrom) f.createdAt.$gte = domain.createdAtFrom;
    if (domain.createdAtTo) f.createdAt.$lte = domain.createdAtTo;
  }

  if (domain.labelIn && Array.isArray(domain.labelIn)) {
    const list = domain.labelIn.map((l) => String(l)).filter(Boolean);
    f.label = { $in: list };
  }

  // Video frame range. Used by the scrubber to fetch everything visible in a
  // time window without paging the whole video's annotations.
  if (typeof domain.timestampMsFrom === "number") {
    f.timestampMs = { $gte: domain.timestampMsFrom };
  }
  if (typeof domain.timestampMsTo === "number") {
    f.timestampMs = { ...(f.timestampMs || {}), $lte: domain.timestampMsTo };
  }

  return f;
}

/**
 * Sanitises a partial annotation update.
 *
 * Only these fields may be patched, and only when actually present in the
 * payload. Notably `assetId` and `datasetId` are absent: moving an annotation
 * between assets is not a patch, it is a delete and a create, because the
 * geometry was drawn against a specific image and silently re-homing it would
 * produce a box that means something different.
 */
function sanitizeMediaAnnotationPatch(patch = {}) {
  const out = {};
  const allowed = ["label", "kind", "note", "frameIndex", "timestampMs"];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      out[key] = patch[key];
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, "box")) {
    out.box = patch.box;
  }
  return out;
}

/** Sanitises a partial asset update (assignment, mainly). */
function sanitizeMediaAssetPatch(patch = {}) {
  const out = {};
  const allowed = ["assignedTo", "name", "description"];
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      out[key] = patch[key];
    }
  }
  return out;
}

/** Reference fields on a media asset that must be normalised to string ids. */
const MEDIA_ASSET_REF_FIELDS = ["assignedTo", "assignedBy", "createdBy", "updatedBy"];

/** Reference fields on a media annotation. */
const MEDIA_ANNOTATION_REF_FIELDS = ["assetId", "datasetId", "createdBy", "updatedBy"];

module.exports = {
  ASSET_FILTERABLE,
  ANNOTATION_FILTERABLE,
  MEDIA_ASSET_REF_FIELDS,
  MEDIA_ANNOTATION_REF_FIELDS,
  mediaAssetFilter,
  mediaAnnotationFilter,
  sanitizeMediaAnnotationPatch,
  sanitizeMediaAssetPatch,
};
