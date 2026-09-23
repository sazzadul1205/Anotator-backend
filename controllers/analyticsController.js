const ExcelJS = require("exceljs");
const { ObjectId } = require("mongodb");
const analyticsService = require("../services/analyticsService");
const Dataset = require("../models/Dataset");
const Comment = require("../models/Comment");

async function datasetAnalytics(req, res, next) {
  try {
    const result = await analyticsService.getDatasetAnalytics(
      req.params.id,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function globalAnalytics(req, res, next) {
  try {
    const result = await analyticsService.getGlobalAnalytics();
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function exportML(req, res, next) {
  try {
    const datasetId = (() => {
      try {
        return new ObjectId(req.params.id);
      } catch {
        return null;
      }
    })();
    if (!datasetId) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid datasetId" });
    }

    const dataset = await Dataset.findById(datasetId);
    if (!dataset) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset not found" });
    }
    if (
      req.user.role !== "admin" &&
      (!dataset.assignedTo || dataset.assignedTo.toString() !== req.user.userId)
    ) {
      return res
        .status(403)
        .json({ success: false, error: "Not assigned to you" });
    }

    const format = (req.query.format || "jsonl").toLowerCase();
    if (!["jsonl", "csv", "xlsx"].includes(format)) {
      return res
        .status(400)
        .json({ success: false, error: "format must be jsonl, csv or xlsx" });
    }

    const splitParam = String(req.query.split || "0.8,0.1,0.1").split(",");
    const [trainP, valP, testP] = splitParam.map((n) => Number(n));
    if (
      !Number.isFinite(trainP) ||
      !Number.isFinite(valP) ||
      !Number.isFinite(testP) ||
      Math.abs(trainP + valP + testP - 1) > 1e-6
    ) {
      return res.status(400).json({
        success: false,
        error: "split must be three numbers summing to 1 (e.g. 0.8,0.1,0.1)",
      });
    }

    const comments = await Comment.findForExport({
      datasetId,
      status: "annotated",
    });

    if (comments.length === 0) {
      return res
        .status(400)
        .json({ success: false, error: "No annotated comments to export" });
    }

    const shuffled = comments.slice().sort((a, b) => {
      const sa = String(a._id);
      const sb = String(b._id);
      return sa < sb ? -1 : sa > sb ? 1 : 0;
    });

    const n = shuffled.length;
    const nTrain = Math.floor(n * trainP);
    const nVal = Math.floor(n * valP);

    const train = shuffled.slice(0, nTrain);
    const val = shuffled.slice(nTrain, nTrain + nVal);
    const trainSet = new Set(train);
    const valSet = new Set(val);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const baseName = dataset.name.replace(/[^\w-]+/g, "_").slice(0, 40);

    if (format === "jsonl") {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${baseName}-ml-${timestamp}.jsonl"`,
      );
      const lines = shuffled.map((c) =>
        JSON.stringify({
          id: c.sourceId,
          text: c.commentText,
          sentiment: c.sentiment,
          type: c.type,
          split: trainSet.has(c) ? "train" : valSet.has(c) ? "val" : "test",
          dataset: dataset.name,
          taxonomy: dataset.taxonomyName || "Default",
        }),
      );
      return res.send(lines.join("\n") + "\n");
    }

    const header = [
      "id",
      "text",
      "sentiment",
      "type",
      "split",
      "dataset",
      "taxonomy",
    ];
    const rows = shuffled.map((c) => [
      c.sourceId,
      c.commentText,
      c.sentiment,
      c.type,
      trainSet.has(c) ? "train" : valSet.has(c) ? "val" : "test",
      dataset.name,
      dataset.taxonomyName || "Default",
    ]);

    if (format === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${baseName}-ml-${timestamp}.csv"`,
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
    const sheet = workbook.addWorksheet("ml-data");
    sheet.addRow(header);
    rows.forEach((r) => sheet.addRow(r));
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${baseName}-ml-${timestamp}.xlsx"`,
    );
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
}

module.exports = { datasetAnalytics, globalAnalytics, exportML };
