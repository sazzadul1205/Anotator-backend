const express = require("express");
const router = express.Router();
const { getDB } = require("../config/db");
const { ObjectId } = require("mongodb");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");

// Authentication middleware
const authenticate = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(" ")[1];
        if (!token) {
            return res.status(401).json({
                success: false,
                error: "No token provided"
            });
        }

        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const db = getDB();
        const user = await db.collection("Users").findOne({
            _id: new ObjectId(decoded.userId),
            isDeleted: { $ne: true }
        });

        if (!user) {
            return res.status(401).json({
                success: false,
                error: "User not found"
            });
        }

        req.user = {
            userId: user._id,
            uid: user.uid,
            username: user.username,
            email: user.email,
            role: user.role
        };
        next();
    } catch (err) {
        console.error("Auth error:", err);
        res.status(401).json({
            success: false,
            error: "Invalid token"
        });
    }
};

// Helper to check if user is owner or admin
const isOwnerOrAdmin = (userId, user) => {
    return user.userId.toString() === userId || user.role === "Admin";
};

/*  LOGIN USER */
router.post("/login", async (req, res) => {
    try {
        const db = getDB();
        const UsersCollection = db.collection("Users");

        const { username, password } = req.body;

        const user = await UsersCollection.findOne({
            $or: [
                { username: username },
                { email: username.toLowerCase() }
            ],
            isDeleted: { $ne: true }
        });

        if (!user) {
            return res.status(401).json({
                success: false,
                error: "Invalid credentials"
            });
        }

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(401).json({
                success: false,
                error: "Invalid credentials"
            });
        }

        // Update last login
        await UsersCollection.updateOne(
            { _id: user._id },
            { $set: { lastLogin: new Date(), updatedAt: new Date() } }
        );

        // Generate token
        const token = jwt.sign(
            { userId: user._id, uid: user.uid, role: user.role },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        // Remove password
        const { password: pwd, ...userWithoutPassword } = user;

        res.status(200).json({
            success: true,
            message: "Login successful",
            data: {
                user: userWithoutPassword,
                token
            }
        });
    } catch (err) {
        console.error("Login error:", err);
        res.status(500).json({
            success: false,
            error: "Failed to login"
        });
    }
});

/* CREATE ACCOUNT */
router.post("/create-account", async (req, res) => {
    try {
        const db = getDB();
        const UsersCollection = db.collection("Users");

        const { username, email, password, role } = req.body;

        // Check if user exists
        const existingUser = await UsersCollection.findOne({
            $or: [
                { username: username },
                { email: email.toLowerCase() }
            ]
        });

        if (existingUser) {
            return res.status(400).json({
                success: false,
                error: "Username or email already exists"
            });
        }

        // Hash password
        const hashedPassword = await bcrypt.hash(password, 10);

        const newUser = {
            username,
            email: email.toLowerCase(),
            password: hashedPassword,
            uid: new ObjectId().toString(),
            role: role || "Annotator",
            isDeleted: false,
            createdAt: new Date(),
            updatedAt: new Date(),
            deletedAt: null
        };

        const result = await UsersCollection.insertOne(newUser);

        // Generate token
        const token = jwt.sign(
            { userId: result.insertedId, uid: newUser.uid, role: newUser.role },
            process.env.JWT_SECRET,
            { expiresIn: "7d" }
        );

        // Remove password
        const { password: pwd, ...userWithoutPassword } = newUser;

        res.status(201).json({
            success: true,
            message: "Account created successfully",
            data: {
                user: { ...userWithoutPassword, _id: result.insertedId },
                token
            }
        });
    } catch (err) {
        console.error("Create account error:", err);
        res.status(500).json({
            success: false,
            error: "Failed to create account"
        });
    }
});

/*  CHANGE PASSWORD */
router.put("/change-password/:userId", authenticate, async (req, res) => {
    try {
        const db = getDB();
        const UsersCollection = db.collection("Users");

        const { userId } = req.params;
        const { currentPassword, newPassword } = req.body;

        if (!isOwnerOrAdmin(userId, req.user)) {
            return res.status(403).json({
                success: false,
                error: "Access denied. You can only change your own password"
            });
        }

        if (!ObjectId.isValid(userId)) {
            return res.status(400).json({
                success: false,
                error: "Invalid user ID format"
            });
        }

        const user = await UsersCollection.findOne({
            _id: new ObjectId(userId),
            isDeleted: { $ne: true }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                error: "User not found"
            });
        }

        const isMatch = await bcrypt.compare(currentPassword, user.password);
        if (!isMatch) {
            return res.status(401).json({
                success: false,
                error: "Current password is incorrect"
            });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);

        await UsersCollection.updateOne(
            { _id: new ObjectId(userId) },
            {
                $set: {
                    password: hashedPassword,
                    updatedAt: new Date()
                }
            }
        );

        res.status(200).json({
            success: true,
            message: "Password changed successfully"
        });
    } catch (err) {
        console.error("Change password error:", err);
        res.status(500).json({
            success: false,
            error: "Failed to change password"
        });
    }
});

/* UPDATE ACCOUNT (Username, Email, Role */
router.put("/update-account/:userId", authenticate, async (req, res) => {
    try {
        const db = getDB();
        const UsersCollection = db.collection("Users");

        const { userId } = req.params;
        const { username, email, role } = req.body;

        if (!isOwnerOrAdmin(userId, req.user)) {
            return res.status(403).json({
                success: false,
                error: "Access denied. You can only update your own account"
            });
        }

        if (!ObjectId.isValid(userId)) {
            return res.status(400).json({
                success: false,
                error: "Invalid user ID format"
            });
        }

        const user = await UsersCollection.findOne({
            _id: new ObjectId(userId),
            isDeleted: { $ne: true }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                error: "User not found"
            });
        }

        const updateFields = {};

        if (username && username !== user.username) {
            const existing = await UsersCollection.findOne({
                username: username,
                _id: { $ne: new ObjectId(userId) }
            });
            if (existing) {
                return res.status(400).json({
                    success: false,
                    error: "Username already taken"
                });
            }
            updateFields.username = username;
        }

        if (email && email.toLowerCase() !== user.email) {
            const existing = await UsersCollection.findOne({
                email: email.toLowerCase(),
                _id: { $ne: new ObjectId(userId) }
            });
            if (existing) {
                return res.status(400).json({
                    success: false,
                    error: "Email already taken"
                });
            }
            updateFields.email = email.toLowerCase();
        }

        if (role && req.user.role === "Admin") {
            updateFields.role = role;
        }

        updateFields.updatedAt = new Date();

        await UsersCollection.updateOne(
            { _id: new ObjectId(userId) },
            { $set: updateFields }
        );

        const updatedUser = await UsersCollection.findOne({
            _id: new ObjectId(userId)
        });

        const { password, ...userWithoutPassword } = updatedUser;

        res.status(200).json({
            success: true,
            message: "Account updated successfully",
            data: userWithoutPassword
        });
    } catch (err) {
        console.error("Update account error:", err);
        res.status(500).json({
            success: false,
            error: "Failed to update account"
        });
    }
});

/* GET USER BY ID */
router.get("/user/:userId", authenticate, async (req, res) => {
    try {
        const db = getDB();
        const UsersCollection = db.collection("Users");

        const { userId } = req.params;

        if (!isOwnerOrAdmin(userId, req.user)) {
            return res.status(403).json({
                success: false,
                error: "Access denied. You can only view your own profile"
            });
        }

        if (!ObjectId.isValid(userId)) {
            return res.status(400).json({
                success: false,
                error: "Invalid user ID format"
            });
        }

        const user = await UsersCollection.findOne({
            _id: new ObjectId(userId),
            isDeleted: { $ne: true }
        });

        if (!user) {
            return res.status(404).json({
                success: false,
                error: "User not found"
            });
        }

        const { password, ...userWithoutPassword } = user;

        res.status(200).json({
            success: true,
            data: userWithoutPassword
        });
    } catch (err) {
        console.error("Get user error:", err);
        res.status(500).json({
            success: false,
            error: "Failed to get user"
        });
    }
});

/* GET ALL USERS (ADMIN ONLY) */
router.get("/users", authenticate, async (req, res) => {
    try {
        if (req.user.role !== "Admin") {
            return res.status(403).json({
                success: false,
                error: "Access denied. Admin only"
            });
        }

        const db = getDB();
        const UsersCollection = db.collection("Users");

        const users = await UsersCollection.find({
            isDeleted: { $ne: true }
        }).toArray();

        const usersWithoutPassword = users.map(user => {
            const { password, ...rest } = user;
            return rest;
        });

        res.status(200).json({
            success: true,
            count: usersWithoutPassword.length,
            data: usersWithoutPassword
        });
    } catch (err) {
        console.error("Get all users error:", err);
        res.status(500).json({
            success: false,
            error: "Failed to fetch users"
        });
    }
});

/*  SOFT DELETE ACCOUNT */
router.delete("/delete-account/:userId", authenticate, async (req, res) => {
    try {
        const db = getDB();
        const UsersCollection = db.collection("Users");

        const { userId } = req.params;

        if (!isOwnerOrAdmin(userId, req.user)) {
            return res.status(403).json({
                success: false,
                error: "Access denied. You can only delete your own account"
            });
        }

        if (!ObjectId.isValid(userId)) {
            return res.status(400).json({
                success: false,
                error: "Invalid user ID format"
            });
        }

        const result = await UsersCollection.updateOne(
            { _id: new ObjectId(userId), isDeleted: { $ne: true } },
            {
                $set: {
                    isDeleted: true,
                    deletedAt: new Date(),
                    updatedAt: new Date()
                }
            }
        );

        if (result.matchedCount === 0) {
            return res.status(404).json({
                success: false,
                error: "User not found or already deleted"
            });
        }

        res.status(200).json({
            success: true,
            message: "Account deleted successfully"
        });
    } catch (err) {
        console.error("Delete account error:", err);
        res.status(500).json({
            success: false,
            error: "Failed to delete account"
        });
    }
});

/* HARD DELETE ACCOUNT (PERMANENT) */
router.delete("/hard-delete/:userId", authenticate, async (req, res) => {
    try {
        if (req.user.role !== "Admin") {
            return res.status(403).json({
                success: false,
                error: "Access denied. Admin only"
            });
        }

        const db = getDB();
        const UsersCollection = db.collection("Users");

        const { userId } = req.params;

        if (!ObjectId.isValid(userId)) {
            return res.status(400).json({
                success: false,
                error: "Invalid user ID format"
            });
        }

        const result = await UsersCollection.deleteOne({
            _id: new ObjectId(userId)
        });

        if (result.deletedCount === 0) {
            return res.status(404).json({
                success: false,
                error: "User not found"
            });
        }

        res.status(200).json({
            success: true,
            message: "Account permanently deleted"
        });
    } catch (err) {
        console.error("Hard delete error:", err);
        res.status(500).json({
            success: false,
            error: "Failed to permanently delete account"
        });
    }
});

module.exports = router;