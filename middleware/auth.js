// middleware/auth.js
// JWT verification + admin gate.
// Uses the User model so this stays storage-agnostic.

const jwt = require("jsonwebtoken");
const { User } = require("../models");

async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res
        .status(401)
        .json({ success: false, error: "No token provided" });
    }
    if (!authHeader.startsWith("Bearer ")) {
      return res
        .status(401)
        .json({ success: false, error: "Invalid authorization format" });
    }

    const token = authHeader.slice(7);

    let payload;
    try {
      payload = jwt.verify(token, process.env.JWT_SECRET);
    } catch {
      return res
        .status(401)
        .json({ success: false, error: "Invalid or expired token" });
    }

    const user = await User.findById(payload.userId);
    if (!user) {
      return res.status(401).json({ success: false, error: "User not found" });
    }
    if (!user.isActive) {
      return res
        .status(401)
        .json({ success: false, error: "User is inactive" });
    }

    const tokenVersion = payload.tokenVersion || 0;
    if ((user.tokenVersion || 0) !== tokenVersion) {
      return res.status(401).json({ success: false, error: "Token revoked" });
    }

    req.user = {
      userId: user.id,
      role: user.role,
      email: user.email,
      name: user.name,
    };

    next();
  } catch (err) {
    console.error("[verifyToken]", err);
    return res.status(500).json({ success: false, error: "Auth check failed" });
  }
}

function verifyAdmin(req, res, next) {
  if (req.user?.role === "admin") return next();
  return res.status(403).json({ success: false, error: "Unauthorized" });
}

module.exports = { verifyToken, verifyAdmin };
