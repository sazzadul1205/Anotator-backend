// routes/presenceRoute.js
const express = require("express");
const presenceController = require("../controllers/presenceController");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

const router = express.Router();

/**
 * The heartbeat is the only endpoint any authenticated user may call.
 * It carries no role check because presence is about liveness, not permission.
 */
router.post("/heartbeat", verifyToken, presenceController.heartbeat);

/**
 * The rest are admin-only. Mounting the guard at the router level is
 * intentional: it is the same pattern the users and audit routers use, and it
 * means a handler can never forget the check.
 */
router.use(verifyToken, verifyAdmin);

router.get("/me", presenceController.me);
router.get("/board", presenceController.board);
router.get("/users/:userId", presenceController.userDetail);
router.post("/sweep", presenceController.sweep);

module.exports = router;