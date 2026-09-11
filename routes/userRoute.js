const express = require("express");
const bcrypt = require("bcryptjs");
const { ObjectId } = require("mongodb");

// Config
const { getDB } = require("../config/db");

// Middleware
const { verifyToken, verifyAdmin } = require("../middleware/auth");

// Create Router
const router = express.Router();

// GET /users Get all users
router.get("/", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = await getDB();

    const users = await db
      .collection("users")
      .find(
        {},
        {
          projection: {
            password: 0,
            passwordHash: 0,
          },
        },
      )
      .toArray();

    return res.status(200).json({
      success: true,
      users,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// POST /users Create a new user
router.post("/", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = await getDB();

    const { name, email, password, role } = req.body;

    // Check required fields
    if (!name || !email || !password || !role) {
      return res.status(400).json({
        success: false,
        error: "Missing fields",
      });
    }

    // Validate role
    if (!["admin", "annotator"].includes(role)) {
      return res.status(400).json({
        success: false,
        error: "Invalid role",
      });
    }

    const normalizedEmail = email.toLowerCase();

    // Check if email already exists
    const existingUser = await db.collection("users").findOne({
      email: normalizedEmail,
    });
    if (existingUser) {
      return res.status(400).json({
        success: false,
        error: "User already exists",
      });
    }

    // Hash password
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user
    const userPayload = {
      name,
      email: normalizedEmail,
      password: hashedPassword,
      role,
      isActive: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await db.collection("users").insertOne(userPayload);

    return res.status(201).json({
      success: true,
      message: "User created successfully",
      userId: result.insertedId,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});


// GET /users/:id Get a user by ID
router.get("/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = await getDB();

    // Validate ObjectId
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        error: "Invalid user ID",
      });
    }

    const userId = new ObjectId(req.params.id);

    const user = await db.collection("users").findOne(
      { _id: userId },
      {
        projection: {
          password: 0,
          passwordHash: 0,
        },
      },
    );

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    return res.status(200).json({
      success: true,
      user,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});


// PATCH /users/:id ~ Update user's details
router.patch("/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = await getDB();

    const { name, email } = req.body;

    // Validate ObjectId
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        error: "Invalid user ID",
      });
    }

    // At least one field must be provided
    if (!name && !email) {
      return res.status(400).json({
        success: false,
        error: "Missing fields",
      });
    }

    const userId = new ObjectId(req.params.id);

    // Check if user exists
    const user = await db.collection("users").findOne({
      _id: userId,
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    const updates = {
      updatedAt: new Date(),
    };

    // Update name if provided
    if (name) {
      updates.name = name;
    }

    // Update email if provided
    if (email) {
      const normalizedEmail = email.toLowerCase();

      // Check if another user already has this email
      const existingEmail = await db.collection("users").findOne({
        email: normalizedEmail,
        _id: { $ne: userId },
      });

      if (existingEmail) {
        return res.status(400).json({
          success: false,
          error: "Email already exists",
        });
      }

      updates.email = normalizedEmail;
    }

    // Update user
    await db.collection("users").updateOne(
      { _id: userId },
      {
        $set: updates,
      },
    );

    // Get updated user without password
    const updatedUser = await db.collection("users").findOne(
      { _id: userId },
      {
        projection: {
          password: 0,
          passwordHash: 0,
        },
      },
    );

    return res.status(200).json({
      success: true,
      message: "User updated successfully",
      user: updatedUser,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});


// PATCH /users/:id/status ~ Toggle user's status
router.patch("/:id/status", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = await getDB();

    // Validate ObjectId
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        error: "Invalid user ID",
      });
    }

    const userId = new ObjectId(req.params.id);

    // Prevent admin from changing their own status
    if (req.user.userId === userId.toString()) {
      return res.status(400).json({
        success: false,
        error: "You cannot change your own status",
      });
    }

    // Find user
    const user = await db.collection("users").findOne({
      _id: userId,
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    // Flip current status
    const newStatus = !user.isActive;

    await db.collection("users").updateOne(
      { _id: userId },
      {
        $set: {
          isActive: newStatus,
          updatedAt: new Date(),
        },
      },
    );

    return res.status(200).json({
      success: true,
      message: newStatus
        ? "User activated successfully"
        : "User deactivated successfully",
      isActive: newStatus,
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

// POST /users/:id/reset-password ~ Reset User Password
router.post(
  "/:id/reset-password",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const db = await getDB();

      const { newPassword, confirmPassword } = req.body;

      // Validate ObjectId
      if (!ObjectId.isValid(req.params.id)) {
        return res.status(400).json({
          success: false,
          error: "Invalid user ID",
        });
      }

      // Check required fields
      if (!newPassword || !confirmPassword) {
        return res.status(400).json({
          success: false,
          error: "Missing fields",
        });
      }

      // Check password confirmation
      if (newPassword !== confirmPassword) {
        return res.status(400).json({
          success: false,
          error: "Password and Confirm Password do not match",
        });
      }

      const userId = new ObjectId(req.params.id);

      // Find user
      const user = await db.collection("users").findOne({
        _id: userId,
      });

      if (!user) {
        return res.status(404).json({
          success: false,
          error: "User not found",
        });
      }

      // Hash new password
      const hashedPassword = await bcrypt.hash(newPassword, 10);

      // Update password
      await db.collection("users").updateOne(
        { _id: userId },
        {
          $set: {
            password: hashedPassword,
            updatedAt: new Date(),
          },
        },
      );

      return res.status(200).json({
        success: true,
        message: "Password reset successfully",
      });
    } catch (err) {
      return res.status(500).json({
        success: false,
        error: err.message,
      });
    }
  },
);

// DELETE /users/:id Delete a user
router.delete("/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = await getDB();

    // Validate ObjectId
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({
        success: false,
        error: "Invalid user ID",
      });
    }

    const userId = new ObjectId(req.params.id);

    // Prevent admin from deleting themselves
    if (req.user.userId === userId.toString()) {
      return res.status(400).json({
        success: false,
        error: "You cannot delete yourself",
      });
    }

    // Check if user exists
    const user = await db.collection("users").findOne({
      _id: userId,
    });

    if (!user) {
      return res.status(404).json({
        success: false,
        error: "User not found",
      });
    }

    // Delete user
    await db.collection("users").deleteOne({
      _id: userId,
    });

    return res.status(200).json({
      success: true,
      message: "User deleted successfully",
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
    });
  }
});

module.exports = router;
