const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const { ObjectId } = require("mongodb");

const { getDB } = require("../config/db");
const { verifyToken } = require("../middleware/auth");
const { audit } = require("../utils/audit");

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

// --- Bootstrap ---

router.get("/bootstrap-status", bootstrapLimiter, async (req, res) => {
  try {
    const db = getDB();
    const adminCount = await db
      .collection("users")
      .countDocuments({ role: "admin" });
    res.json({ success: true, adminCount });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

router.post("/bootstrap", bootstrapLimiter, async (req, res) => {
  const db = getDB();
  let lockClaimed = false;

  try {
    const { name, email, password, confirmPassword } = req.body;

    if (!name || !email || !password || !confirmPassword) {
      return res
        .status(400)
        .json({ success: false, error: "Missing fields" });
    }
    if (password !== confirmPassword) {
      return res
        .status(400)
        .json({ success: false, error: "Passwords do not match" });
    }
    if (password.length < 6) {
      return res
        .status(400)
        .json({ success: false, error: "Password too short (min 6)" });
    }

    try {
      await db
        .collection("system_locks")
        .insertOne({ _id: "admin_bootstrap", claimedAt: new Date() });
      lockClaimed = true;
    } catch (err) {
      if (err.code === 11000) {
        return res
          .status(400)
          .json({ success: false, error: "Admin account already exists" });
      }
      throw err;
    }

    const adminCount = await db
      .collection("users")
      .countDocuments({ role: "admin" });
    if (adminCount > 0) {
      await db
        .collection("system_locks")
        .deleteOne({ _id: "admin_bootstrap" });
      return res
        .status(400)
        .json({ success: false, error: "Admin account already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const normalizedEmail = email.toLowerCase().trim();

    const result = await db.collection("users").insertOne({
      email: normalizedEmail,
      name: name.trim(),
      password: hashedPassword,
      role: "admin",
      isActive: true,
      tokenVersion: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    await audit({
      action: "auth.bootstrap",
      actor: null,
      targetType: "user",
      targetId: result.insertedId.toString(),
      metadata: { email: normalizedEmail },
    });

    res.json({
      success: true,
      message: "Admin account created successfully",
      userId: result.insertedId,
    });
  } catch (err) {
    if (lockClaimed) {
      try {
        await db
          .collection("system_locks")
          .deleteOne({ _id: "admin_bootstrap" });
      } catch {}
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Login ---

router.post("/login", loginLimiter, async (req, res) => {
  try {
    const db = getDB();
    const { email, password } = req.body;

    if (!email || !password) {
      return res
        .status(400)
        .json({ success: false, error: "Missing fields" });
    }

    const user = await db
      .collection("users")
      .findOne({ email: email.toLowerCase().trim() });

    if (!user || !user.isActive) {
      return res
        .status(401)
        .json({ success: false, error: "Invalid credentials" });
    }

    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res
        .status(401)
        .json({ success: false, error: "Invalid credentials" });
    }

    const token = jwt.sign(
      {
        userId: user._id.toString(),
        role: user.role,
        tokenVersion: user.tokenVersion || 0,
      },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    await audit({
      action: "auth.login",
      actor: {
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
      },
      metadata: { ip: req.ip },
    });

    res.json({
      success: true,
      user: {
        _id: user._id.toString(),
        email: user.email,
        name: user.name,
        role: user.role,
        isActive: user.isActive,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
      },
      token,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Logout ---

router.post("/logout", verifyToken, async (req, res) => {
  try {
    const db = getDB();
    await db
      .collection("users")
      .updateOne(
        { _id: new ObjectId(req.user.userId) },
        { $inc: { tokenVersion: 1 }, $set: { updatedAt: new Date() } },
      );

    await audit({
      action: "auth.logout",
      actor: req.user,
      metadata: { ip: req.ip },
    });

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// --- Me ---

router.get("/me", verifyToken, async (req, res) => {
  res.json({ success: true, user: req.user });
});

module.exports = router;