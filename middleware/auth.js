const jwt = require("jsonwebtoken");
const { getDB } = require("../config/db");
const { ObjectId } = require("mongodb");

const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(401).json({ success: false, error: "No token provided" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDB();
    const user = await db.collection("Users").findOne({
      _id: new ObjectId(decoded.userId),
    });

    if (!user) {
      return res.status(401).json({ success: false, error: "User not found" });
    }

    req.user = {
      userId: user._id,
      uid: user.uid,
      username: user.username,
      email: user.email,
      role: user.role,
    };
    next();
  } catch (err) {
    console.error("Auth error:", err);
    res.status(401).json({ success: false, error: "Invalid token" });
  }
};

module.exports = authenticate;