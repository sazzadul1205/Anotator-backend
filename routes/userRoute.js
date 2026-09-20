const express = require("express");
const bcrypt = require("bcryptjs");
const { ObjectId } = require("mongodb");

const { getDB } = require("../config/db");
const { verifyToken, verifyAdmin } = require("../middleware/auth");

const router = express.Router();

// GET /users
router.get("/", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    const users = await db
      .collection("users")
      .find({}, { projection: { password: 0, passwordHash: 0 } })
      .toArray();
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /users
router.post("/", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    const { name, email, password, role } = req.body;

    if (!name || !email || !password || !role) {
      return res.status(400).json({ success: false, error: "Missing fields" });
    }
    if (!["admin", "annotator"].includes(role)) {
      return res.status(400).json({ success: false, error: "Invalid role" });
    }
    if (password.length < 6) {
      return res
        .status(400)
        .json({ success: false, error: "Password too short (min 6)" });
    }

    const normalizedEmail = email.toLowerCase().trim();

    const existingUser = await db
      .collection("users")
      .findOne({ email: normalizedEmail });
    if (existingUser) {
      return res
        .status(400)
        .json({ success: false, error: "User already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    let result;
    try {
      result = await db.collection("users").insertOne({
        name: name.trim(),
        email: normalizedEmail,
        password: hashedPassword,
        role,
        isActive: true,
        tokenVersion: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    } catch (err) {
      if (err.code === 11000) {
        return res
          .status(400)
          .json({ success: false, error: "User already exists" });
      }
      throw err;
    }

    res.status(201).json({
      success: true,
      message: "User created successfully",
      userId: result.insertedId,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /users/:id
router.get("/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: "Invalid user ID" });
    }

    const user = await db
      .collection("users")
      .findOne(
        { _id: new ObjectId(req.params.id) },
        { projection: { password: 0, passwordHash: 0 } },
      );

    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /users/:id
router.patch("/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    const { name, email } = req.body;

    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: "Invalid user ID" });
    }
    if (!name && !email) {
      return res.status(400).json({ success: false, error: "Missing fields" });
    }

    const userId = new ObjectId(req.params.id);

    const user = await db.collection("users").findOne({ _id: userId });
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const updates = { updatedAt: new Date() };

    if (name) updates.name = name.trim();

    if (email) {
      const normalizedEmail = email.toLowerCase().trim();
      const existingEmail = await db.collection("users").findOne({
        email: normalizedEmail,
        _id: { $ne: userId },
      });
      if (existingEmail) {
        return res
          .status(400)
          .json({ success: false, error: "Email already exists" });
      }
      updates.email = normalizedEmail;
    }

    await db.collection("users").updateOne({ _id: userId }, { $set: updates });

    const updatedUser = await db
      .collection("users")
      .findOne(
        { _id: userId },
        { projection: { password: 0, passwordHash: 0 } },
      );

    res.json({
      success: true,
      message: "User updated successfully",
      user: updatedUser,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PATCH /users/:id/status
router.patch("/:id/status", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: "Invalid user ID" });
    }

    const userId = new ObjectId(req.params.id);

    if (req.user.userId === userId.toString()) {
      return res
        .status(400)
        .json({ success: false, error: "You cannot change your own status" });
    }

    const user = await db.collection("users").findOne({ _id: userId });
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    const newStatus = !user.isActive;

    await db.collection("users").updateOne(
      { _id: userId },
      {
        $set: {
          isActive: newStatus,
          updatedAt: new Date(),
          // Force re-login when re-activated/deactivated
          ...(newStatus === false && { $inc: { tokenVersion: 1 } }),
        },
      },
    );

    res.json({
      success: true,
      message: newStatus
        ? "User activated successfully"
        : "User deactivated successfully",
      isActive: newStatus,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /users/:id/reset-password
router.post(
  "/:id/reset-password",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const db = getDB();
      const { newPassword, confirmPassword } = req.body;

      if (!ObjectId.isValid(req.params.id)) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid user ID" });
      }
      if (!newPassword || !confirmPassword) {
        return res
          .status(400)
          .json({ success: false, error: "Missing fields" });
      }
      if (newPassword !== confirmPassword) {
        return res.status(400).json({
          success: false,
          error: "Password and Confirm Password do not match",
        });
      }
      if (newPassword.length < 6) {
        return res
          .status(400)
          .json({ success: false, error: "Password too short (min 6)" });
      }

      const userId = new ObjectId(req.params.id);

      const user = await db.collection("users").findOne({ _id: userId });
      if (!user) {
        return res
          .status(404)
          .json({ success: false, error: "User not found" });
      }

      const hashedPassword = await bcrypt.hash(newPassword, 10);

      await db.collection("users").updateOne(
        { _id: userId },
        {
          $set: { password: hashedPassword, updatedAt: new Date() },
          // Force re-login on all devices
          $inc: { tokenVersion: 1 },
        },
      );

      res.json({ success: true, message: "Password reset successfully" });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

// DELETE /users/:id
router.delete("/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ success: false, error: "Invalid user ID" });
    }

    const userId = new ObjectId(req.params.id);

    if (req.user.userId === userId.toString()) {
      return res
        .status(400)
        .json({ success: false, error: "You cannot delete yourself" });
    }

    const user = await db.collection("users").findOne({ _id: userId });
    if (!user) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    // Refuse to delete a user still assigned to datasets
    const assignedDatasets = await db
      .collection("datasets")
      .countDocuments({ assignedTo: userId });
    if (assignedDatasets > 0) {
      return res.status(400).json({
        success: false,
        error: `User has ${assignedDatasets} dataset(s) assigned. Unassign first.`,
      });
    }

    await db.collection("users").deleteOne({ _id: userId });

    res.json({ success: true, message: "User deleted successfully" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
