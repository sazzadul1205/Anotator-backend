const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");

// config
const { getDB } = require("../config/db");

// Middleware
const { verifyToken } = require("../middleware/auth");

// Create Router
const router = express.Router();

// Rate limiter ONLY for login endpoint
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, 
  message: {
    success: false,
    error: "Too many login attempts. Please try again after 15 minutes.",
  },
});

// Bootstrap Routes

// GET /bootstrap-status ~ Check Admin Availability
router.get("/bootstrap-status", async (req, res) => {
  try {
    const db = await getDB();
    const CountAdmin = await db
      .collection("users")
      .countDocuments({ role: "admin" });
    res.status(200).json({ success: true, adminCount: CountAdmin });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// POST /bootstrap ~ Create Admin Account
router.post("/bootstrap", async (req, res) => {
  try {
    const db = await getDB();

    // Get the data from the request
    const { name, email, password, confirmPassword } = req.body;

    // Check if an admin account already exists
    const CountAdmin = await db
      .collection("users")
      .countDocuments({ role: "admin" });

    if (CountAdmin > 0) {
      return res.status(400).json({
        success: false,
        error: "Admin account already exists",
      });
    }

    // Check if the required fields are present
    if (!name || !email || !password || !confirmPassword) {
      return res.status(400).json({ success: false, error: "Missing fields" });
    }

    // Check if the Password and Confirm Password match
    if (password !== confirmPassword) {
      return res.status(400).json({
        success: false,
        error: "Password and Confirm Password do not match",
      });
    }

    // Hash the password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create the admin Payload
    const adminPayload = {
      email,
      name,
      password: hashedPassword,
      role: "admin",
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("users").insertOne(adminPayload);

    res.status(200).json({
      success: true,
      message: "Admin account created successfully",
      userId: result.insertedId,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// User Routes

// POST /login ~ Login User
router.post("/login", loginLimiter, async (req, res) => {
  try {
    const db = await getDB();

    // Get the data from the request
    const { email, password } = req.body;

    // Check if the required fields are present
    if (!email || !password) {
      return res.status(400).json({ success: false, error: "Missing fields" });
    }

    // Check if the user exists
    const user = await db
      .collection("users")
      .findOne({ email: email.toLowerCase() });
    if (!user) {
      return res.status(401).json({ success: false, error: "Invalid email" });
    }

    // Check if user is active
    if (!user.isActive) {
      return res
        .status(401)
        .json({ success: false, error: "User is inactive" });
    }

    // Check Password Match
    const passwordMatch = await bcrypt.compare(password, user.password);
    if (!passwordMatch) {
      return res
        .status(401)
        .json({ success: false, error: "Invalid password" });
    }

    // Generate JWT Token
    const token = jwt.sign(
      { userId: user._id.toString(), role: user.role },
      process.env.JWT_SECRET,
      { expiresIn: "7d" },
    );

    // Send the response
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

// POST /logout ~ Logout User
router.post("/logout", async (req, res) => {
  try {
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// GET /me ~ Get User Details
router.get("/me", verifyToken, async (req, res) => {
  try {
    res.json({ success: true, user: req.user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

module.exports = router;
