const crypto = require("crypto");
const { parse } = require("csv-parse/sync");
const ExcelJS = require("exceljs");
const { getDB } = require("../config/db");
const Dataset = require("../models/Dataset");
const Comment = require("../models/Comment");
const CommentVersion = require("../models/CommentVersion");

function cellToString(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value instanceof Date) return value.toISOString();

  if (typeof value === "object") {
    if (Array.isArray(value.richText)) {
      return value.richText.map((rt) => rt.text || "").join("");
    }
    if (value.result !== undefined) return cellToString(value.result);
    if (value.text) return String(value.text);
  }
  return String(value);
}

async function parseXlsx(fileBuffer) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(fileBuffer);

  const worksheet =
    workbook.worksheets.find((w) => w.name.toLowerCase() === "cmt") ||
    workbook.worksheets[0];

  if (!worksheet) return { sheetName: null, rows: [] };

  const headerRow = worksheet.getRow(1);
  const headers = {};
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const header = cellToString(cell.value).trim();
    if (header) headers[colNumber] = header;
  });

  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const obj = {};
    Object.keys(headers).forEach((colNumber) => {
      const header = headers[colNumber];
      const cell = row.getCell(Number(colNumber));
      obj[header] = cellToString(cell.value);
    });
    rows.push(obj);
  });

  return { sheetName: worksheet.name, rows };
}

function parseCsv(fileBuffer) {
  const rows = parse(fileBuffer, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    bom: true,
  });
  return { sheetName: null, rows };
}

async function parseFile(fileBuffer, originalName) {
  const isCsv = originalName.toLowerCase().endsWith(".csv");
  return isCsv ? parseCsv(fileBuffer) : parseXlsx(fileBuffer);
}

function normalizeRow(row) {
  const out = {};
  for (const key of Object.keys(row)) {
    const k = key.toLowerCase().replace(/[\s_]/g, "");
    if (k === "id") out.id = row[key];
    else if (k === "commenttext" || k === "comment" || k === "text")
      out.comment_text = row[key];
    else if (k === "sentiment") out.sentiment = row[key];
    else if (k === "type") out.type = row[key];
  }
  return out;
}

async function previewFile(fileBuffer, originalName) {
  const { rows } = await parseFile(fileBuffer, originalName);

  if (!rows.length) {
    const err = new Error("File is empty");
    err.status = 400;
    throw err;
  }

  const sample = [];
  const seenSourceIds = new Map();
  const duplicateIds = [];
  let valid = 0;
  let missingIdOrText = 0;
  let duplicates = 0;
  const previewErrors = [];

  rows.forEach((raw, idx) => {
    const row = normalizeRow(raw);
    const sourceId =
      row.id !== undefined && row.id !== null ? String(row.id).trim() : "";
    const text =
      typeof row.comment_text === "string" ? row.comment_text.trim() : "";

    if (!sourceId || !text) {
      missingIdOrText++;
      return;
    }

    if (seenSourceIds.has(sourceId)) {
      duplicates++;
      duplicateIds.push(sourceId);
      if (previewErrors.length < 10) {
        previewErrors.push(
          `Row ${idx + 2}: duplicate id "${sourceId}" (first at row ${seenSourceIds.get(sourceId) + 2})`,
        );
      }
      return;
    }
    seenSourceIds.set(sourceId, idx);
    valid++;

    if (sample.length < 10) {
      sample.push({
        sourceId,
        commentText: text.length > 200 ? text.slice(0, 200) + "…" : text,
        sentiment: row.sentiment || null,
        type: row.type || null,
      });
    }
  });

  const checksum = crypto.createHash("sha256").update(fileBuffer).digest("hex");
  const uniqueDuplicateIds = [...new Set(duplicateIds)];

  return {
    totalRows: rows.length,
    validRows: valid,
    missingIdOrText,
    duplicates,
    uniqueDuplicateCount: uniqueDuplicateIds.length,
    duplicateIds: uniqueDuplicateIds.slice(0, 20),
    fileName: originalName,
    suggestedName: originalName.replace(/\.(csv|xlsx)$/i, ""),
    checksum,
    sample,
    errors: previewErrors,
  };
}

async function createDatasetRecord({
  name,
  originalFileName,
  fileType,
  checksum,
  dedupeStrategy,
  taxonomyId,
  taxonomyName,
  uploadedBy,
}) {
  const now = new Date();
  const datasetId = await Dataset.create({
    name,
    originalFileName,
    fileType,
    sheetName: null,
    checksum,
    totalRows: 0,
    importedRows: 0,
    skippedRows: 0,
    renamedRows: 0,
    dedupeStrategy,
    status: "pending",
    importError: null,
    importErrors: [],
    progress: { phase: "queued", startedAt: now, updatedAt: now },
    taxonomyId,
    taxonomyName,
    taxonomyAssignedAt: taxonomyId ? now : null,
    uploadedBy,
    assignedTo: null,
    assignedAt: null,
  });
  return datasetId;
}

async function processImportInBackground({
  datasetId,
  fileBuffer,
  originalName,
  uploadedBy,
  dedupeStrategy = "skip",
}) {
  const db = getDB();
  const startedAt = new Date();
  const CHUNK_SIZE = 1000;

  const setProgress = async (patch) => {
    await Dataset.updateProgress(datasetId, patch);
  };

  const bumpProcessed = async (processed) => {
    await db.collection("datasets").updateOne(
      { _id: datasetId },
      {
        $set: {
          "progress.processed": processed,
          "progress.updatedAt": new Date(),
          updatedAt: new Date(),
        },
      },
    );
  };

  try {
    await setProgress({ phase: "parsing", startedAt });

    const { sheetName, rows } = await parseFile(fileBuffer, originalName);
    if (!rows.length) throw new Error("File is empty");

    const now = new Date();
    const commentsToInsert = [];
    let skipped = 0;
    let renamed = 0;
    const errors = [];
    const usedSourceIds = new Set();
    const rawSourceIds = new Set();

    rows.forEach((raw) => {
      const r = normalizeRow(raw);
      const sid =
        r.id !== undefined && r.id !== null ? String(r.id).trim() : "";
      if (sid) rawSourceIds.add(sid);
    });

    function makeUniqueSourceId(baseId) {
      let n = 1;
      let candidate;
      do {
        candidate = `${baseId}-dup${n}`;
        n++;
        if (n > 10000) {
          candidate = `${baseId}-dup${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
          break;
        }
      } while (rawSourceIds.has(candidate) || usedSourceIds.has(candidate));
      return candidate;
    }

    rows.forEach((raw, idx) => {
      const row = normalizeRow(raw);
      let sourceId =
        row.id !== undefined && row.id !== null ? String(row.id).trim() : "";
      const text =
        typeof row.comment_text === "string" ? row.comment_text.trim() : "";

      if (!sourceId || !text) {
        skipped++;
        return;
      }

      if (usedSourceIds.has(sourceId)) {
        if (dedupeStrategy === "rename") {
          const newId = makeUniqueSourceId(sourceId);
          errors.push(
            `Row ${idx + 2}: duplicate id "${sourceId}" renamed to "${newId}"`,
          );
          sourceId = newId;
          renamed++;
        } else {
          skipped++;
          errors.push(`Row ${idx + 2}: duplicate id "${sourceId}" skipped`);
          return;
        }
      }
      usedSourceIds.add(sourceId);

      const rawSentiment = (row.sentiment || "").toLowerCase().trim();
      const rawType = (row.type || "").toLowerCase().trim();
      const sentiment = ["positive", "negative", "neutral"].includes(
        rawSentiment,
      )
        ? rawSentiment
        : "unannotated";
      const type = ["bangla", "english", "banglish"].includes(rawType)
        ? rawType
        : "unclassified";
      const status =
        sentiment === "unannotated" || type === "unclassified"
          ? "pending"
          : "annotated";

      commentsToInsert.push({
        datasetId,
        sourceId,
        commentText: text,
        sentiment,
        type,
        status,
        assignedTo: null,
        assignedAt: null,
        assignedBy: null,
        annotatedBy: status === "annotated" ? uploadedBy : null,
        annotatedAt: status === "annotated" ? now : null,
        annotationNote: null,
        version: 1,
        createdBy: uploadedBy,
        updatedBy: uploadedBy,
        createdAt: now,
        updatedAt: now,
      });
    });

    if (commentsToInsert.length === 0) {
      await db.collection("datasets").updateOne(
        { _id: datasetId },
        {
          $set: {
            status: "failed",
            skippedRows: skipped,
            importError: "No valid rows found",
            importErrors: errors.slice(0, 20),
            progress: { phase: "failed", updatedAt: new Date() },
            updatedAt: new Date(),
          },
        },
      );
      return;
    }

    const totalToInsert = commentsToInsert.length;
    await setProgress({
      phase: "inserting",
      processed: 0,
      total: totalToInsert,
      startedAt: new Date(),
    });

    const insertedPairs = [];

    for (let i = 0; i < commentsToInsert.length; i += CHUNK_SIZE) {
      const chunk = commentsToInsert.slice(i, i + CHUNK_SIZE);
      let chunkResult;

      try {
        chunkResult = await Comment.insertMany(chunk, { ordered: false });
      } catch (err) {
        chunkResult = err.result || { insertedIds: {} };
        if (err.writeErrors) {
          err.writeErrors.slice(0, 5).forEach((we) => {
            errors.push(
              `Insert: ${we.err?.errmsg || we.errmsg || "duplicate"}`,
            );
          });
        }
      }

      const idsMap = chunkResult.insertedIds || {};
      for (const [localIdx, commentId] of Object.entries(idsMap)) {
        insertedPairs.push({ commentId, originalIndex: i + Number(localIdx) });
      }

      await bumpProcessed(Math.min(i + CHUNK_SIZE, totalToInsert));
    }

    const versionsToInsert = insertedPairs.map(
      ({ commentId, originalIndex }) => {
        const c = commentsToInsert[originalIndex];
        return {
          commentId,
          version: 1,
          snapshot: {
            commentText: c.commentText,
            sentiment: c.sentiment,
            type: c.type,
            status: c.status,
            assignedTo: c.assignedTo,
            annotatedBy: c.annotatedBy,
            annotatedAt: c.annotatedAt,
            annotationNote: c.annotationNote,
          },
          changedFields: ["commentText", "sentiment", "type", "status"],
          changeType: "import",
          changedBy: uploadedBy,
          createdAt: now,
        };
      },
    );

    const totalVersions = versionsToInsert.length;
    await setProgress({
      phase: "versions",
      processed: 0,
      total: totalVersions,
      startedAt: new Date(),
    });

    for (let i = 0; i < versionsToInsert.length; i += CHUNK_SIZE) {
      const chunk = versionsToInsert.slice(i, i + CHUNK_SIZE);
      await CommentVersion.insertMany(chunk);
      await bumpProcessed(Math.min(i + CHUNK_SIZE, totalVersions));
    }

    await setProgress({
      phase: "finalizing",
      processed: totalToInsert,
      total: totalToInsert,
      startedAt: new Date(),
    });

    const actuallyInserted = insertedPairs.length;
    const failedInserts = commentsToInsert.length - actuallyInserted;

    await db.collection("datasets").updateOne(
      { _id: datasetId },
      {
        $set: {
          sheetName,
          totalRows: rows.length,
          importedRows: actuallyInserted,
          skippedRows: skipped + failedInserts,
          renamedRows: renamed,
          status: "completed",
          importErrors: errors.slice(0, 20),
          progress: {
            phase: "completed",
            processed: totalToInsert,
            total: totalToInsert,
            startedAt,
            updatedAt: new Date(),
          },
          updatedAt: new Date(),
        },
      },
    );

    console.log(
      `dataset ${datasetId} completed in ${Date.now() - startedAt.getTime()}ms ` +
        `(imported=${actuallyInserted}, skipped=${skipped}, renamed=${renamed})`,
    );
  } catch (err) {
    console.error(`dataset ${datasetId} failed:`, err.message);
    await db.collection("datasets").updateOne(
      { _id: datasetId },
      {
        $set: {
          status: "failed",
          importError: err.message,
          progress: { phase: "failed", updatedAt: new Date() },
          updatedAt: new Date(),
        },
      },
    );
  }
}

module.exports = {
  parseFile,
  normalizeRow,
  previewFile,
  createDatasetRecord,
  processImportInBackground,
};
