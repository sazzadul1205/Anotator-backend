const express = require("express");
const taxonomyController = require("../controllers/taxonomyController");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

const router = express.Router();

// Literal paths first
router.get("/", verifyToken, taxonomyController.list);
router.get("/defaults", verifyToken, taxonomyController.getDefaults);
router.get(
  "/for-dataset/:datasetId",
  verifyToken,
  taxonomyController.getForDataset,
);

// Create
router.post("/", verifyToken, verifyAdmin, taxonomyController.create);

// Parameterized
router.get("/:id", verifyToken, taxonomyController.getOne);
router.patch("/:id", verifyToken, verifyAdmin, taxonomyController.update);
router.delete("/:id", verifyToken, verifyAdmin, taxonomyController.remove);
router.patch(
  "/:id/assign/:datasetId",
  verifyToken,
  verifyAdmin,
  taxonomyController.assignToDataset,
);
router.delete(
  "/:id/assign/:datasetId",
  verifyToken,
  verifyAdmin,
  taxonomyController.unassignFromDataset,
);

module.exports = router;
