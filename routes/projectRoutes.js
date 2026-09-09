const express = require("express");
const router = express.Router();
const { getDB } = require("../config/db");
const { ObjectId } = require("mongodb");
const multer = require("multer");
const XLSX = require("xlsx");
const path = require("path");
const fs = require("fs");

// Simple logging middleware
const logRequest = (req, res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - User: ${req.user?.username || "unauthenticated"}`,
  );
  next();
};

// Authentication middleware (same as above)
const authenticate = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      console.log(
        `[${new Date().toISOString()}] Auth failed: No token provided for ${req.method} ${req.originalUrl}`,
      );
      return res.status(401).json({
        success: false,
        error: "No token provided",
      });
    }

    const jwt = require("jsonwebtoken");
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const db = getDB();
    const user = await db.collection("Users").findOne({
      _id: new ObjectId(decoded.userId),
      isDeleted: { $ne: true },
    });

    if (!user) {
      console.log(
        `[${new Date().toISOString()}] Auth failed: User not found for ${req.method} ${req.originalUrl}`,
      );
      return res.status(401).json({
        success: false,
        error: "User not found",
      });
    }

    req.user = {
      userId: user._id,
      uid: user.uid,
      username: user.username,
      email: user.email,
      role: user.role,
    };
    console.log(
      `[${new Date().toISOString()}] Auth success: ${user.username} (${user.role}) accessing ${req.method} ${req.originalUrl}`,
    );
    next();
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Auth error:`, err.message);
    res.status(401).json({
      success: false,
      error: "Invalid token",
    });
  }
};

// Configure multer for file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "../uploads");
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(
      null,
      file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname),
    );
  },
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    "text/csv",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      new Error("Invalid file type. Only CSV and Excel files are allowed"),
      false,
    );
  }
};

const upload = multer({
  storage: storage,
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: fileFilter,
});

/* ============== PROJECT ROUTES ============== */

/* CREATE PROJECT (Admin only) */
router.post("/projects", authenticate, logRequest, async (req, res) => {
  try {
    console.log(
      `[${new Date().toISOString()}] Creating new project by ${req.user.username}`,
    );

    if (req.user.role !== "Admin") {
      console.log(
        `[${new Date().toISOString()}] Non-admin ${req.user.username} attempted to create project`,
      );
      return res.status(403).json({
        success: false,
        error: "Access denied. Admin only",
      });
    }

    const db = getDB();
    const ProjectsCollection = db.collection("Projects");

    const { name, description, assignedTo } = req.body;

    console.log(
      `[${new Date().toISOString()}] Project data: name=${name}, assignedTo=${assignedTo}`,
    );

    if (!name || !assignedTo) {
      console.log(
        `[${new Date().toISOString()}] Missing required fields: name=${name}, assignedTo=${assignedTo}`,
      );
      return res.status(400).json({
        success: false,
        error: "Project name and assignedTo are required",
      });
    }

    // Verify assigned user exists and is an annotator/viewer
    const assignedUser = await db.collection("Users").findOne({
      _id: new ObjectId(assignedTo),
      isDeleted: { $ne: true },
      role: { $in: ["Annotator", "Viewer"] },
    });

    if (!assignedUser) {
      console.log(
        `[${new Date().toISOString()}] Assigned user ${assignedTo} not found or not authorized`,
      );
      return res.status(400).json({
        success: false,
        error: "Assigned user not found or not an annotator/viewer",
      });
    }

    const newProject = {
      name,
      description: description || "",
      assignedTo: new ObjectId(assignedTo),
      assignedToUsername: assignedUser.username,
      createdBy: new ObjectId(req.user.userId),
      createdByUsername: req.user.username,
      totalComments: 0,
      validatedCount: 0,
      status: "pending",
      fileInfo: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await ProjectsCollection.insertOne(newProject);

    console.log(
      `[${new Date().toISOString()}] Project created successfully: ${result.insertedId}`,
    );
    res.status(201).json({
      success: true,
      message: "Project created successfully",
      data: {
        ...newProject,
        _id: result.insertedId,
      },
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Create project error:`, err);
    res.status(500).json({
      success: false,
      error: "Failed to create project",
    });
  }
});

/* GET ALL PROJECTS (Filtered by role) */
router.get("/projects", authenticate, logRequest, async (req, res) => {
  try {
    console.log(
      `[${new Date().toISOString()}] Fetching projects for ${req.user.username} (${req.user.role})`,
    );
    const db = getDB();
    const ProjectsCollection = db.collection("Projects");

    let query = {};

    // Annotators and Viewers only see their assigned projects
    if (req.user.role !== "Admin") {
      query.assignedTo = new ObjectId(req.user.userId);
      console.log(
        `[${new Date().toISOString()}] Filtering projects for user: ${req.user.userId}`,
      );
    }

    const projects = await ProjectsCollection.find(query)
      .sort({ createdAt: -1 })
      .toArray();

    console.log(
      `[${new Date().toISOString()}] Found ${projects.length} projects`,
    );
    res.status(200).json({
      success: true,
      count: projects.length,
      data: projects,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] Get projects error:`, err);
    res.status(500).json({
      success: false,
      error: "Failed to fetch projects",
    });
  }
});

/* GET SINGLE PROJECT */
router.get(
  "/projects/:projectId",
  authenticate,
  logRequest,
  async (req, res) => {
    try {
      console.log(
        `[${new Date().toISOString()}] Fetching project: ${req.params.projectId}`,
      );
      const db = getDB();
      const ProjectsCollection = db.collection("Projects");
      const { projectId } = req.params;

      if (!ObjectId.isValid(projectId)) {
        console.log(
          `[${new Date().toISOString()}] Invalid project ID format: ${projectId}`,
        );
        return res.status(400).json({
          success: false,
          error: "Invalid project ID format",
        });
      }

      const project = await ProjectsCollection.findOne({
        _id: new ObjectId(projectId),
      });

      if (!project) {
        console.log(
          `[${new Date().toISOString()}] Project not found: ${projectId}`,
        );
        return res.status(404).json({
          success: false,
          error: "Project not found",
        });
      }

      // Check access
      if (
        req.user.role !== "Admin" &&
        project.assignedTo.toString() !== req.user.userId.toString()
      ) {
        console.log(
          `[${new Date().toISOString()}] Access denied for project ${projectId}`,
        );
        return res.status(403).json({
          success: false,
          error:
            "Access denied. You don't have permission to view this project",
        });
      }

      console.log(
        `[${new Date().toISOString()}] Project ${projectId} fetched successfully`,
      );
      res.status(200).json({
        success: true,
        data: project,
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Get project error:`, err);
      res.status(500).json({
        success: false,
        error: "Failed to fetch project",
      });
    }
  },
);

/* UPDATE PROJECT (Admin only) */
router.put(
  "/projects/:projectId",
  authenticate,
  logRequest,
  async (req, res) => {
    try {
      console.log(
        `[${new Date().toISOString()}] Updating project: ${req.params.projectId}`,
      );

      if (req.user.role !== "Admin") {
        console.log(
          `[${new Date().toISOString()}] Non-admin ${req.user.username} attempted to update project`,
        );
        return res.status(403).json({
          success: false,
          error: "Access denied. Admin only",
        });
      }

      const db = getDB();
      const ProjectsCollection = db.collection("Projects");
      const { projectId } = req.params;

      if (!ObjectId.isValid(projectId)) {
        console.log(
          `[${new Date().toISOString()}] Invalid project ID format: ${projectId}`,
        );
        return res.status(400).json({
          success: false,
          error: "Invalid project ID format",
        });
      }

      const { name, description, assignedTo, status } = req.body;

      const updateFields = {
        updatedAt: new Date(),
      };

      if (name) updateFields.name = name;
      if (description !== undefined) updateFields.description = description;
      if (status) updateFields.status = status;

      if (assignedTo) {
        console.log(
          `[${new Date().toISOString()}] Changing assignment to: ${assignedTo}`,
        );
        const assignedUser = await db.collection("Users").findOne({
          _id: new ObjectId(assignedTo),
          isDeleted: { $ne: true },
          role: { $in: ["Annotator", "Viewer"] },
        });

        if (!assignedUser) {
          console.log(
            `[${new Date().toISOString()}] Assigned user ${assignedTo} not found or not authorized`,
          );
          return res.status(400).json({
            success: false,
            error: "Assigned user not found or not an annotator/viewer",
          });
        }

        updateFields.assignedTo = new ObjectId(assignedTo);
        updateFields.assignedToUsername = assignedUser.username;
      }

      const result = await ProjectsCollection.updateOne(
        { _id: new ObjectId(projectId) },
        { $set: updateFields },
      );

      if (result.matchedCount === 0) {
        console.log(
          `[${new Date().toISOString()}] Project not found: ${projectId}`,
        );
        return res.status(404).json({
          success: false,
          error: "Project not found",
        });
      }

      const updatedProject = await ProjectsCollection.findOne({
        _id: new ObjectId(projectId),
      });

      console.log(
        `[${new Date().toISOString()}] Project ${projectId} updated successfully`,
      );
      res.status(200).json({
        success: true,
        message: "Project updated successfully",
        data: updatedProject,
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Update project error:`, err);
      res.status(500).json({
        success: false,
        error: "Failed to update project",
      });
    }
  },
);

/* DELETE PROJECT (Admin only - Soft Delete) */
router.delete(
  "/projects/:projectId",
  authenticate,
  logRequest,
  async (req, res) => {
    try {
      console.log(
        `[${new Date().toISOString()}] Deleting project: ${req.params.projectId}`,
      );

      if (req.user.role !== "Admin") {
        console.log(
          `[${new Date().toISOString()}] Non-admin ${req.user.username} attempted to delete project`,
        );
        return res.status(403).json({
          success: false,
          error: "Access denied. Admin only",
        });
      }

      const db = getDB();
      const ProjectsCollection = db.collection("Projects");
      const { projectId } = req.params;

      if (!ObjectId.isValid(projectId)) {
        console.log(
          `[${new Date().toISOString()}] Invalid project ID format: ${projectId}`,
        );
        return res.status(400).json({
          success: false,
          error: "Invalid project ID format",
        });
      }

      const result = await ProjectsCollection.updateOne(
        { _id: new ObjectId(projectId) },
        {
          $set: {
            isDeleted: true,
            deletedAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );

      if (result.matchedCount === 0) {
        console.log(
          `[${new Date().toISOString()}] Project not found: ${projectId}`,
        );
        return res.status(404).json({
          success: false,
          error: "Project not found",
        });
      }

      console.log(
        `[${new Date().toISOString()}] Project ${projectId} deleted successfully`,
      );
      res.status(200).json({
        success: true,
        message: "Project deleted successfully",
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Delete project error:`, err);
      res.status(500).json({
        success: false,
        error: "Failed to delete project",
      });
    }
  },
);

/* UPLOAD FILE TO PROJECT */
router.post(
  "/projects/:projectId/upload",
  authenticate,
  logRequest,
  upload.single("file"),
  async (req, res) => {
    try {
      console.log(
        `[${new Date().toISOString()}] Uploading file to project: ${req.params.projectId}`,
      );
      const db = getDB();
      const ProjectsCollection = db.collection("Projects");
      const CommentsCollection = db.collection("Comments");
      const { projectId } = req.params;

      if (!ObjectId.isValid(projectId)) {
        console.log(
          `[${new Date().toISOString()}] Invalid project ID format: ${projectId}`,
        );
        return res.status(400).json({
          success: false,
          error: "Invalid project ID format",
        });
      }

      const project = await ProjectsCollection.findOne({
        _id: new ObjectId(projectId),
      });

      if (!project) {
        console.log(
          `[${new Date().toISOString()}] Project not found: ${projectId}`,
        );
        return res.status(404).json({
          success: false,
          error: "Project not found",
        });
      }

      // Check if user has access to this project
      if (
        req.user.role !== "Admin" &&
        project.assignedTo.toString() !== req.user.userId.toString()
      ) {
        console.log(
          `[${new Date().toISOString()}] Access denied for upload to project ${projectId}`,
        );
        return res.status(403).json({
          success: false,
          error: "Access denied. You can only upload to your assigned projects",
        });
      }

      if (!req.file) {
        console.log(`[${new Date().toISOString()}] No file uploaded`);
        return res.status(400).json({
          success: false,
          error: "No file uploaded",
        });
      }

      console.log(
        `[${new Date().toISOString()}] File received: ${req.file.originalname} (${req.file.size} bytes)`,
      );

      // Parse the file
      let comments = [];
      const filePath = req.file.path;
      const fileExtension = path.extname(req.file.originalname).toLowerCase();

      try {
        let workbook;
        if (fileExtension === ".csv") {
          workbook = XLSX.readFile(filePath, { type: "file" });
        } else {
          workbook = XLSX.readFile(filePath);
        }

        const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
        const data = XLSX.utils.sheet_to_json(firstSheet);

        if (data.length === 0) {
          throw new Error("File is empty");
        }

        const headers = Object.keys(data[0]);
        const commentColumn = headers.find(
          (h) =>
            h.toLowerCase().includes("comment") ||
            h.toLowerCase().includes("text") ||
            h.toLowerCase() === "comment_text",
        );

        if (!commentColumn) {
          throw new Error(
            "No comment column found. Expected column with 'comment' or 'text' in name",
          );
        }

        console.log(
          `[${new Date().toISOString()}] Found ${data.length} rows, using column: ${commentColumn}`,
        );

        comments = data.map((row, index) => ({
          externalId: row.id || row.externalId || `row_${index + 1}`,
          text: String(row[commentColumn] || "").trim(),
          projectId: new ObjectId(projectId),
          language: null,
          sentiment: null,
          isValidated: false,
          validatedBy: null,
          validatedByUsername: null,
          validatedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        }));

        comments = comments.filter((c) => c.text.length > 0);

        if (comments.length === 0) {
          throw new Error("No valid comments found in the file");
        }

        console.log(
          `[${new Date().toISOString()}] Extracted ${comments.length} valid comments`,
        );
      } catch (parseError) {
        fs.unlinkSync(filePath);
        console.log(
          `[${new Date().toISOString()}] File parsing error: ${parseError.message}`,
        );
        return res.status(400).json({
          success: false,
          error: `Failed to parse file: ${parseError.message}`,
        });
      }

      // Save comments to database
      const insertResult = await CommentsCollection.insertMany(comments);

      // Update project
      await ProjectsCollection.updateOne(
        { _id: new ObjectId(projectId) },
        {
          $set: {
            totalComments: comments.length,
            status: comments.length > 0 ? "in_progress" : "pending",
            fileInfo: {
              filename: req.file.filename,
              originalName: req.file.originalname,
              fileSize: req.file.size,
              fileType: req.file.mimetype,
              uploadedAt: new Date(),
            },
            updatedAt: new Date(),
          },
        },
      );

      fs.unlinkSync(filePath);

      console.log(
        `[${new Date().toISOString()}] File uploaded successfully. ${comments.length} comments imported to project ${projectId}`,
      );
      res.status(200).json({
        success: true,
        message: `File uploaded successfully. ${comments.length} comments imported.`,
        data: {
          totalComments: comments.length,
          commentIds: insertResult.insertedIds,
        },
      });
    } catch (err) {
      console.error(`[${new Date().toISOString()}] Upload file error:`, err);
      if (req.file && req.file.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (unlinkErr) {
          console.error("Error deleting file:", unlinkErr);
        }
      }
      res.status(500).json({
        success: false,
        error: "Failed to upload file",
      });
    }
  },
);

/* GET PROJECT STATISTICS */
router.get(
  "/projects/:projectId/stats",
  authenticate,
  logRequest,
  async (req, res) => {
    try {
      console.log(
        `[${new Date().toISOString()}] Fetching stats for project: ${req.params.projectId}`,
      );
      const db = getDB();
      const ProjectsCollection = db.collection("Projects");
      const CommentsCollection = db.collection("Comments");
      const { projectId } = req.params;

      if (!ObjectId.isValid(projectId)) {
        console.log(
          `[${new Date().toISOString()}] Invalid project ID format: ${projectId}`,
        );
        return res.status(400).json({
          success: false,
          error: "Invalid project ID format",
        });
      }

      const project = await ProjectsCollection.findOne({
        _id: new ObjectId(projectId),
      });

      if (!project) {
        console.log(
          `[${new Date().toISOString()}] Project not found: ${projectId}`,
        );
        return res.status(404).json({
          success: false,
          error: "Project not found",
        });
      }

      if (
        req.user.role !== "Admin" &&
        project.assignedTo.toString() !== req.user.userId.toString()
      ) {
        console.log(
          `[${new Date().toISOString()}] Access denied for stats on project ${projectId}`,
        );
        return res.status(403).json({
          success: false,
          error: "Access denied",
        });
      }

      const stats = await CommentsCollection.aggregate([
        { $match: { projectId: new ObjectId(projectId) } },
        {
          $facet: {
            total: [{ $count: "count" }],
            validated: [{ $match: { isValidated: true } }, { $count: "count" }],
            byLanguage: [{ $group: { _id: "$language", count: { $sum: 1 } } }],
            bySentiment: [
              { $group: { _id: "$sentiment", count: { $sum: 1 } } },
            ],
            byValidator: [
              { $match: { isValidated: true } },
              { $group: { _id: "$validatedByUsername", count: { $sum: 1 } } },
            ],
          },
        },
      ]).toArray();

      const result = stats[0] || {};

      console.log(
        `[${new Date().toISOString()}] Stats fetched for project ${projectId}: total=${result.total?.[0]?.count || 0}, validated=${result.validated?.[0]?.count || 0}`,
      );
      res.status(200).json({
        success: true,
        data: {
          totalComments: result.total?.[0]?.count || 0,
          validatedCount: result.validated?.[0]?.count || 0,
          progress:
            result.total?.[0]?.count > 0
              ? Math.round(
                  ((result.validated?.[0]?.count || 0) /
                    result.total[0].count) *
                    100,
                )
              : 0,
          byLanguage: result.byLanguage || [],
          bySentiment: result.bySentiment || [],
          byValidator: result.byValidator || [],
        },
      });
    } catch (err) {
      console.error(
        `[${new Date().toISOString()}] Get project stats error:`,
        err,
      );
      res.status(500).json({
        success: false,
        error: "Failed to fetch project statistics",
      });
    }
  },
);

module.exports = router;
