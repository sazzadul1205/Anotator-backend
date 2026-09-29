const express = require("express");
const multer = require("multer");
const mediaController = require("../controllers/mediaController");
const { verifyToken, verifyAdmin } = require("../middleware/auth");
const { config } = require("../config/app");

const router = express.Router();

// memoryStorage, not diskStorage: the file is written to the media store
// immediately afterwards, so a temp file would be a redundant second write.
// The trade-off is that the whole file sits in memory while it uploads, which
// is why MEDIA_MAX_UPLOAD_MB is a memory cap and not only a disk cap.
/**
 * The extension allow-list is the authority on what a file is, not the
 * browser-supplied MIME type — that header is attacker-controlled. Rejecting
 * here as well as in the service means an unrecognised file is refused before
 * its bytes are ever buffered, rather than after.
 *
 * This must be handed to multer as an *option*. It has the signature
 * `(req, file, done)`, which is not Express's `(req, res, next)`: wired as
 * middleware it would receive the response object as `file` and the extension
 * would always read as empty.
 */
function acceptMediaType(req, file, done) {
  const ext = String(file.originalname || "")
    .split(".")
    .pop()
    .toLowerCase();
  const ok =
    config.media.imageExtensions.includes(ext) ||
    config.media.videoExtensions.includes(ext);
  if (!ok) {
    const error = new Error(
      `Unsupported file type ".${ext}". Allowed: ` +
        [...config.media.imageExtensions, ...config.media.videoExtensions].join(", "),
    );
    // 400, not a bare 500: the client sent a file this endpoint will never
    // accept, and it should be able to tell that from a server fault.
    error.status = 400;
    return done(error);
  }
  done(null, true);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.media.maxUploadBytes,
    files: config.media.maxFilesPerRequest,
  },
  fileFilter: acceptMediaType,
});

// --- Label sets (admin-managed vocabulary) ---------------------------------
// Declared before the dataset routes so `/label-sets` is not captured by a
// `/:datasetId` parameter.
router.get("/label-sets", verifyToken, mediaController.listLabelSets);
router.post("/label-sets", verifyToken, verifyAdmin, mediaController.createLabelSet);
router.patch("/label-sets/:id", verifyToken, verifyAdmin, mediaController.updateLabelSet);
router.delete("/label-sets/:id", verifyToken, verifyAdmin, mediaController.deleteLabelSet);

// --- Datasets --------------------------------------------------------------
router.get("/datasets", verifyToken, mediaController.listDatasets);
router.post("/datasets", verifyToken, verifyAdmin, mediaController.createDataset);
router.get("/datasets/:id", verifyToken, mediaController.getDataset);
router.patch("/datasets/:id", verifyToken, verifyAdmin, mediaController.updateDataset);
router.delete("/datasets/:id", verifyToken, verifyAdmin, mediaController.deleteDataset);
router.get("/datasets/:id/stats", verifyToken, mediaController.getDatasetStats);
router.get("/datasets/:id/export", verifyToken, mediaController.exportDataset);

router.get("/datasets/:id/assets", verifyToken, mediaController.listAssets);
router.post(
  "/datasets/:id/assets",
  verifyToken,
  verifyAdmin,
  upload.array("files", config.media.maxFilesPerRequest),
  mediaController.uploadAssets,
);
router.get("/datasets/:id/annotations", verifyToken, mediaController.listDatasetAnnotations);

// --- Assets ----------------------------------------------------------------
router.get("/assets/:id", verifyToken, mediaController.getAsset);
router.get("/assets/:id/file", verifyToken, mediaController.getAssetFile);
router.patch("/assets/:id", verifyToken, mediaController.assignAsset);
router.delete("/assets/:id", verifyToken, verifyAdmin, mediaController.deleteAsset);
router.get("/assets/:id/annotations", verifyToken, mediaController.listAssetAnnotations);
router.post("/assets/:id/annotations", verifyToken, mediaController.createAnnotation);

// --- Annotations -----------------------------------------------------------
router.get("/annotations/:id/history", verifyToken, mediaController.annotationHistory);
router.patch("/annotations/:id", verifyToken, mediaController.updateAnnotation);
router.delete("/annotations/:id", verifyToken, mediaController.deleteAnnotation);
router.post("/annotations/:id/restore", verifyToken, mediaController.restoreAnnotation);

module.exports = router;
