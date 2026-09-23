const express = require("express");
const userController = require("../controllers/userController");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

const router = express.Router();

router.use(verifyToken, verifyAdmin);

router.get("/", userController.list);
router.post("/", userController.create);
router.get("/:id", userController.getOne);
router.patch("/:id", userController.update);
router.patch("/:id/status", userController.toggleStatus);
router.post("/:id/reset-password", userController.resetPassword);
router.delete("/:id", userController.remove);

module.exports = router;
