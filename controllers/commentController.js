const ExcelJS = require("exceljs");
const commentService = require("../services/commentService");
const Comment = require("../models/Comment");
const { buildFilter } = commentService;

async function list(req, res, next) {
  try {
    const result = await commentService.listComments(req.query, req.user);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const result = await commentService.createComment(req.body, req.user);
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function bulkAnnotate(req, res, next) {
  try {
    const result = await commentService.bulkAnnotate(req.body, req.user);
    res.json({ success: true, message: "Bulk annotation applied", ...result });
  } catch (err) {
    next(err);
  }
}

async function bulkAssign(req, res, next) {
  try {
    const result = await commentService.bulkAssign(req.body, req.user);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function exportComments(req, res, next) {
  try {
    const format = (req.query.format || "csv").toLowerCase();
    if (!["csv", "xlsx"].includes(format)) {
      return res
        .status(400)
        .json({ success: false, error: "format must be csv or xlsx" });
    }

    const filter = buildFilter(req.query);

    if (req.user.role !== "admin") {
      const db = require("../config/db").getDB();
      const datasets = await db
        .collection("datasets")
        .find(
          { assignedTo: new (require("mongodb").ObjectId)(req.user.userId) },
          { projection: { _id: 1 } },
        )
        .toArray();
      const allowedIds = datasets.map((d) => d._id);

      if (filter.datasetId) {
        if (!allowedIds.some((id) => id.equals(filter.datasetId))) {
          return res
            .status(403)
            .json({ success: false, error: "Not assigned to you" });
        }
      } else {
        filter.datasetId = { $in: allowedIds };
      }
    }

    const comments = await Comment.findForExport(filter);

    const header = [
      "id",
      "comment_text",
      "sentiment",
      "type",
      "status",
      "version",
      "annotatedAt",
    ];
    const rows = comments.map((c) => [
      c.sourceId,
      c.commentText,
      c.sentiment,
      c.type,
      c.status,
      c.version,
      c.annotatedAt ? new Date(c.annotatedAt).toISOString() : "",
    ]);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="comments-${timestamp}.csv"`,
      );
      const escapeCsv = (v) => {
        let s = v === null || v === undefined ? "" : String(v);
        if (/^[=+\-@]/.test(s)) s = "'" + s;
        if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
        return s;
      };
      const lines = [
        header.join(","),
        ...rows.map((r) => r.map(escapeCsv).join(",")),
      ];
      return res.send("\uFEFF" + lines.join("\r\n"));
    }

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("comments");
    sheet.addRow(header);
    rows.forEach((r) => sheet.addRow(r));
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="comments-${timestamp}.xlsx"`,
    );
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const comment = await commentService.getComment(req.params.id, req.user);
    res.json({ success: true, comment });
  } catch (err) {
    next(err);
  }
}

async function updateText(req, res, next) {
  try {
    const result = await commentService.updateCommentText(
      req.params.id,
      req.body.commentText,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function annotate(req, res, next) {
  try {
    const result = await commentService.annotateComment(
      req.params.id,
      req.body,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function getVersions(req, res, next) {
  try {
    const result = await commentService.getCommentVersions(
      req.params.id,
      req.query,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function restoreVersion(req, res, next) {
  try {
    const targetVersion = parseInt(req.params.version, 10);
    if (!targetVersion || targetVersion < 1) {
      return res.status(400).json({ success: false, error: "Invalid version" });
    }
    const result = await commentService.restoreCommentVersion(
      req.params.id,
      targetVersion,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const result = await commentService.deleteComment(req.params.id, req.user);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  list,
  create,
  bulkAnnotate,
  bulkAssign,
  exportComments,
  getOne,
  updateText,
  annotate,
  getVersions,
  restoreVersion,
  remove,
};
