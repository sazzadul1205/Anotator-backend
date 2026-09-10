const express = require("express");
const router = express.Router();
const { getDB } = require("../config/db");
const { ObjectId } = require("mongodb");

const fs = require("fs");
const path = require("path");
const multer = require("multer");
const ExcelJS = require("exceljs");

const { authenticate, logRequest } = require("../middleware");
const { parseFileForComments } = require("../services/fileParser");
const { recordChange } = require("../config/versioning");
const { buildCSV } = require("../utils/csv");

// Multer config (unchanged)
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, "../uploads");
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname));
  },
});

const fileFilter = (req, file, cb) => {
  const allowedTypes = [
    "text/csv",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ];
  if (allowedTypes.includes(file.mimetype)) cb(null, true);
  else cb(new Error("Invalid file type. Only CSV and Excel files are allowed"), false);
};

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter,
});

/* CREATE PROJECT */
router.post("/projects", authenticate, logRequest, async (req, res) => {
  try {
    if (req.user.role !== "Admin") {
      return res.status(403).json({ success: false, error: "Admin only" });
    }
    const db = getDB();
    const ProjectsCollection = db.collection("Projects");
    const { name, description, assignedTo } = req.body;

    if (!name || !assignedTo) {
      return res.status(400).json({
        success: false,
        error: "Project name and assignedTo are required",
      });
    }

    const assignedUser = await db.collection("Users").findOne({
      _id: new ObjectId(assignedTo),
      role: { $in: ["Annotator", "Viewer"] },
    });
    if (!assignedUser) {
      return res.status(400).json({
        success: false,
        error: "Assigned user is not an annotator or viewer",
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

    await recordChange({
      entityType: "Project",
      entityId: result.insertedId,
      action: "create",
      after: newProject,
      user: req.user,
      projectId: result.insertedId,
    });

    res.status(201).json({
      success: true,
      message: "Project created successfully",
      data: { ...newProject, _id: result.insertedId },
    });
  } catch (err) {
    console.error("Create project error:", err);
    res.status(500).json({ success: false, error: "Failed to create project" });
  }
});

/* GET ALL PROJECTS */
router.get("/projects", authenticate, logRequest, async (req, res) => {
  try {
    const db = getDB();
    const ProjectsCollection = db.collection("Projects");
    let query = {};
    if (req.user.role !== "Admin") {
      query.assignedTo = new ObjectId(req.user.userId);
    }
    const projects = await ProjectsCollection.find(query)
      .sort({ createdAt: -1 })
      .toArray();
    res.status(200).json({ success: true, count: projects.length, data: projects });
  } catch (err) {
    console.error("Get projects error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch projects" });
  }
});

/* GET SINGLE PROJECT */
router.get("/projects/:projectId", authenticate, logRequest, async (req, res) => {
  try {
    const db = getDB();
    const ProjectsCollection = db.collection("Projects");
    const { projectId } = req.params;

    if (!ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, error: "Invalid project ID" });
    }
    const project = await ProjectsCollection.findOne({
      _id: new ObjectId(projectId),
    });
    if (!project) {
      return res.status(404).json({ success: false, error: "Project not found" });
    }
    if (
      req.user.role !== "Admin" &&
      project.assignedTo.toString() !== req.user.userId.toString()
    ) {
      return res.status(403).json({ success: false, error: "Access denied" });
    }
    res.status(200).json({ success: true, data: project });
  } catch (err) {
    console.error("Get project error:", err);
    res.status(500).json({ success: false, error: "Failed to fetch project" });
  }
});

/* ✅ UPDATE PROJECT (Admin only) */
router.put("/projects/:projectId", authenticate, logRequest, async (req, res) => {
  try {
    if (req.user.role !== "Admin") {
      return res.status(403).json({ success: false, error: "Admin only" });
    }
    const db = getDB();
    const ProjectsCollection = db.collection("Projects");
    const { projectId } = req.params;
    const { name, description, assignedTo, status } = req.body;

    if (!ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, error: "Invalid project ID" });
    }

    const project = await ProjectsCollection.findOne({
      _id: new ObjectId(projectId),
    });
    if (!project) {
      return res.status(404).json({ success: false, error: "Project not found" });
    }

    const updateFields = { updatedAt: new Date() };

    if (name !== undefined) updateFields.name = name;
    if (description !== undefined) updateFields.description = description;
    if (status !== undefined) updateFields.status = status;

    if (assignedTo && assignedTo !== project.assignedTo.toString()) {
      const assignedUser = await db.collection("Users").findOne({
        _id: new ObjectId(assignedTo),
        role: { $in: ["Annotator", "Viewer"] },
      });
      if (!assignedUser) {
        return res.status(400).json({
          success: false,
          error: "Assigned user is not an annotator or viewer",
        });
      }
      updateFields.assignedTo = new ObjectId(assignedTo);
      updateFields.assignedToUsername = assignedUser.username;
    }

    const before = { ...project };
    await ProjectsCollection.updateOne(
      { _id: new ObjectId(projectId) },
      { $set: updateFields }
    );
    const after = await ProjectsCollection.findOne({
      _id: new ObjectId(projectId),
    });

    await recordChange({
      entityType: "Project",
      entityId: projectId,
      action: "update",
      before,
      after,
      user: req.user,
      projectId,
    });

    res.status(200).json({ success: true, message: "Project updated", data: after });
  } catch (err) {
    console.error("Update project error:", err);
    res.status(500).json({ success: false, error: "Failed to update project" });
  }
});

/* DELETE PROJECT */
router.delete("/projects/:projectId", authenticate, logRequest, async (req, res) => {
  try {
    if (req.user.role !== "Admin") {
      return res.status(403).json({ success: false, error: "Admin only" });
    }
    const db = getDB();
    const ProjectsCollection = db.collection("Projects");
    const CommentsCollection = db.collection("Comments");
    const { projectId } = req.params;

    if (!ObjectId.isValid(projectId)) {
      return res.status(400).json({ success: false, error: "Invalid project ID" });
    }
    const project = await ProjectsCollection.findOne({
      _id: new ObjectId(projectId),
    });
    if (!project) {
      return res.status(404).json({ success: false, error: "Project not found" });
    }

    const commentsResult = await CommentsCollection.deleteMany({
      projectId: new ObjectId(projectId),
    });

    await ProjectsCollection.deleteOne({ _id: new ObjectId(projectId) });

    await recordChange({
      entityType: "Project",
      entityId: projectId,
      action: "delete",
      before: project,
      user: req.user,
      metadata: { commentsDeleted: commentsResult.deletedCount },
    });

    res.status(200).json({
      success: true,
      message: `Project and ${commentsResult.deletedCount} comments permanently deleted`,
      data: {
        projectDeleted: true,
        commentsDeleted: commentsResult.deletedCount,
      },
    });
  } catch (err) {
    console.error("Delete project error:", err);
    res.status(500).json({ success: false, error: "Failed to delete project" });
  }
});

/* UPLOAD FILE */
router.post(
  "/projects/:projectId/upload",
  authenticate,
  logRequest,
  upload.single("file"),
  async (req, res) => {
    try {
      const db = getDB();
      const ProjectsCollection = db.collection("Projects");
      const CommentsCollection = db.collection("Comments");
      const { projectId } = req.params;

      if (!ObjectId.isValid(projectId)) {
        return res.status(400).json({ success: false, error: "Invalid project ID" });
      }

      const project = await ProjectsCollection.findOne({
        _id: new ObjectId(projectId),
      });
      if (!project) {
        return res.status(404).json({ success: false, error: "Project not found" });
      }
      if (project.fileInfo) {
        return res.status(400).json({
          success: false,
          error:
            "A file has already been uploaded to this project. Duplicate uploads are not allowed.",
        });
      }
      if (
        req.user.role !== "Admin" &&
        project.assignedTo.toString() !== req.user.userId.toString()
      ) {
        return res.status(403).json({ success: false, error: "Access denied" });
      }
      if (!req.file) {
        return res.status(400).json({ success: false, error: "No file uploaded" });
      }

      const filePath = req.file.path;
      let parsedComments = [];

      try {
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
      } catch (parseError) {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        return res.status(400).json({
          success: false,
          error: `File parsing failed: ${parseError.message}`,
        });
      }

      const insertResult = await CommentsCollection.insertMany(parsedComments);

      const before = { ...project };
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
      const after = await ProjectsCollection.findOne({
        _id: new ObjectId(projectId),
      });

      await recordChange({
        entityType: "Project",
        entityId: projectId,
        action: "update",
        before,
        after,
        user: req.user,
        projectId,
        metadata: {
          uploadType: "file",
          commentsImported: parsedComments.length,
          originalName: req.file.originalname,
        },
      });

      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

      res.status(200).json({
        success: true,
        message: `File uploaded successfully. ${parsedComments.length} comments imported.`,
        data: {
          totalComments: parsedComments.length,
          commentIds: insertResult.insertedIds,
        },
      });
    } catch (err) {
      console.error("Upload error:", err);
      if (req.file && req.file.path && fs.existsSync(req.file.path)) {
        try { fs.unlinkSync(req.file.path); } catch (_) {}
      }
      res.status(500).json({ success: false, error: "Failed to upload file" });
    }
  }
);

/* ✅ DOWNLOAD CSV (fixed escaping + filters) */
router.get(
  "/projects/:projectId/download-csv",
  authenticate,
  logRequest,
  async (req, res) => {
    try {
      const db = getDB();
      const ProjectsCollection = db.collection("Projects");
      const CommentsCollection = db.collection("Comments");
      const { projectId } = req.params;

      if (!ObjectId.isValid(projectId)) {
        return res.status(400).json({ success: false, error: "Invalid project ID" });
      }
      const project = await ProjectsCollection.findOne({
        _id: new ObjectId(projectId),
      });
      if (!project) {
        return res.status(404).json({ success: false, error: "Project not found" });
      }
      if (
        req.user.role !== "Admin" &&
        project.assignedTo.toString() !== req.user.userId.toString()
      ) {
        return res.status(403).json({ success: false, error: "Access denied" });
      }

      const filter = { projectId: new ObjectId(projectId) };
      if (req.query.isValidated !== undefined) {
        filter.isValidated = req.query.isValidated === "true";
      }
      if (req.query.language) filter.language = req.query.language;
      if (req.query.sentiment) filter.sentiment = req.query.sentiment;

      const comments = await CommentsCollection.find(filter).toArray();
      if (comments.length === 0) {
        return res.status(404).json({
          success: false,
          error: "No comments found for this project (with current filters)",
        });
      }

      const headers = ["externalId", "text", "language", "sentiment"];
      const rows = comments.map((c) => [
        c.externalId || "",
        c.text || "",
        c.language || "",
        c.sentiment || "",
      ]);

      const csvContent = buildCSV(headers, rows);

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="project_${project.name.replace(/\s+/g, "_")}_comments.csv"`
      );
      // BOM for Excel UTF-8 detection
      res.status(200).send("\uFEFF" + csvContent);
    } catch (err) {
      console.error("Download CSV error:", err);
      res.status(500).json({ success: false, error: "Failed to download CSV" });
    }
  }
);

/* ✅ DOWNLOAD EXCEL (with filters) */
router.get(
  "/projects/:projectId/download-excel",
  authenticate,
  logRequest,
  async (req, res) => {
    try {
      const db = getDB();
      const ProjectsCollection = db.collection("Projects");
      const CommentsCollection = db.collection("Comments");
      const { projectId } = req.params;

      if (!ObjectId.isValid(projectId)) {
        return res.status(400).json({ success: false, error: "Invalid project ID" });
      }
      const project = await ProjectsCollection.findOne({
        _id: new ObjectId(projectId),
      });
      if (!project) {
        return res.status(404).json({ success: false, error: "Project not found" });
      }
      if (
        req.user.role !== "Admin" &&
        project.assignedTo.toString() !== req.user.userId.toString()
      ) {
        return res.status(403).json({ success: false, error: "Access denied" });
      }

      const filter = { projectId: new ObjectId(projectId) };
      if (req.query.isValidated !== undefined) {
        filter.isValidated = req.query.isValidated === "true";
      }
      if (req.query.language) filter.language = req.query.language;
      if (req.query.sentiment) filter.sentiment = req.query.sentiment;

      const comments = await CommentsCollection.find(filter).toArray();
      if (comments.length === 0) {
        return res.status(404).json({
          success: false,
          error: "No comments found for this project (with current filters)",
        });
      }

      const workbook = new ExcelJS.Workbook();
      workbook.creator = "Annotation Platform";
      workbook.created = new Date();
      const worksheet = workbook.addWorksheet("Comments");

      worksheet.columns = [
        { header: "External ID", key: "externalId", width: 20 },
        { header: "Text", key: "text", width: 60 },
        { header: "Language", key: "language", width: 15 },
        { header: "Sentiment", key: "sentiment", width: 15 },
      ];

      worksheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };
      worksheet.getRow(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FF4472C4" },
      };
      worksheet.getRow(1).alignment = { vertical: "middle", horizontal: "center" };

      comments.forEach((c) => {
        worksheet.addRow({
          externalId: c.externalId || "",
          text: c.text || "",
          language: c.language || "",
          sentiment: c.sentiment || "",
        });
      });

      worksheet.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: worksheet.columns.length },
      };
      worksheet.views = [{ state: "frozen", ySplit: 1 }];

      const safeName = project.name.replace(/[^a-z0-9]/gi, "_");
      const filename = `project_${safeName}_comments.xlsx`;

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );
      res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
      await workbook.xlsx.write(res);
      res.end();
    } catch (err) {
      console.error("Download Excel error:", err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, error: "Failed to download Excel" });
      }
    }
  }
);

module.exports = router;