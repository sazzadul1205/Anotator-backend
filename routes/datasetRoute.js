const express = require("express");
const multer = require("multer");
const datasetController = require("../controllers/datasetController");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok =
      file.mimetype === "text/csv" ||
      file.mimetype ===
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
      file.originalname.match(/\.(csv|xlsx)$/i);
    if (!ok) return cb(new Error("Only .csv and .xlsx files allowed"));
    cb(null, true);
  },
});

// Literal paths first
router.post(
  "/import",
  verifyToken,
  verifyAdmin,
  upload.single("file"),
  datasetController.importDataset,
);
router.post(
  "/preview",
  verifyToken,
  verifyAdmin,
  upload.single("file"),
  datasetController.previewDataset,
);
router.get("/stats", verifyToken, verifyAdmin, datasetController.getStats);
router.get("/", verifyToken, datasetController.list);

// Parameterized
router.get("/:id", verifyToken, datasetController.getOne);
router.patch("/:id/assign", verifyToken, verifyAdmin, datasetController.assign);
router.post(
  "/:id/duplicate",
  verifyToken,
  verifyAdmin,
  datasetController.duplicate,
);
router.patch("/:id", verifyToken, verifyAdmin, datasetController.rename);
router.delete("/:id", verifyToken, verifyAdmin, datasetController.remove);

module.exports = router;
