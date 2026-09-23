const express = require("express");
const commentController = require("../controllers/commentController");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

const router = express.Router();

router.use(verifyToken);

// Literal paths first
router.get("/", commentController.list);
router.post("/", commentController.create);
router.post("/bulk-annotate", commentController.bulkAnnotate);
router.post("/bulk-assign", verifyAdmin, commentController.bulkAssign);
router.get("/export", commentController.exportComments);

// Parameterized
router.get("/:id", commentController.getOne);
router.patch("/:id", commentController.updateText);
router.patch("/:id/annotation", commentController.annotate);
router.get("/:id/versions", commentController.getVersions);
router.post("/:id/restore/:version", commentController.restoreVersion);
router.delete("/:id", verifyAdmin, commentController.remove);

module.exports = router;
