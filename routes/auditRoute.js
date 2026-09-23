const express = require("express");
const auditController = require("../controllers/auditController");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

const router = express.Router();

router.use(verifyToken, verifyAdmin);

router.get("/", auditController.list);
router.get("/actions", auditController.actions);

module.exports = router;
