const express = require("express");
const router = express.Router();

const { getDB } = require("../config/db");

const { ObjectId } = require("mongodb");

// File upload
const fs = require("fs");
const path = require("path");
const multer = require("multer");

// Middleware
const { authenticate, logRequest } = require("../middleware");
const { parseFileForComments } = require("../services/fileParser");

// Multer configuration
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
    cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname));
  },
});

// File filter
const fileFilter = ( file, cb) => {
  const allowedTypes = [
    "text/csv",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheet.sheet",
  ];
  if (allowedTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(new Error("Invalid file type. Only CSV and Excel files are allowed"), false);
  }
};

// Multer
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter,
});

// CREATE PROJECT
router.post("/projects", authenticate, logRequest, async (req, res) => {
  try {
    // console.log("Creating project by:", req.user.username);
    if (req.user.role !== "Admin") {
      // console.log("Non-admin tried to create project:", req.user.username);
      return res.status(403).json({ success: false, error: "Admin only" });
    }

    const db = getDB();
    const ProjectsCollection = db.collection("Projects");
    const { name, description, assignedTo } = req.body;

    if (!name || !assignedTo) {
      return res
        .status(400)
        .json({ success: false, error: "Project name and assignedTo are required" });
    }

    // console.log("Verifying assigned user:", assignedTo);
    const assignedUser = await db.collection("Users").findOne({
      _id: new ObjectId(assignedTo),
      role: { $in: ["Annotator", "Viewer"] },
    });

    if (!assignedUser) {
      // console.log("Invalid assigned user:", assignedTo);
      return res
        .status(400)
        .json({ success: false, error: "Assigned user is not an annotator or viewer" });
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
    // console.log("Project created:", name, "ID:", result.insertedId);

    res.status(201).json({
      success: true,
      message: "Project created successfully",
      data: { ...newProject, _id: result.insertedId },
    });
  } catch (err) {
    // console.error("Create project error:", err);
    res.status(500).json({ success: false, error: "Failed to create project" });
  }
});

// GET ALL PROJECTS
router.get("/projects", authenticate, logRequest, async (req, res) => {
  try {
    // console.log("Fetching projects for user:", req.user.username);
    const db = getDB();
    const ProjectsCollection = db.collection("Projects");
    let query = {};

    if (req.user.role !== "Admin") {
      query.assignedTo = new ObjectId(req.user.userId);
      // console.log("Filtering for assigned user:", req.user.userId);
    }

    const projects = await ProjectsCollection.find(query)
      .sort({ createdAt: -1 })
      .toArray();

    // console.log("Found", projects.length, "projects");
    res.status(200).json({
      success: true,
      count: projects.length,
      data: projects,
    });
  } catch (err) {
    // console.error("Get projects error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch projects" });
  }
});

// GET SINGLE PROJECT
router.get("/projects/:projectId", authenticate, logRequest, async (req, res) => {
  try {
    // console.log("Fetching project:", req.params.projectId);
    const db = getDB();
    const ProjectsCollection = db.collection("Projects");
    const { projectId } = req.params;

    if (!ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, error: "Invalid project ID" });
    }

    const project = await ProjectsCollection.findOne({ _id: new ObjectId(projectId) });
    if (!project) {
      // console.log("Project not found:", projectId);
      return res.status(404).json({ success: false, error: "Project not found" });
    }

    if (
      req.user.role !== "Admin" &&
      project.assignedTo.toString() !== req.user.userId.toString()
    ) {
      // console.log("Access denied for user:", req.user.username);
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    res.status(200).json({
      success: true,
      data: project,
    });
  } catch (err) {
    // console.error("Get project error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch project" });
  }
});

// DELETE PROJECT (Hard delete)
router.delete("/projects/:projectId", authenticate, logRequest, async (req, res) => {
  try {
    // console.log("Deleting project:", req.params.projectId);
    if (req.user.role !== "Admin") {
      // console.log("Non-admin tried to delete project:", req.user.username);
      return res.status(403).json({ success: false, error: "Admin only" });
    }

    const db = getDB();
    const ProjectsCollection = db.collection("Projects");
    const CommentsCollection = db.collection("Comments");
    const { projectId } = req.params;

    if (!ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, error: "Invalid project ID" });
    }

    const project = await ProjectsCollection.findOne({ _id: new ObjectId(projectId) });
    if (!project) {
      // console.log("Project not found:", projectId);
      return res.status(404).json({ success: false, error: "Project not found" });
    }

    // console.log("Deleting associated comments");
    const commentsResult = await CommentsCollection.deleteMany({
      projectId: new ObjectId(projectId),
    });

    const result = await ProjectsCollection.deleteOne({ _id: new ObjectId(projectId) });

    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, error: "Project not found during deletion" });
    }

    // console.log("Project and", commentsResult.deletedCount, "comments deleted");
    res.status(200).json({
      success: true,
      message: `Project and ${commentsResult.deletedCount} comments permanently deleted`,
      data: {
        projectDeleted: true,
        commentsDeleted: commentsResult.deletedCount,
      },
    });
  } catch (err) {
    // console.error("Delete project error:", err);
    res.status(500).json({ success: false, error: "Failed to delete project" });
  }
});

// UPLOAD FILE TO PROJECT (prevent duplicate uploads)
router.post(
  "/projects/:projectId/upload",
  authenticate,
  logRequest,
  upload.single("file"),
  async (req, res) => {
    try {
      // console.log("Uploading file to project:", req.params.projectId);
      const db = getDB();
      const ProjectsCollection = db.collection("Projects");
      const CommentsCollection = db.collection("Comments");
      const { projectId } = req.params;

      if (!ObjectId.isValid(projectId)) {
        return res.status(400).json({ success: false, error: "Invalid project ID" });
      }

      const project = await ProjectsCollection.findOne({ _id: new ObjectId(projectId) });
      if (!project) {
        // console.log("Project not found:", projectId);
        return res.status(404).json({ success: false, error: "Project not found" });
      }

      // 🔒 PREVENT DUPLICATE UPLOAD
      if (project.fileInfo) {
        // console.log("Duplicate upload attempt for project:", projectId);
        return res.status(400).json({
          success: false,
          error: "A file has already been uploaded to this project. Duplicate uploads are not allowed.",
        });
      }

      if (req.user.role !== "Admin" && project.assignedTo.toString() !== req.user.userId.toString()) {
        // console.log("Access denied for upload:", req.user.username);
        return res.status(403).json({ success: false, error: "Access denied" });
      }

      if (!req.file) {
        return res.status(400).json({ success: false, error: "No file uploaded" });
      }

      // console.log("File received:", req.file.originalname, "size:", req.file.size);

      const filePath = req.file.path;
      let parsedComments = [];

      try {
        // console.log("Parsing file...");
        const parsed = parseFileForComments(filePath);
        parsedComments = parsed.map((item) => ({
          externalId: item.externalId,
          text: item.text,
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
        // console.log("Parsed", parsedComments.length, "comments");
      } catch (parseError) {
        // console.log("Parse error:", parseError.message);
        fs.unlinkSync(filePath);
        return res.status(400).json({
          success: false,
          error: `File parsing failed: ${parseError.message}`,
        });
      }

      // console.log("Inserting comments...");
      const insertResult = await CommentsCollection.insertMany(parsedComments);
      // console.log("Inserted", insertResult.insertedCount, "comments");

      await ProjectsCollection.updateOne(
        { _id: new ObjectId(projectId) },
        {
          $set: {
            totalComments: parsedComments.length,
            status: parsedComments.length > 0 ? "in_progress" : "pending",
            fileInfo: {
              filename: req.file.filename,
              originalName: req.file.originalname,
              fileSize: req.file.size,
              fileType: req.file.mimetype,
              uploadedAt: new Date(),
            },
            updatedAt: new Date(),
          },
        }
      );

      fs.unlinkSync(filePath);
      // console.log("Temporary file deleted");

      res.status(200).json({
        success: true,
        message: `File uploaded successfully. ${parsedComments.length} comments imported.`,
        data: {
          totalComments: parsedComments.length,
          commentIds: insertResult.insertedIds,
        },
      });
    } catch (err) {
      // console.error("Upload error:", err);
      if (req.file && req.file.path) {
        try {
          fs.unlinkSync(req.file.path);
        } catch (cleanupErr) {
          // console.error("Error deleting file:", cleanupErr);
        }
      }
      res.status(500).json({ success: false, error: "Failed to upload file" });
    }
  }
);

// DOWNLOAD COMMENTS AS CSV
router.get("/projects/:projectId/download-csv", authenticate, logRequest, async (req, res) => {
  try {
    // console.log("Downloading CSV for project:", req.params.projectId);
    const db = getDB();
    const ProjectsCollection = db.collection("Projects");
    const CommentsCollection = db.collection("Comments");
    const { projectId } = req.params;

    if (!ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, error: "Invalid project ID" });
    }

    const project = await ProjectsCollection.findOne({ _id: new ObjectId(projectId) });
    if (!project) {
      // console.log("Project not found:", projectId);
      return res.status(404).json({ success: false, error: "Project not found" });
    }

    if (req.user.role !== "Admin" && project.assignedTo.toString() !== req.user.userId.toString()) {
      // console.log("Access denied for CSV download:", req.user.username);
      return res.status(403).json({ success: false, error: "Access denied" });
    }

    // console.log("Fetching comments...");
    const comments = await CommentsCollection.find({
      projectId: new ObjectId(projectId),
    }).toArray();

    if (comments.length === 0) {
      return res.status(404).json({ success: false, error: "No comments found for this project" });
    }

    // console.log("Found", comments.length, "comments, building CSV");

    // Build CSV header
    const headers = [
      "externalId",
      "text",
      "language",
      "sentiment",
      "isValidated",
      "validatedByUsername",
      "validatedAt",
      "createdAt",
    ];

    // Build CSV rows
    const rows = comments.map((c) => [
      c.externalId || "",
      c.text || "",
      c.language || "",
      c.sentiment || "",
      c.isValidated ? "true" : "false",
      c.validatedByUsername || "",
      c.validatedAt ? new Date(c.validatedAt).toISOString() : "",
      new Date(c.createdAt).toISOString(),
    ]);

    const csvContent = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
    // console.log("CSV generated, size:", csvContent.length);

    res.setHeader("Content-Type", "text/csv");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="project_${project.name.replace(/\s+/g, "_")}_comments.csv"`
    );

    res.status(200).send(csvContent);
  } catch (err) {
    // console.error("Download CSV error:", err);
    res.status(500).json({ success: false, error: "Failed to download CSV" });
  }
});

module.exports = router;