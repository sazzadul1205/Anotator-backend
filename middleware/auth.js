const jwt = require("jsonwebtoken");
const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");

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

    const db = getDB();
    if (!db) {
      return res
        .status(503)
        .json({ success: false, error: "Database not ready" });
    }

    const user = await db
      .collection("users")
      .findOne(
        { _id: new ObjectId(payload.userId) },
        { projection: { password: 0, passwordHash: 0 } },
      );

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
      userId: user._id.toString(),
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
