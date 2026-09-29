// services/mediaService.js
// Media dataset and asset rules: upload, assignment, and the cascade delete.
//
// This is the layer that owns the *file* lifecycle, which is the one thing the
// record layer cannot. A dataset is not just rows: deleting it must also
// unlink every image and video, or the disk usage is leaked forever and
// re-uploading the same dataset name silently doubles the footprint.

const crypto = require("crypto");
const path = require("path");

const { config } = require("../config/app");
const media = require("../config/media");
const { probeImage, probeVideo } = require("../utils/mediaProbe");
const { MediaDataset, MediaAsset, MediaAnnotation, MediaAnnotationVersion, MediaLabelSet } = require("../models");
const { ValidationError, NotFoundError, ConflictError } = require("../models/errors");
const { audit } = require("../utils/audit");

const MEDIA_KINDS = ["image", "video", "mixed"];

// --- Filename handling -----------------------------------------------------

/**
 * Extracts and validates the extension of an uploaded file.
 *
 * The extension — not `req.file.mimetype` — is the authority, because the MIME
 * type is a header the client chose and can set to anything. The client sends a
 * filename; we reduce it to a slug on an allow-list and reject everything else.
 */
function classifyUpload(file) {
  const name = String(file.originalname || "");
  const ext = path.extname(name).replace(/^\./, "").toLowerCase();
  if (!ext) {
    throw new ValidationError(`"${name}" has no file extension`);
  }
  if (config.media.imageExtensions.includes(ext)) {
    return { kind: "image", extension: ext };
  }
  if (config.media.videoExtensions.includes(ext)) {
    return { kind: "video", extension: ext };
  }
  throw new ValidationError(
    `Unsupported file type ".${ext}". Allowed images: ${config.media.imageExtensions.join(", ")}; ` +
      `allowed videos: ${config.media.videoExtensions.join(", ")}`,
  );
}

/** SHA-256 of the bytes, used to reject a re-upload of a file already present. */
function checksum(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Recomputes the denormalised counters on a dataset.
 *
 * Called after every upload, annotation and delete. The alternative — deriving
 * these in the list query — would mean an aggregate per row for a grid that
 * shows a progress badge per dataset, which is the most-opened screen in the
 * media half of the app.
 */
async function refreshDatasetCounters(datasetId) {
  const oid = String(datasetId);
  const [status, totalBytes, totalAnnotations] = await Promise.all([
    MediaAsset.countByStatus(oid),
    MediaAsset.sumBytes(oid),
    MediaAnnotation.countByDataset(oid),
  ]);
  await MediaDataset.setCounters(oid, {
    totalAssets: status.total,
    annotatedAssets: status.annotated,
    totalAnnotations,
    totalBytes,
  });
  return { ...status, totalBytes, totalAnnotations };
}

// --- Datasets --------------------------------------------------------------

async function listDatasets({ page = 1, limit = 50 } = {}) {
  return MediaDataset.findMany({ page, limit });
}

async function getDataset(id) {
  const dataset = await MediaDataset.assertExists(id);
  return { ...dataset, stats: await getDatasetStats(id) };
}

async function getDatasetStats(datasetId) {
  const oid = String(datasetId);
  const [byStatus, byKind, labelHistogram] = await Promise.all([
    MediaAsset.countByStatus(oid),
    MediaAsset.countByKind(oid),
    MediaAnnotation.labelHistogram(oid),
  ]);
  const totalBoxes = labelHistogram.reduce((sum, row) => sum + row.count, 0);
  // Shannon entropy over the box distribution: 0 means every box has the same
  // class (useless for training), log2(n) means perfectly balanced. Expressed
  // as a 0..1 ratio so it reads the same way as the text analytics do.
  let balance = 0;
  if (totalBoxes > 0 && labelHistogram.length > 1) {
    const h = labelHistogram.reduce((acc, row) => {
      const p = row.count / totalBoxes;
      return acc - p * Math.log2(p);
    }, 0);
    balance = Math.round((h / Math.log2(labelHistogram.length)) * 100) / 100;
  }
  return { byStatus, byKind, labelHistogram, totalBoxes, classBalance: balance };
}

async function createDataset({ name, description, mediaKind, labelSetId }, user) {
  if (!name || !String(name).trim()) {
    throw new ValidationError("Dataset name is required");
  }
  if (mediaKind && !MEDIA_KINDS.includes(mediaKind)) {
    throw new ValidationError(`mediaKind must be one of: ${MEDIA_KINDS.join(", ")}`);
  }
  let labelSet = null;
  if (labelSetId) {
    labelSet = await MediaLabelSet.assertExists(labelSetId);
  }
  const { id } = await MediaDataset.create({
    name,
    description,
    mediaKind,
    labelSetId: labelSet ? labelSet.id : null,
    labelSetName: labelSet ? labelSet.name : null,
    createdBy: user.userId,
  });
  await audit({
    action: "media_dataset_create",
    actor: user,
    targetType: "media_dataset",
    targetId: id,
    metadata: { name, mediaKind },
  });
  return getDataset(id);
}

async function updateDataset(id, patch, user) {
  await MediaDataset.assertExists(id);
  if (patch.labelSetId) {
    const labelSet = await MediaLabelSet.assertExists(patch.labelSetId);
    const annotations = await MediaAnnotation.countByDataset(id);
    if (annotations > 0) {
      // Swapping the vocabulary after annotations exist would leave those
      // annotations referencing classes the new set does not define.
      throw new ConflictError(
        `Cannot change the label set: ${annotations} annotation(s) already reference the current one`,
      );
    }
    patch = { ...patch, labelSetName: labelSet.name };
  }
  await MediaDataset.updateById(id, patch);
  await audit({
    action: "media_dataset_update",
    actor: user,
    targetType: "media_dataset",
    targetId: id,
    metadata: { name: patch.name },
  });
  return getDataset(id);
}

/**
 * Deletes a dataset and everything hanging off it.
 *
 * The order matters. Records go first, files second: if the process dies
 * partway the worst outcome is an orphaned file (wasted disk, invisible to the
 * app) rather than a record pointing at a file that is gone (a broken image in
 * a dataset that otherwise looks intact).
 *
 * There are no transactions on any provider, so this cascade can be partial.
 * That is a known, accepted property of the whole codebase, not something this
 * method can fix.
 */
async function deleteDataset(id, user) {
  const dataset = await MediaDataset.assertExists(id);
  const oid = String(id);

  const annotations = await MediaAnnotation.findAllByDataset(oid, { internal: true });
  const assets = await MediaAsset.findAllByDataset(oid);

  await MediaAnnotationVersion.deleteByDatasetId(oid);
  await MediaAnnotation.deleteManyByDataset(oid);
  await MediaAsset.deleteManyByDataset(oid);
  const r = await MediaDataset.deleteById(oid);

  // Remove the directory last, and only after the records are gone.
  try {
    await media.removeDir(oid);
  } catch (err) {
    // The records are already deleted, so this is a disk-cleanup warning, not
    // a failed delete. Swallowing it here would be wrong; logging it keeps the
    // leak visible without failing a request the user already succeeded at.
    console.error(`[media] could not remove files for dataset ${oid}: ${err.message}`);
  }

  await audit({
    action: "media_dataset_delete",
    actor: user,
    targetType: "media_dataset",
    targetId: id,
    metadata: {
      name: dataset.name,
      assets: assets.length,
      annotations: annotations.length,
    },
  });
  return { ...r, assets: assets.length, annotations: annotations.length };
}

// --- Assets ----------------------------------------------------------------

async function listAssets(datasetId, query = {}) {
  await MediaDataset.assertExists(datasetId);
  return MediaAsset.findMany(
    { datasetId: String(datasetId), ...query },
    { page: query.page, limit: query.limit, sortBy: query.sortBy, sortDir: query.sortDir },
  );
}

async function getAsset(id) {
  const asset = await MediaAsset.assertExists(id);
  const annotations = await MediaAnnotation.findAllByAsset(String(id));
  return { ...asset, annotations };
}

/**
 * Stores one uploaded file and creates its asset record.
 *
 * The sequence is deliberate: probe and checksum first (cheap, in memory, can
 * still reject the file), then write to disk, then insert the record. If the
 * insert fails — a duplicate checksum is the common case — the file just
 * written is unlinked, so a rejected upload leaves nothing behind.
 */
async function storeAsset(datasetId, file, user) {
  const dataset = await MediaDataset.assertExists(datasetId);
  if (!file || !file.buffer || !file.buffer.length) {
    throw new ValidationError("Uploaded file is empty");
  }
  if (file.buffer.length > config.media.maxUploadBytes) {
    throw new ValidationError(
      `File exceeds the ${Math.round(config.media.maxUploadBytes / (1024 * 1024))} MB limit`,
    );
  }

  const { kind, extension } = classifyUpload(file);
  const limit = config.media.maxAssetsPerDataset;
  if (limit > 0 && dataset.totalAssets >= limit) {
    throw new ValidationError(
      `This dataset already holds its maximum of ${limit} assets`,
    );
  }

  const sha = checksum(file.buffer);
  const probe = kind === "image"
    ? probeImage(file.buffer)
    : probeVideo(file.buffer, extension);

  if (kind === "image" && probe.width && probe.height) {
    const pixels = probe.width * probe.height;
    if (pixels > config.media.maxPixels) {
      throw new ValidationError(
        `Image is ${probe.width}x${probe.height} (${pixels} pixels), above the ` +
          `${config.media.maxPixels} pixel limit`,
      );
    }
  }

  // The id is minted here rather than by the store because the on-disk path is
  // derived from it and must be known *before* the record is inserted. All
  // three providers honour a caller-supplied `_id`, so the id in the path and
  // the id in the document are the same value.
  const assetId = crypto.randomBytes(12).toString("hex");
  const storagePath = media.assetPath(String(datasetId), assetId, extension);

  let created;
  try {
    await media.put(storagePath, file.buffer);
    await MediaAsset.create({
      id: assetId,
      datasetId: String(datasetId),
      kind,
      originalFileName: String(file.originalname || `upload.${extension}`).slice(0, 255),
      extension,
      mimeType: file.mimetype || null,
      sizeBytes: file.buffer.length,
      checksum: sha,
      width: probe.width ?? null,
      height: probe.height ?? null,
      durationMs: probe.durationMs ?? null,
      storagePath,
      createdBy: user.userId,
      updatedBy: user.userId,
    });
    created = await MediaAsset.findById(assetId);
  } catch (err) {
    // Roll the file back so a rejected upload does not leak disk space.
    await media.remove(storagePath).catch(() => {});
    if (err instanceof ConflictError || err.code === 11000 ||
        (err.reason === "duplicate_file")) {
      throw new ConflictError(
        "This exact file is already in the dataset. Remove it first if you meant to replace it.",
      );
    }
    throw err;
  }

  await refreshDatasetCounters(datasetId);
  return created;
}

/**
 * Stores many files, reporting per-file outcomes.
 *
 * A batch upload is expected to be partly invalid — one misnamed file in a
 * folder of 200 should not discard the other 199. So this reports what
 * succeeded and what did not instead of failing the whole request.
 */
async function storeAssets(datasetId, files, user) {
  if (!Array.isArray(files) || !files.length) {
    throw new ValidationError("No files were uploaded");
  }
  if (files.length > config.media.maxFilesPerRequest) {
    throw new ValidationError(
      `Too many files in one request (max ${config.media.maxFilesPerRequest})`,
    );
  }
  const stored = [];
  const failed = [];
  for (const file of files) {
    try {
      stored.push(await storeAsset(datasetId, file, user));
    } catch (err) {
      failed.push({
        name: file.originalname,
        error: err.message,
      });
    }
  }
  await audit({
    action: "media_asset_upload",
    actor: user,
    targetType: "media_dataset",
    targetId: datasetId,
    metadata: { stored: stored.length, failed: failed.length },
  });
  return { stored, failed };
}

async function assignAsset(id, assigneeId, user) {
  const asset = await MediaAsset.assertExists(id);
  const now = new Date();
  await MediaAsset.updateById(id, {
    assignedTo: assigneeId || null,
    assignedAt: assigneeId ? now : null,
    assignedBy: user.userId,
  });
  await audit({
    action: assigneeId ? "media_asset_assign" : "media_asset_unassign",
    actor: user,
    targetType: "media_asset",
    targetId: id,
    metadata: { assignee: assigneeId || null },
  });
  return MediaAsset.findById(asset.id);
}

async function deleteAsset(id, user) {
  const raw = await MediaAsset.findRawById(id);
  if (!raw) throw new NotFoundError("Media asset not found");
  const oid = String(id);

  await MediaAnnotationVersion.deleteByAssetId(oid);
  await MediaAnnotation.deleteManyByAsset(oid);
  const r = await MediaAsset.deleteById(oid);
  // The record is gone, so a failure to unlink is a disk leak, not a broken
  // user-visible state. Log it rather than failing the delete.
  await media.remove(raw.storagePath).catch((err) => {
    console.error(`[media] could not remove file for asset ${oid}: ${err.message}`);
  });
  await refreshDatasetCounters(raw.datasetId);
  await audit({
    action: "media_asset_delete",
    actor: user,
    targetType: "media_asset",
    targetId: id,
    metadata: { name: raw.originalFileName },
  });
  return r;
}

module.exports = {
  MEDIA_KINDS,
  classifyUpload,
  checksum,
  refreshDatasetCounters,
  listDatasets,
  getDataset,
  getDatasetStats,
  createDataset,
  updateDataset,
  deleteDataset,
  listAssets,
  getAsset,
  storeAsset,
  storeAssets,
  assignAsset,
  deleteAsset,
};
