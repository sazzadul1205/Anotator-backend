// controllers/mediaController.js
// Thin HTTP wrappers around mediaService, annotationService,
// mediaLabelService and mediaExportService.

const fs = require("fs");
const path = require("path");

const media = require("../config/media");
const mediaService = require("../services/mediaService");
const annotationService = require("../services/annotationService");
const mediaLabelService = require("../services/mediaLabelService");
const mediaExportService = require("../services/mediaExportService");
const { MediaAsset } = require("../models");

/** Coerces a query-string page/limit pair into numbers. */
function paging(query) {
  return {
    page: Number.parseInt(query.page, 10) || 1,
    limit: Number.parseInt(query.limit, 10) || 50,
    sortBy: query.sortBy || undefined,
    sortDir: query.sortDir === "asc" ? 1 : query.sortDir === "desc" ? -1 : undefined,
  };
}

// --- Datasets --------------------------------------------------------------

async function listDatasets(req, res, next) {
  try {
    const result = await mediaService.listDatasets(paging(req.query));
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

async function getDataset(req, res, next) {
  try {
    res.json({ success: true, data: await mediaService.getDataset(req.params.id) });
  } catch (err) {
    next(err);
  }
}

async function getDatasetStats(req, res, next) {
  try {
    res.json({
      success: true,
      data: await mediaService.getDatasetStats(req.params.id),
    });
  } catch (err) {
    next(err);
  }
}

async function createDataset(req, res, next) {
  try {
    const data = await mediaService.createDataset(req.body, req.user);
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function updateDataset(req, res, next) {
  try {
    const data = await mediaService.updateDataset(req.params.id, req.body, req.user);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function deleteDataset(req, res, next) {
  try {
    const data = await mediaService.deleteDataset(req.params.id, req.user);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// --- Assets ----------------------------------------------------------------

async function listAssets(req, res, next) {
  try {
    const result = await mediaService.listAssets(req.params.id, {
      ...paging(req.query),
      status: req.query.status,
      kind: req.query.kind,
      excludeAnnotated: req.query.excludeAnnotated === "true",
    });
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

async function getAsset(req, res, next) {
  try {
    res.json({ success: true, data: await mediaService.getAsset(req.params.id) });
  } catch (err) {
    next(err);
  }
}

async function uploadAssets(req, res, next) {
  try {
    const files = req.files || (req.file ? [req.file] : []);
    const result = await mediaService.storeAssets(req.params.id, files, req.user);
    // 201 when everything landed, 207 when some files were rejected. A partial
    // success is a real outcome for a folder upload, and reporting it as a
    // plain 200 would let a client assume the whole folder imported cleanly.
    const status = result.failed.length === 0 ? 201 : 207;
    res.status(status).json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

async function assignAsset(req, res, next) {
  try {
    const data = await mediaService.assignAsset(
      req.params.id,
      req.body.assignedTo,
      req.user,
    );
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function deleteAsset(req, res, next) {
  try {
    res.json({ success: true, data: await mediaService.deleteAsset(req.params.id, req.user) });
  } catch (err) {
    next(err);
  }
}

/**
 * Streams an asset's bytes.
 *
 * This is the ONLY way a client can read an uploaded file, and it is
 * authenticated on purpose: `express.static(mediaRoot)` would hand every image
 * to anyone who could construct a URL, and annotation data is rarely public.
 *
 * Range support is not optional here. A browser will not let a `<video>` seek
 * without `Accept-Ranges`/`206` responses, so serving a video as one opaque
 * blob would make scrubbing impossible — which is the entire video
 * annotation workflow.
 */
async function getAssetFile(req, res, next) {
  try {
    const raw = await MediaAsset.findRawById(req.params.id);
    if (!raw) {
      return res.status(404).json({ success: false, error: "Asset not found" });
    }
    const stat = await media.stat(raw.storagePath);
    if (!stat) {
      // The record exists but the bytes are gone. That is a real, reportable
      // state (a volume was remounted, a file was removed out of band) and it
      // is worth a distinct code so a client can re-upload just this asset.
      return res.status(410).json({
        success: false,
        error: "The stored file is missing from disk",
        data: { assetId: raw._id ? String(raw._id) : null },
      });
    }

    const total = stat.size;
    const range = req.headers.range;
    res.setHeader("Content-Type", raw.mimeType || "application/octet-stream");
    res.setHeader("Accept-Ranges", "bytes");
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.setHeader("Content-Disposition", `inline; filename="${encodeURIComponent(raw.originalFileName || "file")}"`);

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (match) {
        const startRaw = match[1];
        const endRaw = match[2];
        let start = startRaw === "" ? null : Number.parseInt(startRaw, 10);
        let end = endRaw === "" ? null : Number.parseInt(endRaw, 10);

        // A suffix range ("bytes=-500") means the final N bytes.
        if (start === null) {
          const suffixLength = end ?? 0;
          start = Math.max(0, total - suffixLength);
          end = total - 1;
        } else if (end === null || end >= total) {
          end = total - 1;
        }

        if (Number.isNaN(start) || start > end || start >= total) {
          res.setHeader("Content-Range", `bytes */${total}`);
          return res.status(416).json({ success: false, error: "Range not satisfiable" });
        }

        res.status(206);
        res.setHeader("Content-Range", `bytes ${start}-${end}/${total}`);
        res.setHeader("Content-Length", String(end - start + 1));
        return fs.createReadStream(media.resolveSafe(raw.storagePath), { start, end })
          .pipe(res);
      }
    }

    res.setHeader("Content-Length", String(total));
    return media.createReadStream(raw.storagePath).pipe(res);
  } catch (err) {
    next(err);
  }
}

// --- Annotations -----------------------------------------------------------

async function listAssetAnnotations(req, res, next) {
  try {
    res.json({
      success: true,
      data: await annotationService.listForAsset(req.params.id),
    });
  } catch (err) {
    next(err);
  }
}

async function createAnnotation(req, res, next) {
  try {
    const data = await annotationService.create(req.params.id, req.body, req.user);
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function listDatasetAnnotations(req, res, next) {
  try {
    const result = await annotationService.listForDataset(req.params.id, paging(req.query));
    res.json({ success: true, data: result });
  } catch (err) {
    next(err);
  }
}

async function updateAnnotation(req, res, next) {
  try {
    const data = await annotationService.update(req.params.id, req.body, req.user);
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function deleteAnnotation(req, res, next) {
  try {
    res.json({
      success: true,
      data: await annotationService.remove(req.params.id, req.user),
    });
  } catch (err) {
    next(err);
  }
}

async function annotationHistory(req, res, next) {
  try {
    res.json({
      success: true,
      data: await annotationService.history(req.params.id),
    });
  } catch (err) {
    next(err);
  }
}

async function restoreAnnotation(req, res, next) {
  try {
    const data = await annotationService.restore(req.params.id, req.user);
    res.status(201).json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

// --- Label sets ------------------------------------------------------------

async function listLabelSets(req, res, next) {
  try {
    const data = await mediaLabelService.list({
      includeInactive: req.query.includeInactive === "true",
    });
    res.json({ success: true, data });
  } catch (err) {
    next(err);
  }
}

async function createLabelSet(req, res, next) {
  try {
    res.status(201).json({
      success: true,
      data: await mediaLabelService.create(req.body, req.user),
    });
  } catch (err) {
    next(err);
  }
}

async function updateLabelSet(req, res, next) {
  try {
    res.json({
      success: true,
      data: await mediaLabelService.update(req.params.id, req.body, req.user),
    });
  } catch (err) {
    next(err);
  }
}

async function deleteLabelSet(req, res, next) {
  try {
    res.json({
      success: true,
      data: await mediaLabelService.remove(req.params.id, req.user),
    });
  } catch (err) {
    next(err);
  }
}

// --- Export ----------------------------------------------------------------

/** Basename safe for a download filename. */
function safeFilename(value, fallback) {
  const base = path.basename(String(value || "")).replace(/[^a-zA-Z0-9._-]+/g, "_");
  return base || fallback;
}

async function exportDataset(req, res, next) {
  try {
    const format = String(req.query.format || "coco").toLowerCase();
    const options = {
      includeUnannotated: req.query.includeUnannotated === "true",
      kind: req.query.kind || undefined,
      // YOLO's data.yaml needs a path; default to a relative layout the
      // Ultralytics CLI understands.
      path: req.query.path || "../",
      dateCreated: new Date().toISOString(),
    };
    const result = await mediaExportService.exportDataset(req.params.id, { format, ...options });

    if (format === "yolo") {
      // YOLO is a directory, not a file, so it is delivered as a zip-less JSON
      // map of filename -> contents. A real zip would need a dependency, and
      // the client assembles the directory from this map.
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      return res.json({ success: true, data: result.payload });
    }
    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${safeFilename(req.params.id, "dataset")}-annotations.csv"`,
      );
      return res.send(result.payload.content);
    }
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeFilename(req.params.id, "dataset")}-coco.json"`,
    );
    return res.send(JSON.stringify(result.payload, null, 2));
  } catch (err) {
    next(err);
  }
}

module.exports = {
  listDatasets,
  getDataset,
  getDatasetStats,
  createDataset,
  updateDataset,
  deleteDataset,
  listAssets,
  getAsset,
  uploadAssets,
  assignAsset,
  deleteAsset,
  getAssetFile,
  listAssetAnnotations,
  createAnnotation,
  listDatasetAnnotations,
  updateAnnotation,
  deleteAnnotation,
  annotationHistory,
  restoreAnnotation,
  listLabelSets,
  createLabelSet,
  updateLabelSet,
  deleteLabelSet,
  exportDataset,
};
