const express = require("express");
const rateLimit = require("express-rate-limit");
const authController = require("../controllers/authController");
const { verifyToken } = require("../middleware/auth");

const router = express.Router();

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    error: "Too many login attempts. Please try again after 15 minutes.",
  },
});

const bootstrapLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 10,
  message: {
    success: false,
    error: "Too many bootstrap attempts. Try again later.",
  },
});

router.get(
  "/bootstrap-status",
  bootstrapLimiter,
  authController.bootstrapStatus,
);
router.post("/bootstrap", bootstrapLimiter, authController.bootstrap);
router.post("/login", loginLimiter, authController.login);
router.post("/logout", verifyToken, authController.logout);
router.get("/me", verifyToken, authController.me);

module.exports = router;
