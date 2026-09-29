// services/annotationService.js
// Annotation rules: creating, editing and deleting bounding boxes and
// whole-image labels.
//
// This is where geometry is trusted. The client sends numbers; this layer is the
// last place that can reject nonsense before it becomes a permanent training
// example. Three invariants are enforced here:
//
//   1. A box is stored normalised to 0..1 and clamped to the image, so a
//      selection drawn at the edge is valid and a selection dragged off-canvas
//      is corrected rather than rejected.
//   2. A label must exist in the dataset's label set, and the *slug* is what
//      gets stored — so the export's class list and the annotations agree.
//   3. Every mutation appends an immutable version, so annotation history is
//      as auditable as text history.

const {
  MediaAsset,
  MediaDataset,
  MediaLabelSet,
  MediaAnnotation,
  MediaAnnotationVersion,
} = require("../models");
const { ValidationError, NotFoundError } = require("../models/errors");
const { normalizeBox, normalizeFrame, GeometryError } = require("../utils/geometry");
const { resolveLabel } = require("./mediaLabelService");
const { refreshDatasetCounters } = require("./mediaService");
const { audit } = require("../utils/audit");

const MAX_NOTE_LENGTH = 2000;

/** Fields recorded in a version snapshot's `changedFields`. */
const TRACKED_FIELDS = ["label", "kind", "note", "x", "y", "boxWidth", "boxHeight", "frameIndex", "timestampMs"];

/** Loads the label set bound to a dataset, or throws. */
async function requireLabelSet(datasetId) {
  const dataset = await MediaDataset.assertExists(datasetId);
  if (!dataset.labelSetId) {
    throw new ValidationError(
      "This dataset has no label set. Assign one before annotating.",
    );
  }
  const labelSet = await MediaLabelSet.assertExists(dataset.labelSetId);
  return { dataset, labelSet };
}

/** Turns an annotation row into the plain object stored in a version snapshot. */
function snapshotOf(annotation) {
  return {
    assetId: annotation.assetId,
    datasetId: annotation.datasetId,
    kind: annotation.kind,
    label: annotation.label,
    x: annotation.box ? annotation.box.x : null,
    y: annotation.box ? annotation.box.y : null,
    boxWidth: annotation.box ? annotation.box.width : null,
    boxHeight: annotation.box ? annotation.box.height : null,
    frameIndex: annotation.frameIndex,
    timestampMs: annotation.timestampMs,
    width: annotation.width,
    height: annotation.height,
    note: annotation.note,
    createdBy: annotation.createdBy,
  };
}

/** Which tracked fields actually differ between two snapshots. */
function diffFields(before, after) {
  return TRACKED_FIELDS.filter((key) => {
    const a = before ? before[key] : null;
    const b = after ? after[key] : null;
    return a !== b;
  });
}

/**
 * Recomputes the asset's annotation count and derived status, then the
 * dataset's counters. Every write path ends here so the denormalised counts can
 * never drift from reality.
 */
async function refreshCounts(assetId, datasetId) {
  const count = await MediaAnnotation.countByAsset(assetId);
  await MediaAsset.setAnnotationState(assetId, count);
  await refreshDatasetCounters(datasetId);
  return count;
}

// --- Reads -----------------------------------------------------------------

async function listForAsset(assetId) {
  await MediaAsset.assertExists(assetId);
  return MediaAnnotation.findAllByAsset(String(assetId));
}

async function get(id) {
  const annotation = await MediaAnnotation.findById(id);
  if (!annotation) throw new NotFoundError("Annotation not found");
  return annotation;
}

async function listForDataset(datasetId, query = {}) {
  return MediaAnnotation.findMany(
    { datasetId: String(datasetId), ...query },
    { page: query.page, limit: query.limit, sortBy: query.sortBy, sortDir: query.sortDir },
  );
}

/**
 * Full version history for one annotation, newest first.
 *
 * Works for a *deleted* annotation too. The delete leaves its version rows
 * behind precisely so the history stays readable, and a 404 here would make the
 * whole restore flow unusable: the client would have no way to show what it is
 * about to bring back. An id with neither a live row nor any history is still
 * a genuine 404.
 */
async function history(annotationId) {
  const versions = await MediaAnnotationVersion.findByAnnotationId(String(annotationId));
  if (!versions.length) {
    // No history means no such annotation has ever existed.
    await get(annotationId);
  }
  return versions;
}

// --- Writes ----------------------------------------------------------------

/**
 * Creates one annotation on an asset.
 *
 * `box` may be sent in normalised form (0..1) or, when `pixelSpace` is true, in
 * pixels against the asset's own dimensions. The pixel form is what a drawing
 * canvas naturally produces, so accepting it removes a class of client-side
 * rounding bug — but it requires known dimensions, and that requirement is
 * enforced rather than assumed.
 */
async function create(assetId, input, user) {
  const asset = await MediaAsset.assertExists(assetId);
  const { labelSet } = await requireLabelSet(asset.datasetId);

  const kind = input.kind || "bbox";
  if (kind !== "bbox" && kind !== "classification") {
    throw new ValidationError('kind must be "bbox" or "classification"');
  }

  const label = resolveLabel(labelSet, input.label);

  const payload = {
    assetId: asset.id,
    datasetId: asset.datasetId,
    kind,
    label: label.value,
    width: asset.width,
    height: asset.height,
    note: typeof input.note === "string" ? input.note.slice(0, MAX_NOTE_LENGTH) : null,
    createdBy: user.userId,
    updatedBy: user.userId,
  };

  if (kind === "bbox") {
    if (!input.box) {
      throw new ValidationError("A bbox annotation requires a box");
    }
    if (input.pixelSpace) {
      if (!asset.width || !asset.height) {
        throw new ValidationError(
          "This image's dimensions are unknown, so a pixel box cannot be " +
            "converted. Send normalised coordinates instead.",
        );
      }
      const px = {
        x: input.box.x,
        y: input.box.y,
        width: input.box.width,
        height: input.box.height,
      };
      payload.x = px.x / asset.width;
      payload.y = px.y / asset.height;
      payload.boxWidth = px.width / asset.width;
      payload.boxHeight = px.height / asset.height;
    } else {
      payload.x = input.box.x;
      payload.y = input.box.y;
      payload.boxWidth = input.box.width;
      payload.boxHeight = input.box.height;
    }

    // A video annotation may target one frame. For an image both stay null.
    if (asset.kind === "video") {
      const frame = normalizeFrame({
        frameIndex: input.frameIndex,
        timestampMs: input.timestampMs,
        durationMs: asset.durationMs,
      });
      payload.frameIndex = frame.frameIndex;
      payload.timestampMs = frame.timestampMs;
    }

    let box;
    try {
      box = normalizeBox({
        x: payload.x,
        y: payload.y,
        width: payload.boxWidth,
        height: payload.boxHeight,
      });
    } catch (err) {
      if (err instanceof GeometryError) throw new ValidationError(err.message);
      throw err;
    }
    payload.x = box.x;
    payload.y = box.y;
    payload.boxWidth = box.width;
    payload.boxHeight = box.height;
  }

  const { id } = await MediaAnnotation.create(payload);
  const created = await MediaAnnotation.findById(id);

  // The version trail records the *initial* state, so a restore has something
  // to go back to.
  await MediaAnnotationVersion.create({
    annotationId: id,
    assetId: asset.id,
    datasetId: asset.datasetId,
    revision: 1,
    snapshot: snapshotOf(created),
    changedFields: TRACKED_FIELDS.slice(),
    changeType: "create",
    changedBy: user.userId,
    createdAt: new Date(),
  });

  await refreshCounts(asset.id, asset.datasetId);
  await audit({
    action: "media_annotation_create",
    actor: user,
    targetType: "media_annotation",
    targetId: id,
    metadata: { assetId: asset.id, kind, label: label.value },
  });
  return created;
}

/**
 * Patches an annotation.
 *
 * Geometry is re-validated on every write, not only on create. A client that
 * cached an annotation and sends a stale edit must not be able to write a box
 * outside the image.
 */
async function update(annotationId, patch, user) {
  const before = await get(annotationId);
  const { labelSet } = await requireLabelSet(before.datasetId);

  const set = { updatedBy: user.userId };

  if (Object.prototype.hasOwnProperty.call(patch, "label")) {
    set.label = resolveLabel(labelSet, patch.label).value;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "note")) {
    set.note = typeof patch.note === "string" ? patch.note.slice(0, MAX_NOTE_LENGTH) : null;
  }

  // Reconstruct the prospective geometry, then normalise the whole thing, so a
  // label-only edit cannot leave a box that is now inconsistent.
  if (before.kind === "bbox") {
    const asset = await MediaAsset.assertExists(before.assetId);
    let candidate = {
      x: before.box ? before.box.x : 0,
      y: before.box ? before.box.y : 0,
      width: before.box ? before.box.width : 0,
      height: before.box ? before.box.height : 0,
    };
    if (patch.box) {
      candidate = {
        x: patch.box.x !== undefined ? patch.box.x : candidate.x,
        y: patch.box.y !== undefined ? patch.box.y : candidate.y,
        width: patch.box.width !== undefined ? patch.box.width : candidate.width,
        height: patch.box.height !== undefined ? patch.box.height : candidate.height,
      };
      if (patch.pixelSpace) {
        if (!asset.width || !asset.height) {
          throw new ValidationError(
            "This image's dimensions are unknown, so a pixel box cannot be converted.",
          );
        }
        candidate = {
          x: candidate.x / asset.width,
          y: candidate.y / asset.height,
          width: candidate.width / asset.width,
          height: candidate.height / asset.height,
        };
      }
    }
    let box;
    try {
      box = normalizeBox(candidate);
    } catch (err) {
      if (err instanceof GeometryError) throw new ValidationError(err.message);
      throw err;
    }
    if (patch.box) {
      set.box = box;
    }

    if (Object.prototype.hasOwnProperty.call(patch, "frameIndex") ||
        Object.prototype.hasOwnProperty.call(patch, "timestampMs")) {
      if (asset.kind === "video") {
        const frame = normalizeFrame({
          frameIndex: patch.frameIndex !== undefined ? patch.frameIndex : before.frameIndex,
          timestampMs: patch.timestampMs !== undefined ? patch.timestampMs : before.timestampMs,
          durationMs: asset.durationMs,
        });
        set.frameIndex = frame.frameIndex;
        set.timestampMs = frame.timestampMs;
      }
    }
  }

  await MediaAnnotation.updateById(before.id, set);
  const after = await MediaAnnotation.findById(before.id);
  const changed = diffFields(snapshotOf(before), snapshotOf(after));
  if (changed.length) {
    await MediaAnnotationVersion.create({
      annotationId: before.id,
      assetId: before.assetId,
      datasetId: before.datasetId,
      revision: after.revision,
      snapshot: snapshotOf(after),
      changedFields: changed,
      changeType: "update",
      changedBy: user.userId,
      createdAt: new Date(),
    });
  }

  await refreshCounts(before.assetId, before.datasetId);
  await audit({
    action: "media_annotation_update",
    actor: user,
    targetType: "media_annotation",
    targetId: before.id,
    metadata: { changedFields: changed },
  });
  return after;
}

/**
 * Deletes an annotation.
 *
 * The version row is deliberately left behind. It is the record that the
 * annotation existed, what it contained, and who removed it — which is the
 * whole point of an audit trail.
 */
async function remove(annotationId, user) {
  const annotation = await get(annotationId);
  await MediaAnnotationVersion.create({
    annotationId: annotation.id,
    assetId: annotation.assetId,
    datasetId: annotation.datasetId,
    // One past the annotation's own revision, not the same number. Reusing it
    // would leave two history rows at the same revision — the update that
    // produced this state, and the delete of it — and the history is sorted by
    // revision, so "the most recent change" would then depend on which of the
    // two an engine happened to return first. `restore` reads exactly that row,
    // so the ambiguity would surface as a restore that randomly refuses.
    revision: annotation.revision + 1,
    snapshot: snapshotOf(annotation),
    changedFields: [],
    changeType: "delete",
    changedBy: user.userId,
    createdAt: new Date(),
  });
  const r = await MediaAnnotation.deleteById(annotation.id);
  await refreshCounts(annotation.assetId, annotation.datasetId);
  await audit({
    action: "media_annotation_delete",
    actor: user,
    targetType: "media_annotation",
    targetId: annotation.id,
    metadata: { label: annotation.label, kind: annotation.kind },
  });
  return r;
}

/**
 * Restores a deleted annotation from a version snapshot.
 *
 * Restoring creates a *new* annotation with revision 1 and links back via
 * `restoredFrom`, rather than resurrecting the old row. That keeps history
 * append-only: the delete and the restore are both visible, and neither
 * rewrites the other.
 */
async function restore(annotationId, user) {
  const versions = await MediaAnnotationVersion.findByAnnotationId(String(annotationId));
  if (!versions.length) {
    throw new NotFoundError("No history for this annotation");
  }
  const live = await MediaAnnotation.findById(annotationId);
  if (live) {
    throw new ValidationError("This annotation is not deleted; edit it instead");
  }
  const latest = versions[0];
  if (latest.changeType !== "delete") {
    throw new ValidationError("The most recent change was not a deletion");
  }

  const { id } = await MediaAnnotation.create({
    ...latest.snapshot,
    createdBy: user.userId,
    updatedBy: user.userId,
  });
  await MediaAnnotationVersion.create({
    annotationId: id,
    assetId: latest.assetId,
    datasetId: latest.datasetId,
    revision: 1,
    snapshot: latest.snapshot,
    changedFields: [],
    changeType: "restore",
    restoredFrom: latest.revision,
    changedBy: user.userId,
    createdAt: new Date(),
  });
  await refreshCounts(latest.assetId, latest.datasetId);
  await audit({
    action: "media_annotation_restore",
    actor: user,
    targetType: "media_annotation",
    targetId: id,
    metadata: { fromAnnotation: annotationId },
  });
  return MediaAnnotation.findById(id);
}

module.exports = {
  MAX_NOTE_LENGTH,
  TRACKED_FIELDS,
  snapshotOf,
  diffFields,
  refreshCounts,
  listForAsset,
  get,
  listForDataset,
  history,
  create,
  update,
  remove,
  restore,
};
