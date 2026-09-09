const express = require("express");
const router = express.Router();
const { getDB } = require("../config/db");
const { ObjectId } = require("mongodb");

// Simple logging middleware
const logRequest = (req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - User: ${req.user?.username || 'unauthenticated'}`);
    next();
};

// Authentication middleware (reuse from authRoutes)
const authenticate = async (req, res, next) => {
    try {
        const token = req.headers.authorization?.split(" ")[1];
        if (!token) {
            console.log(`[${new Date().toISOString()}] Auth failed: No token provided for ${req.method} ${req.originalUrl}`);
            return res.status(401).json({
                success: false,
                error: "No token provided"
            });
        }

        const jwt = require("jsonwebtoken");
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        const db = getDB();
        const user = await db.collection("Users").findOne({
            _id: new ObjectId(decoded.userId),
            isDeleted: { $ne: true }
        });

        if (!user) {
            console.log(`[${new Date().toISOString()}] Auth failed: User not found for ${req.method} ${req.originalUrl}`);
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
        console.log(`[${new Date().toISOString()}] Auth success: ${user.username} (${user.role}) accessing ${req.method} ${req.originalUrl}`);
        next();
    } catch (err) {
        console.error(`[${new Date().toISOString()}] Auth error:`, err.message);
        res.status(401).json({
            success: false,
            error: "Invalid token"
        });
    }
};

// Helper to check project access
const checkProjectAccess = async (projectId, userId, userRole) => {
    const db = getDB();
    const project = await db.collection("Projects").findOne({
        _id: new ObjectId(projectId)
    });

    if (!project) return { hasAccess: false, project: null };
    
    const hasAccess = userRole === "Admin" || 
        project.assignedTo.toString() === userId.toString();
    
    console.log(`[${new Date().toISOString()}] Project access check: ${hasAccess ? 'GRANTED' : 'DENIED'} for project ${projectId}, user ${userId}, role ${userRole}`);
    return { hasAccess, project };
};

/* ============== COMMENT ROUTES ============== */

/* GET COMMENTS (Paginated, Filtered) */
router.get("/projects/:projectId/comments", authenticate, logRequest, async (req, res) => {
    try {
        console.log(`[${new Date().toISOString()}] Fetching comments for project: ${req.params.projectId}`);
        const db = getDB();
        const CommentsCollection = db.collection("Comments");
        const { projectId } = req.params;

        if (!ObjectId.isValid(projectId)) {
            console.log(`[${new Date().toISOString()}] Invalid project ID format: ${projectId}`);
            return res.status(400).json({
                success: false,
                error: "Invalid project ID format"
            });
        }

        // Check access
        const { hasAccess } = await checkProjectAccess(
            projectId, 
            req.user.userId, 
            req.user.role
        );

        if (!hasAccess) {
            console.log(`[${new Date().toISOString()}] Access denied for project ${projectId}`);
            return res.status(403).json({
                success: false,
                error: "Access denied. You don't have permission to view this project's comments"
            });
        }

        // Pagination
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 50;
        const skip = (page - 1) * limit;

        // Filters
        const filter = { projectId: new ObjectId(projectId) };
        
        if (req.query.isValidated !== undefined) {
            filter.isValidated = req.query.isValidated === "true";
        }

        if (req.query.language) {
            filter.language = req.query.language;
        }

        if (req.query.sentiment) {
            filter.sentiment = req.query.sentiment;
        }

        // Search by text
        if (req.query.search) {
            filter.text = { $regex: req.query.search, $options: "i" };
        }

        console.log(`[${new Date().toISOString()}] Comment query filters:`, JSON.stringify(filter));

        const [comments, total] = await Promise.all([
            CommentsCollection.find(filter)
                .sort({ createdAt: -1 })
                .skip(skip)
                .limit(limit)
                .toArray(),
            CommentsCollection.countDocuments(filter)
        ]);

        console.log(`[${new Date().toISOString()}] Found ${comments.length} comments (total: ${total})`);
        res.status(200).json({
            success: true,
            data: {
                comments,
                pagination: {
                    page,
                    limit,
                    total,
                    totalPages: Math.ceil(total / limit)
                }
            }
        });

    } catch (err) {
        console.error(`[${new Date().toISOString()}] Get comments error:`, err);
        res.status(500).json({
            success: false,
            error: "Failed to fetch comments"
        });
    }
});

/* GET SINGLE COMMENT */
router.get("/comments/:commentId", authenticate, logRequest, async (req, res) => {
    try {
        console.log(`[${new Date().toISOString()}] Fetching single comment: ${req.params.commentId}`);
        const db = getDB();
        const CommentsCollection = db.collection("Comments");
        const { commentId } = req.params;

        if (!ObjectId.isValid(commentId)) {
            console.log(`[${new Date().toISOString()}] Invalid comment ID format: ${commentId}`);
            return res.status(400).json({
                success: false,
                error: "Invalid comment ID format"
            });
        }

        const comment = await CommentsCollection.findOne({
            _id: new ObjectId(commentId)
        });

        if (!comment) {
            console.log(`[${new Date().toISOString()}] Comment not found: ${commentId}`);
            return res.status(404).json({
                success: false,
                error: "Comment not found"
            });
        }

        // Check project access
        const { hasAccess } = await checkProjectAccess(
            comment.projectId,
            req.user.userId,
            req.user.role
        );

        if (!hasAccess) {
            console.log(`[${new Date().toISOString()}] Access denied for comment ${commentId}`);
            return res.status(403).json({
                success: false,
                error: "Access denied"
            });
        }

        console.log(`[${new Date().toISOString()}] Comment ${commentId} fetched successfully`);
        res.status(200).json({
            success: true,
            data: comment
        });

    } catch (err) {
        console.error(`[${new Date().toISOString()}] Get comment error:`, err);
        res.status(500).json({
            success: false,
            error: "Failed to fetch comment"
        });
    }
});

/* VALIDATE SINGLE COMMENT */
router.put("/comments/:commentId", authenticate, logRequest, async (req, res) => {
    try {
        console.log(`[${new Date().toISOString()}] Validating comment: ${req.params.commentId}`);
        const db = getDB();
        const CommentsCollection = db.collection("Comments");
        const ProjectsCollection = db.collection("Projects");
        const { commentId } = req.params;
        const { language, sentiment } = req.body;

        console.log(`[${new Date().toISOString()}] Validation data: language=${language}, sentiment=${sentiment}`);

        if (!ObjectId.isValid(commentId)) {
            console.log(`[${new Date().toISOString()}] Invalid comment ID format: ${commentId}`);
            return res.status(400).json({
                success: false,
                error: "Invalid comment ID format"
            });
        }

        // Validate language
        const validLanguages = ["Bangla", "English", "Banglish", "Emoji", "Other"];
        const validSentiments = ["Positive", "Negative", "Neutral"];

        if (!language || !validLanguages.includes(language)) {
            console.log(`[${new Date().toISOString()}] Invalid language: ${language}`);
            return res.status(400).json({
                success: false,
                error: `Invalid language. Must be one of: ${validLanguages.join(", ")}`
            });
        }

        if (!sentiment || !validSentiments.includes(sentiment)) {
            console.log(`[${new Date().toISOString()}] Invalid sentiment: ${sentiment}`);
            return res.status(400).json({
                success: false,
                error: `Invalid sentiment. Must be one of: ${validSentiments.join(", ")}`
            });
        }

        const comment = await CommentsCollection.findOne({
            _id: new ObjectId(commentId)
        });

        if (!comment) {
            console.log(`[${new Date().toISOString()}] Comment not found: ${commentId}`);
            return res.status(404).json({
                success: false,
                error: "Comment not found"
            });
        }

        // Check project access
        const { hasAccess, project } = await checkProjectAccess(
            comment.projectId,
            req.user.userId,
            req.user.role
        );

        if (!hasAccess) {
            console.log(`[${new Date().toISOString()}] Access denied for comment ${commentId}`);
            return res.status(403).json({
                success: false,
                error: "Access denied. You can only validate comments in your assigned projects"
            });
        }

        // Viewers cannot validate
        if (req.user.role === "Viewer") {
            console.log(`[${new Date().toISOString()}] Viewer attempted to validate comment ${commentId}`);
            return res.status(403).json({
                success: false,
                error: "Viewers cannot validate comments"
            });
        }

        // Check if comment is already validated
        if (comment.isValidated) {
            console.log(`[${new Date().toISOString()}] Comment ${commentId} is already validated`);
            return res.status(400).json({
                success: false,
                error: "Comment is already validated"
            });
        }

        const updateFields = {
            language: language,
            sentiment: sentiment,
            isValidated: true,
            validatedBy: new ObjectId(req.user.userId),
            validatedByUsername: req.user.username,
            validatedAt: new Date(),
            updatedAt: new Date()
        };

        const result = await CommentsCollection.updateOne(
            { _id: new ObjectId(commentId) },
            { $set: updateFields }
        );

        if (result.matchedCount === 0) {
            console.log(`[${new Date().toISOString()}] Comment not found during update: ${commentId}`);
            return res.status(404).json({
                success: false,
                error: "Comment not found"
            });
        }

        // Update project validated count
        await ProjectsCollection.updateOne(
            { _id: new ObjectId(comment.projectId) },
            { 
                $inc: { validatedCount: 1 },
                $set: { updatedAt: new Date() }
            }
        );

        const updatedComment = await CommentsCollection.findOne({
            _id: new ObjectId(commentId)
        });

        console.log(`[${new Date().toISOString()}] Comment ${commentId} validated successfully by ${req.user.username}`);
        res.status(200).json({
            success: true,
            message: "Comment validated successfully",
            data: updatedComment
        });

    } catch (err) {
        console.error(`[${new Date().toISOString()}] Validate comment error:`, err);
        res.status(500).json({
            success: false,
            error: "Failed to validate comment"
        });
    }
});

/* BULK VALIDATE COMMENTS */
router.put("/comments/bulk", authenticate, logRequest, async (req, res) => {
    try {
        console.log(`[${new Date().toISOString()}] Bulk validating comments`);
        const db = getDB();
        const CommentsCollection = db.collection("Comments");
        const ProjectsCollection = db.collection("Projects");
        const { commentIds, language, sentiment } = req.body;

        console.log(`[${new Date().toISOString()}] Bulk validate: ${commentIds?.length || 0} comments, language=${language}, sentiment=${sentiment}`);

        if (!commentIds || !Array.isArray(commentIds) || commentIds.length === 0) {
            console.log(`[${new Date().toISOString()}] No comment IDs provided`);
            return res.status(400).json({
                success: false,
                error: "commentIds array is required"
            });
        }

        // Validate fields
        const validLanguages = ["Bangla", "English", "Banglish", "Emoji", "Other"];
        const validSentiments = ["Positive", "Negative", "Neutral"];

        if (!language || !validLanguages.includes(language)) {
            console.log(`[${new Date().toISOString()}] Invalid language: ${language}`);
            return res.status(400).json({
                success: false,
                error: `Invalid language. Must be one of: ${validLanguages.join(", ")}`
            });
        }

        if (!sentiment || !validSentiments.includes(sentiment)) {
            console.log(`[${new Date().toISOString()}] Invalid sentiment: ${sentiment}`);
            return res.status(400).json({
                success: false,
                error: `Invalid sentiment. Must be one of: ${validSentiments.join(", ")}`
            });
        }

        // Validate comment IDs
        const validIds = commentIds.filter(id => ObjectId.isValid(id));
        if (validIds.length === 0) {
            console.log(`[${new Date().toISOString()}] No valid comment IDs provided`);
            return res.status(400).json({
                success: false,
                error: "No valid comment IDs provided"
            });
        }

        // Get comments to check access and project grouping
        const comments = await CommentsCollection.find({
            _id: { $in: validIds.map(id => new ObjectId(id)) },
            isValidated: { $ne: true } // Only get unvalidated comments
        }).toArray();

        console.log(`[${new Date().toISOString()}] Found ${comments.length} unvalidated comments`);

        if (comments.length === 0) {
            console.log(`[${new Date().toISOString()}] No unvalidated comments found`);
            return res.status(404).json({
                success: false,
                error: "No unvalidated comments found"
            });
        }

        // Check access for each comment's project
        const projectIds = [...new Set(comments.map(c => c.projectId.toString()))];
        console.log(`[${new Date().toISOString()}] Comments belong to projects: ${projectIds.join(', ')}`);
        
        for (const projectId of projectIds) {
            const { hasAccess } = await checkProjectAccess(
                projectId,
                req.user.userId,
                req.user.role
            );
            
            if (!hasAccess) {
                console.log(`[${new Date().toISOString()}] Access denied for project ${projectId}`);
                return res.status(403).json({
                    success: false,
                    error: `Access denied for one or more comments in project ${projectId}`
                });
            }
        }

        // Viewers cannot validate
        if (req.user.role === "Viewer") {
            console.log(`[${new Date().toISOString()}] Viewer attempted bulk validation`);
            return res.status(403).json({
                success: false,
                error: "Viewers cannot validate comments"
            });
        }

        const commentIdsToUpdate = comments.map(c => c._id);

        // Prepare update
        const updateFields = {
            language: language,
            sentiment: sentiment,
            isValidated: true,
            validatedBy: new ObjectId(req.user.userId),
            validatedByUsername: req.user.username,
            validatedAt: new Date(),
            updatedAt: new Date()
        };

        // Update comments
        const result = await CommentsCollection.updateMany(
            { _id: { $in: commentIdsToUpdate } },
            { $set: updateFields }
        );

        // Update project validated counts
        const projectUpdates = {};
        for (const comment of comments) {
            const projectId = comment.projectId.toString();
            if (!projectUpdates[projectId]) {
                projectUpdates[projectId] = 0;
            }
            projectUpdates[projectId]++;
        }

        for (const [projectId, count] of Object.entries(projectUpdates)) {
            await ProjectsCollection.updateOne(
                { _id: new ObjectId(projectId) },
                { 
                    $inc: { validatedCount: count },
                    $set: { updatedAt: new Date() }
                }
            );
        }

        console.log(`[${new Date().toISOString()}] Bulk validation complete: ${result.modifiedCount} comments updated`);
        res.status(200).json({
            success: true,
            message: `${result.modifiedCount} comments validated successfully`,
            data: {
                modifiedCount: result.modifiedCount,
                totalProcessed: comments.length
            }
        });

    } catch (err) {
        console.error(`[${new Date().toISOString()}] Bulk validate error:`, err);
        res.status(500).json({
            success: false,
            error: "Failed to bulk validate comments"
        });
    }
});

/* GET UNVALIDATED COMMENTS COUNT */
router.get("/projects/:projectId/unvalidated-count", authenticate, logRequest, async (req, res) => {
    try {
        console.log(`[${new Date().toISOString()}] Getting unvalidated count for project: ${req.params.projectId}`);
        const db = getDB();
        const CommentsCollection = db.collection("Comments");
        const { projectId } = req.params;

        if (!ObjectId.isValid(projectId)) {
            console.log(`[${new Date().toISOString()}] Invalid project ID format: ${projectId}`);
            return res.status(400).json({
                success: false,
                error: "Invalid project ID format"
            });
        }

        // Check access
        const { hasAccess } = await checkProjectAccess(
            projectId,
            req.user.userId,
            req.user.role
        );

        if (!hasAccess) {
            console.log(`[${new Date().toISOString()}] Access denied for project ${projectId}`);
            return res.status(403).json({
                success: false,
                error: "Access denied"
            });
        }

        const count = await CommentsCollection.countDocuments({
            projectId: new ObjectId(projectId),
            isValidated: false
        });

        console.log(`[${new Date().toISOString()}] Unvalidated count: ${count} for project ${projectId}`);
        res.status(200).json({
            success: true,
            data: { unvalidatedCount: count }
        });

    } catch (err) {
        console.error(`[${new Date().toISOString()}] Get unvalidated count error:`, err);
        res.status(500).json({
            success: false,
            error: "Failed to get unvalidated count"
        });
    }
});

module.exports = router;