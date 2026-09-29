// services/mediaLabelService.js
// Label-set rules: the detection class vocabulary behind every media dataset.
//
// A label set is the detection equivalent of a taxonomy — the flat list of
// classes an annotator may assign. It lives in its own service because the
// rules differ from the text domain's in one important way:
//
//   In the text domain, sentiment and type are two independent label *axes* and
//   a taxonomy can be edited freely, because an annotation stores the label
//   text itself.
//
//   In the detection domain, an annotation stores the label's **slug**, and
//   that slug becomes a class *index* in the exported file. Renaming a slug
//   therefore does not rename a class — it deletes the old class and creates a
//   new one, silently orphaning every existing annotation that referenced it.
//
// The rules below exist to make that mistake hard to make.

const {
  MediaLabelSet,
  MediaDataset,
  MediaAnnotation,
} = require("../models");
const { ValidationError, ConflictError, NotFoundError } = require("../models/errors");
const { audit } = require("../utils/audit");

const MAX_LABELS = 200;
const MAX_LABEL_LENGTH = 64;

/**
 * Slugifies a display name into a stable export-safe class value.
 *
 * COCO category names and YOLO class names are consumed by training scripts
 * and by downstream tooling, so the character set is deliberately conservative:
 * lower-case ASCII letters, digits and single underscores. Anything else is
 * dropped rather than transliterated, because a surprising transliteration
 * ("Café" -> "café" vs "cafe") is worse than a visible gap.
 */
function slugify(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFKD")
    // Strip the combining marks NFKD leaves behind, so "Café" becomes "cafe".
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, MAX_LABEL_LENGTH);
}

/** Assigns a stable colour per label so the annotator UI is consistent. */
function colorForIndex(index) {
  // Evenly spaced hues. Saturation/lightness are fixed so no label renders
  // unusably light or dark against the canvas.
  const hue = (index * 137.508) % 360;
  return `hsl(${Math.round(hue)}, 65%, 55%)`;
}

/**
 * Normalises a caller-supplied label array into the stored shape.
 *
 * Accepts either plain strings ("cat") or objects
 * ({ label, value, color }). Duplicate slugs are rejected rather than silently
 * collapsed, because two entries with the same slug would export as two
 * classes that the training set cannot tell apart.
 */
function normalizeLabels(input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ValidationError("A label set needs at least one label");
  }
  if (input.length > MAX_LABELS) {
    throw new ValidationError(`A label set may hold at most ${MAX_LABELS} labels`);
  }

  const seen = new Set();
  return input.map((entry, index) => {
    const raw = typeof entry === "string" ? entry : entry && entry.label;
    if (!raw || !String(raw).trim()) {
      throw new ValidationError(`Label ${index + 1} is empty`);
    }
    const display = String(raw).trim();
    if (display.length > MAX_LABEL_LENGTH) {
      throw new ValidationError(
        `Label "${display}" exceeds ${MAX_LABEL_LENGTH} characters`,
      );
    }
    const supplied = typeof entry === "object" && entry ? entry.value : null;
    const value = slugify(supplied || display);
    if (!value) {
      throw new ValidationError(
        `Label "${display}" has no usable characters for a class name`,
      );
    }
    if (seen.has(value)) {
      throw new ValidationError(
        `Duplicate class name "${value}" — every label needs a unique value`,
      );
    }
    seen.add(value);
    const color =
      (typeof entry === "object" && entry && entry.color) || colorForIndex(index);
    return { value, label: display, color };
  });
}

/** True when `value` is a member of the label set. */
function hasLabel(labelSet, value) {
  if (!labelSet || !Array.isArray(labelSet.labels)) return false;
  return labelSet.labels.some((l) => l.value === value);
}

/**
 * Resolves a caller-supplied label to its canonical stored form.
 *
 * Accepts the slug or the display text, because a client may legitimately send
 * either. Returns the canonical entry so the stored annotation always holds
 * the slug, whatever the caller typed.
 */
function resolveLabel(labelSet, value) {
  if (!labelSet || !Array.isArray(labelSet.labels)) {
    throw new ValidationError("This dataset has no label set assigned");
  }
  const wanted = String(value || "").trim();
  if (!wanted) throw new ValidationError("A label is required");
  const hit =
    labelSet.labels.find((l) => l.value === wanted) ||
    labelSet.labels.find((l) => l.label.toLowerCase() === wanted.toLowerCase());
  if (!hit) {
    throw new ValidationError(
      `"${wanted}" is not a label in this dataset's label set`,
    );
  }
  return hit;
}

/** Rejects a label-set edit that would orphan an existing annotation. */
function assertNoOrphanedLabels(current, next) {
  const nextValues = new Set(next.map((l) => l.value));
  const removed = (current.labels || [])
    .map((l) => l.value)
    .filter((v) => !nextValues.has(v));
  return removed;
}

// --- CRUD ------------------------------------------------------------------

async function list({ includeInactive = false } = {}) {
  return MediaLabelSet.findMany({ includeInactive });
}

async function get(id) {
  const found = await MediaLabelSet.findById(id);
  if (!found) throw new NotFoundError("Label set not found");
  return found;
}

async function create({ name, description, labels }, user) {
  const normalized = normalizeLabels(labels);
  const { id } = await MediaLabelSet.create({
    name,
    description,
    labels: normalized,
    createdBy: user.userId,
    updatedBy: user.userId,
  });
  await audit({
    action: "media_label_set_create",
    actor: user,
    targetType: "media_label_set",
    targetId: id,
    metadata: { name, labelCount: normalized.length },
  });
  return get(id);
}

async function update(id, patch, user) {
  const current = await get(id);
  let next = current.labels;
  if (Array.isArray(patch.labels)) {
    next = normalizeLabels(patch.labels);
    const removed = assertNoOrphanedLabels(current, next);
    // Removing a class is allowed, but only once nothing references it. A
    // dataset with existing boxes of that class would export with a class list
    // that omits them, producing annotations the training script cannot map.
    if (removed.length) {
      const datasets = await MediaDataset.findMany({ page: 1, limit: 200 });
      const bound = datasets.datasets.filter((d) => d.labelSetId === current.id);
      for (const dataset of bound) {
        const used = await MediaAnnotation.distinctLabels(dataset.id);
        const orphaned = removed.filter((v) => used.includes(v));
        if (orphaned.length) {
          throw new ConflictError(
            `Cannot remove ${orphaned.join(", ")}: still used by dataset "${dataset.name}"`,
          );
        }
      }
    }
  }
  await MediaLabelSet.updateById(id, { ...patch, labels: next });
  await audit({
    action: "media_label_set_update",
    actor: user,
    targetType: "media_label_set",
    targetId: id,
    metadata: { name: patch.name, labelCount: next.length },
  });
  return get(id);
}

async function remove(id, user) {
  await get(id);
  // Deleting a label set in use would leave every dataset bound to a
  // vocabulary that no longer exists.
  const datasets = await MediaDataset.findMany({ page: 1, limit: 200 });
  const bound = datasets.datasets.filter((d) => d.labelSetId === id);
  if (bound.length) {
    throw new ConflictError(
      `Cannot delete: still assigned to ${bound.length} dataset(s)`,
    );
  }
  const r = await MediaLabelSet.deleteById(id);
  await audit({
    action: "media_label_set_delete",
    actor: user,
    targetType: "media_label_set",
    targetId: id,
    metadata: {},
  });
  return r;
}

module.exports = {
  MAX_LABELS,
  slugify,
  colorForIndex,
  normalizeLabels,
  hasLabel,
  resolveLabel,
  list,
  get,
  create,
  update,
  remove,
};
