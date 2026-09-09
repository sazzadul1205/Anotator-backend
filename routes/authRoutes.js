const express = require("express");
const router = express.Router();
const { getDB } = require("../config/db");
const { ObjectId } = require("mongodb");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { authenticate } = require("../middleware");

// Helper to check owner or admin
const isOwnerOrAdmin = (userId, user) => {
  return user.userId.toString() === userId || user.role === "Admin";
};

/* LOGIN */
router.post("/login", async (req, res) => {
  try {
    const db = getDB();
    const UsersCollection = db.collection("Users");
    const { username, password } = req.body;

    const user = await UsersCollection.findOne({
      $or: [{ username }, { email: username.toLowerCase() }],
    });

    if (!user) {
      return res.status(401).json({ success: false, error: "Invalid credentials" });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: "Invalid credentials" });
    }

    await UsersCollection.updateOne(
      { _id: user._id },
      { $set: { lastLogin: new Date(), updatedAt: new Date() } }
    );

    const token = jwt.sign(
      { userId: user._id, uid: user.uid, role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    const { password: pwd, ...userWithoutPassword } = user;
    res.status(200).json({
      success: true,
      message: "Login successful",
      data: { user: userWithoutPassword, token },
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ success: false, error: "Failed to login" });
  }
});

/* CREATE ACCOUNT */
router.post("/create-account", async (req, res) => {
  try {
    const db = getDB();
    const UsersCollection = db.collection("Users");
    const { username, email, password, role } = req.body;

    const existing = await UsersCollection.findOne({
      $or: [{ username }, { email: email.toLowerCase() }],
    });
    if (existing) {
      return res.status(400).json({ success: false, error: "Username or email already exists" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = {
      username,
      email: email.toLowerCase(),
      password: hashedPassword,
      uid: new ObjectId().toString(),
      role: role || "Annotator",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await UsersCollection.insertOne(newUser);

    const token = jwt.sign(
      { userId: result.insertedId, uid: newUser.uid, role: newUser.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" }
    );

    const { password: pwd, ...userWithoutPassword } = newUser;
    res.status(201).json({
      success: true,
      message: "Account created",
      data: { user: { ...userWithoutPassword, _id: result.insertedId }, token },
    });
  } catch (err) {
    console.error("Create account error:", err);
    res.status(500).json({ success: false, error: "Failed to create account" });
  }
});

/* CHANGE PASSWORD */
router.put("/change-password/:userId", authenticate, async (req, res) => {
  try {
    const db = getDB();
    const UsersCollection = db.collection("Users");
    const { userId } = req.params;
    const { currentPassword, newPassword } = req.body;

    if (!isOwnerOrAdmin(userId, req.user)) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }
    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, error: "Invalid user ID" });
    }

    const user = await UsersCollection.findOne({ _id: new ObjectId(userId) });
    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    const isMatch = await bcrypt.compare(currentPassword, user.password);
    if (!isMatch) {
      return res.status(401).json({ success: false, error: "Current password is incorrect" });
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await UsersCollection.updateOne(
      { _id: new ObjectId(userId) },
      { $set: { password: hashed, updatedAt: new Date() } }
    );

    res.status(200).json({ success: true, message: "Password changed" });
  } catch (err) {
    console.error("Change password error:", err);
    res.status(500).json({ success: false, error: "Failed to change password" });
  }
});

/* UPDATE ACCOUNT (username, email, role) */
router.put("/update-account/:userId", authenticate, async (req, res) => {
  try {
    const db = getDB();
    const UsersCollection = db.collection("Users");
    const { userId } = req.params;
    const { username, email, role } = req.body;

    if (!isOwnerOrAdmin(userId, req.user)) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }
    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, error: "Invalid user ID" });
    }

    const user = await UsersCollection.findOne({ _id: new ObjectId(userId) });
    if (!user) return res.status(404).json({ success: false, error: "User not found" });

    const updateFields = { updatedAt: new Date() };

    if (username && username !== user.username) {
      const existing = await UsersCollection.findOne({
        username,
        _id: { $ne: new ObjectId(userId) },
      });
      if (existing) {
        return res.status(400).json({ success: false, error: "Username already taken" });
      }
      updateFields.username = username;
    }

    if (email && email.toLowerCase() !== user.email) {
      const existing = await UsersCollection.findOne({
        email: email.toLowerCase(),
        _id: { $ne: new ObjectId(userId) },
      });
      if (existing) {
        return res.status(400).json({ success: false, error: "Email already taken" });
      }
      updateFields.email = email.toLowerCase();
    }

    if (role && req.user.role === "Admin") {
      updateFields.role = role;
    }

    await UsersCollection.updateOne({ _id: new ObjectId(userId) }, { $set: updateFields });

    const updated = await UsersCollection.findOne({ _id: new ObjectId(userId) });
    const { password, ...rest } = updated;
    res.status(200).json({ success: true, message: "Account updated", data: rest });
  } catch (err) {
    console.error("Update account error:", err);
    res.status(500).json({ success: false, error: "Failed to update account" });
  }
});

/* GET ALL USERS (Admin only) */
router.get("/users", authenticate, async (req, res) => {
  try {
    if (req.user.role !== "Admin") {
      return res.status(403).json({ success: false, error: "Admin only" });
    }
    const db = getDB();
    const UsersCollection = db.collection("Users");
    const users = await UsersCollection.find({}).toArray();
    const cleaned = users.map(({ password, ...rest }) => rest);
    res.status(200).json({ success: true, count: cleaned.length, data: cleaned });
  } catch (err) {
    console.error("Get users error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch users" });
  }
});

/* HARD DELETE ACCOUNT */
router.delete("/delete-account/:userId", authenticate, async (req, res) => {
  try {
    const db = getDB();
    const UsersCollection = db.collection("Users");
    const { userId } = req.params;

    if (!isOwnerOrAdmin(userId, req.user)) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }
    if (!ObjectId.isValid(userId)) {
      return res.status(400).json({ success: false, error: "Invalid user ID" });
    }

    const result = await UsersCollection.deleteOne({ _id: new ObjectId(userId) });
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, error: "User not found" });
    }

    res.status(200).json({ success: true, message: "Account permanently deleted" });
  } catch (err) {
    console.error("Delete account error:", err);
    res.status(500).json({ success: false, error: "Failed to delete account" });
  }
});

module.exports = router;