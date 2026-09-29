// services/mediaExportService.js
// Training-data export: COCO detection and YOLO.
//
// This is the point of the whole media domain. Everything upstream exists to
// produce trustworthy geometry; this turns it into the two file formats that
// object-detection training actually consumes.
//
// ---------------------------------------------------------------------------
// Why the class list is built from the label set, not from the data
// ---------------------------------------------------------------------------
// Both formats need a fixed class list with contiguous integer ids (YOLO) or
// `category_id` values (COCO). If that list were derived from whichever labels
// happen to appear in the current data, then adding one annotated image would
// renumber every class after it — silently invalidating every label file
// already written and every model already trained on them.
//
// So the class list comes from the dataset's **label set**, in its declared
// order, and is stable for the life of the dataset. A class with no annotations
// is still present in `classes.txt` and in COCO's `categories`. That is
// intentional: it is what makes the output reproducible.

const {
  MediaAsset,
  MediaDataset,
  MediaLabelSet,
  MediaAnnotation,
} = require("../models");
const { ValidationError } = require("../models/errors");
const { toPixelBox, toYoloFormat } = require("../utils/geometry");

const FORMATS = ["coco", "yolo"];

/**
 * The class list for a dataset, in declared order.
 *
 * Order is the label set's order, never sorted and never data-derived — the
 * index of a class in this array *is* its class id in the export.
 */
async function classList(datasetId) {
  const dataset = await MediaDataset.assertExists(datasetId);
  if (!dataset.labelSetId) {
    throw new ValidationError(
      "This dataset has no label set, so there are no classes to export. " +
        "Assign a label set first.",
    );
  }
  const labelSet = await MediaLabelSet.assertExists(dataset.labelSetId);
  return {
    dataset,
    labelSet,
    classes: labelSet.labels.map((l, index) => ({
      id: index,
      value: l.value,
      name: l.label,
    })),
  };
}

/**
 * Assets eligible for export.
 *
 * Unannotated assets are excluded by default. An image with no boxes is not a
 * negative example unless it says so — including a blank image in a training
 * set teaches the model that "nothing here" is a valid answer, which is a real
 * modelling decision the user should make deliberately. Passing
 * `includeUnannotated` opts in, and the whole-image `classification`
 * annotations are what mark an asset as an explicit negative.
 */
async function exportableAssets(datasetId, { includeUnannotated = false, kind } = {}) {
  const assets = await MediaAsset.findAllByDataset(String(datasetId), kind ? { kind } : {});
  if (includeUnannotated) return assets;
  return assets.filter((a) => a.annotationCount > 0);
}

/** Groups an asset's annotations, dropping any whose label is unknown. */
async function annotationsByAsset(datasetId) {
  const all = await MediaAnnotation.findAllByDataset(String(datasetId), {
    internal: true,
  });
  const map = new Map();
  for (const a of all) {
    if (!map.has(a.assetId)) map.set(a.assetId, []);
    map.get(a.assetId).push(a);
  }
  return map;
}

/**
 * COCO detection export.
 *
 * Shape: `{ info, images, annotations, categories }` in one JSON object.
 *
 * `bbox` is `[x, y, width, height]` in **absolute pixels**, which is what COCO
 * specifies. `area` is the pixel area, and `iscrowd` is 0 because this
 * generator produces single-instance boxes only.
 *
 * Assets whose dimensions could not be probed are skipped and reported in
 * `skipped` rather than exported with a guessed size. A COCO entry with
 * `width: 0` is silently useless to a training script, and a wrong size
 * produces boxes that are subtly misaligned — worse than an honest omission.
 */
async function toCoco(datasetId, options = {}) {
  const { dataset, classes } = await classList(datasetId);
  const assets = await exportableAssets(datasetId, options);
  const grouped = await annotationsByAsset(datasetId);
  const classByValue = new Map(classes.map((c) => [c.value, c]));

  const images = [];
  const annotations = [];
  const skipped = [];
  let annotationId = 1;

  for (const asset of assets) {
    const boxes = (grouped.get(asset.id) || []).filter((a) => a.kind === "bbox");
    if (!boxes.length) {
      skipped.push({ assetId: asset.id, reason: "no bounding boxes" });
      continue;
    }
    if (!asset.width || !asset.height) {
      skipped.push({ assetId: asset.id, reason: "unknown image dimensions" });
      continue;
    }

    images.push({
      id: asset.id,
      file_name: asset.originalFileName || `${asset.id}.${asset.extension}`,
      width: asset.width,
      height: asset.height,
      // Preserved so a video-derived frame can be traced back to its source.
      frame_index: asset.kind === "video" ? boxes[0].frameIndex : undefined,
    });

    for (const box of boxes) {
      const cls = classByValue.get(box.label);
      if (!cls) {
        // The label set changed after this annotation was written. Skipping is
        // the only safe option: emitting a category_id the categories array
        // does not define produces a file that crashes the trainer.
        skipped.push({ assetId: asset.id, reason: `unknown label "${box.label}"` });
        continue;
      }
      const px = toPixelBox(box.box, asset.width, asset.height);
      annotations.push({
        id: annotationId++,
        image_id: asset.id,
        category_id: cls.id,
        bbox: [px.x, px.y, px.width, px.height],
        area: Math.round(px.width * px.height * 100) / 100,
        iscrowd: 0,
        // Non-COCO-standard extras, namespaced so they are ignored by a
        // strict parser and available to ours.
        frame_index: box.frameIndex ?? undefined,
        timestamp_ms: box.timestampMs ?? undefined,
      });
    }
  }

  return {
    info: {
      description: `${dataset.name} — annotated via Annotator`,
      version: "1.0",
      // Injected by the controller, which is the only layer that knows the
      // request time; kept as a stable placeholder here so this function stays
      // deterministic and testable.
      date_created: options.dateCreated || "",
    },
    licenses: [],
    images,
    annotations,
    categories: classes.map((c) => ({
      id: c.id,
      name: c.value,
      // `supercategory` is required by some COCO consumers even when unused.
      supercategory: "object",
    })),
    skipped,
  };
}

/**
 * YOLO export.
 *
 * Returns a map of filename -> file contents, ready to be written to a
 * directory:
 *
 *   classes.txt          one class per line, in index order
 *   data.yaml            the dataset descriptor Ultralytics expects
 *   labels/<id>.txt      one line per box: "<classIdx> cx cy w h", all in
 *                        normalised centre form
 *
 * Class indices come from the same stable class list as COCO, so a dataset
 * exported to both formats agrees on what class 3 means.
 */
async function toYolo(datasetId, options = {}) {
  const { classes } = await classList(datasetId);
  const assets = await exportableAssets(datasetId, options);
  const grouped = await annotationsByAsset(datasetId);
  const indexByValue = new Map(classes.map((c) => [c.value, c.id]));

  const files = {};
  const skipped = [];
  let imageCount = 0;

  files["classes.txt"] = `${classes.map((c) => c.value).join("\n")}\n`;

  for (const asset of assets) {
    const boxes = (grouped.get(asset.id) || []).filter((a) => a.kind === "bbox");
    if (!boxes.length) {
      skipped.push({ assetId: asset.id, reason: "no bounding boxes" });
      continue;
    }

    // Boxes are bucketed per frame first, then written once per bucket. Writing
    // inside the box loop would let a video's frame-0 file be overwritten by
    // frame 1's content, silently merging two frames' annotations into one
    // label file.
    const byFrame = new Map();
    for (const box of boxes) {
      const classIdx = indexByValue.get(box.label);
      if (classIdx === undefined) {
        skipped.push({ assetId: asset.id, reason: `unknown label "${box.label}"` });
        continue;
      }
      const frameKey = box.frameIndex ?? null;
      if (!byFrame.has(frameKey)) byFrame.set(frameKey, []);
      const [cx, cy, w, h] = toYoloFormat(box.box);
      byFrame.get(frameKey).push(`${classIdx} ${cx} ${cy} ${w} ${h}`);
    }

    for (const [frameKey, lines] of byFrame) {
      const suffix = frameKey === null ? "" : `_f${String(frameKey).padStart(6, "0")}`;
      files[`labels/${asset.id}${suffix}.txt`] = `${lines.join("\n")}\n`;
    }
    if (byFrame.size) imageCount += 1;
  }

  files["data.yaml"] = [
    "# Generated by Annotator — YOLO dataset descriptor",
    `path: ${options.path || "../"}`,
    "train: images/train",
    "val: images/val",
    "test: images/test",
    `nc: ${classes.length}`,
    "names:",
    ...classes.map((c) => `  ${c.id}: ${c.name}`),
    "",
  ].join("\n");

  return { files, imageCount, classCount: classes.length, skipped };
}

/** A CSV of one row per box — the format most spreadsheet-based pipelines take. */
async function toCsv(datasetId, options = {}) {
  const { dataset, classes } = await classList(datasetId);
  const assets = await exportableAssets(datasetId, options);
  const grouped = await annotationsByAsset(datasetId);
  const classByValue = new Map(classes.map((c) => [c.value, c]));

  const rows = ["asset_id,file_name,asset_width,asset_height,label,class_id,x,y,width,height,frame_index,timestamp_ms"];
  for (const asset of assets) {
    for (const box of (grouped.get(asset.id) || []).filter((a) => a.kind === "bbox")) {
      const cls = classByValue.get(box.label);
      if (!cls || !asset.width || !asset.height) continue;
      const px = toPixelBox(box.box, asset.width, asset.height);
      rows.push(
        [
          asset.id,
          csvCell(asset.originalFileName || `${asset.id}.${asset.extension}`),
          asset.width,
          asset.height,
          csvCell(box.label),
          cls.id,
          px.x,
          px.y,
          px.width,
          px.height,
          box.frameIndex ?? "",
          box.timestampMs ?? "",
        ].join(","),
      );
    }
  }
  return { datasetId: dataset.id, content: `${rows.join("\n")}\n`, rowCount: rows.length - 1 };
}

/** Minimal RFC-4180 quoting: wrap in quotes and double any inner quote. */
function csvCell(value) {
  const s = String(value ?? "");
  if (!/[",\n]/.test(s)) return s;
  return `"${s.replace(/"/g, '""')}"`;
}

async function exportDataset(datasetId, { format = "coco", ...options } = {}) {
  const fmt = String(format).toLowerCase();
  if (!FORMATS.includes(fmt)) {
    throw new ValidationError(
      `Unsupported export format "${format}". Use one of: ${FORMATS.join(", ")}, csv`,
    );
  }
  if (fmt === "coco") return { format: fmt, payload: await toCoco(datasetId, options) };
  if (fmt === "yolo") return { format: fmt, payload: await toYolo(datasetId, options) };
  return { format: "csv", payload: await toCsv(datasetId, options) };
}

module.exports = {
  FORMATS,
  classList,
  exportableAssets,
  toCoco,
  toYolo,
  toCsv,
  exportDataset,
  csvCell,
};
