// services/commentService.js
// Business logic for comments: list, create, annotate, bulk ops,
// version history, restore, delete.
//
// Storage-agnostic. All DB access via models.

const {
  Comment,
  CommentVersion,
  Dataset,
  Taxonomy,
  User,
} = require("../models");
const { audit } = require("../utils/audit");
const { exports: exportQueue } = require("../config/concurrency");

const DEFAULT_SENTIMENTS = ["positive", "negative", "neutral", "unannotated"];
const DEFAULT_TYPES = ["bangla", "english", "banglish", "unclassified"];

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

function buildDomainFilter(query) {
  const filter = {};
  if (query.datasetId) filter.datasetId = query.datasetId;
  if (query.sentiment) filter.sentiment = query.sentiment;
  if (query.type) filter.type = query.type;
  if (query.assignedTo) filter.assignedTo = query.assignedTo;

  if (query.status) {
    filter.status = query.status;
  } else if (query.hideAnnotated === "true") {
    filter.excludeAnnotated = true;
  }

  if (query.search && typeof query.search === "string") {
    const trimmed = query.search.trim().slice(0, 100);
    if (trimmed) filter.search = trimmed;
  }

  return filter;
}

async function getValidOptionsForDataset(dataset) {
  let sentiment = new Set(DEFAULT_SENTIMENTS);
  let type = new Set(DEFAULT_TYPES);

  if (dataset && dataset.taxonomyId) {
    const taxonomy = await Taxonomy.findById(dataset.taxonomyId);
    if (taxonomy) {
      if (Array.isArray(taxonomy.sentiment) && taxonomy.sentiment.length) {
        sentiment = new Set(taxonomy.sentiment.map((x) => x.value));
      }
      if (Array.isArray(taxonomy.type) && taxonomy.type.length) {
        type = new Set(taxonomy.type.map((x) => x.value));
      }
    }
  }

  sentiment.add("unannotated");
  type.add("unclassified");

  return { sentiment, type };
}

async function getAllowedDatasetIds(user) {
  if (user.role === "admin") return null;
  return Dataset.findAssignedToIds(user.userId);
}

async function assertCanAccessComment(comment, user) {
  if (user.role === "admin") return;
  const dataset = await Dataset.findById(comment.datasetId);
  if (!dataset || dataset.assignedTo !== user.userId) {
    const err = new Error("Not assigned to you");
    err.status = 403;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function listComments(query, user) {
  const page = parseInt(query.page, 10) || 1;
  const limit = Math.min(parseInt(query.limit, 10) || 50, 200);

  const filter = buildDomainFilter(query);

  const allowedIds = await getAllowedDatasetIds(user);
  if (allowedIds !== null) {
    if (filter.datasetId) {
      if (!allowedIds.includes(filter.datasetId)) {
        const err = new Error("Not assigned to you");
        err.status = 403;
        throw err;
      }
    } else {
      filter.datasetIds = allowedIds;
    }
  }

  const { comments, total } = await Comment.findMany(filter, {
    page,
    limit,
    sortBy: "createdAt",
    sortDir: "desc",
  });

  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    comments,
  };
}

async function createComment(
  { datasetId, sourceId, commentText, sentiment, type },
  user,
) {
  if (!datasetId || !sourceId || !commentText) {
    const err = new Error("datasetId, sourceId and commentText are required");
    err.status = 400;
    throw err;
  }

  const dataset = await Dataset.findById(datasetId);
  if (!dataset) {
    const err = new Error("Dataset not found");
    err.status = 404;
    throw err;
  }

  if (user.role !== "admin" && dataset.assignedTo !== user.userId) {
    const err = new Error("Not assigned to you");
    err.status = 403;
    throw err;
  }

  const trimmedSourceId = String(sourceId).trim();
  const trimmedText = String(commentText).trim();

  const duplicate = await Comment.findOne({
    datasetId,
    sourceId: trimmedSourceId,
  });
  if (duplicate) {
    const err = new Error("sourceId already exists in this dataset");
    err.status = 409;
    throw err;
  }

  const validOpts = await getValidOptionsForDataset(dataset);
  const validSentiment = validOpts.sentiment.has(sentiment)
    ? sentiment
    : "unannotated";
  const validType = validOpts.type.has(type) ? type : "unclassified";
  const status =
    validSentiment === "unannotated" || validType === "unclassified"
      ? "pending"
      : "annotated";

  const now = new Date();
  const userId = user.userId;

  let created;
  try {
    created = await Comment.create({
      datasetId,
      sourceId: trimmedSourceId,
      commentText: trimmedText,
      sentiment: validSentiment,
      type: validType,
      status,
      assignedTo: null,
      assignedAt: null,
      assignedBy: null,
      annotatedBy: status === "annotated" ? userId : null,
      annotatedAt: status === "annotated" ? now : null,
      annotationNote: null,
      version: 1,
      createdBy: userId,
      updatedBy: userId,
      createdAt: now,
      updatedAt: now,
    });
  } catch (err) {
    if (err.name === "DuplicateKeyError") {
      const e = new Error("sourceId already exists in this dataset");
      e.status = 409;
      throw e;
    }
    throw err;
  }

  await CommentVersion.create({
    commentId: created.id,
    version: 1,
    snapshot: {
      commentText: trimmedText,
      sentiment: validSentiment,
      type: validType,
      status,
      assignedTo: null,
      annotatedBy: status === "annotated" ? userId : null,
      annotatedAt: status === "annotated" ? now : null,
      annotationNote: null,
    },
    changedFields: ["commentText", "sentiment", "type", "status"],
    changeType: "create",
    changedBy: userId,
    createdAt: now,
  });

  return { commentId: created.id, message: "Comment created" };
}

async function getComment(id, user) {
  const comment = await Comment.findById(id);
  if (!comment) {
    const err = new Error("Comment not found");
    err.status = 404;
    throw err;
  }
  await assertCanAccessComment(comment, user);
  return comment;
}

async function updateCommentText(id, commentText, user) {
  if (!commentText || typeof commentText !== "string") {
    const err = new Error("commentText is required");
    err.status = 400;
    throw err;
  }

  const existing = await Comment.findById(id);
  if (!existing) {
    const err = new Error("Comment not found");
    err.status = 404;
    throw err;
  }
  await assertCanAccessComment(existing, user);

  const userId = user.userId;
  const newVersion = existing.version + 1;
  const now = new Date();
  const newText = commentText.trim();

  await Comment.updateById(id, {
    commentText: newText,
    version: newVersion,
    updatedBy: userId,
  });

  await CommentVersion.create({
    commentId: id,
    version: newVersion,
    snapshot: {
      commentText: newText,
      sentiment: existing.sentiment,
      type: existing.type,
      status: existing.status,
      assignedTo: existing.assignedTo,
      annotatedBy: existing.annotatedBy,
      annotatedAt: existing.annotatedAt,
      annotationNote: existing.annotationNote,
    },
    changedFields: ["commentText"],
    changeType: "update",
    changedBy: userId,
    createdAt: now,
  });

  return { version: newVersion, message: "Comment updated" };
}

async function annotateComment(id, { sentiment, type, annotationNote }, user) {
  const existing = await Comment.findById(id);
  if (!existing) {
    const err = new Error("Comment not found");
    err.status = 404;
    throw err;
  }
  await assertCanAccessComment(existing, user);

  const dataset = await Dataset.findById(existing.datasetId);
  const validOpts = await getValidOptionsForDataset(dataset);

  const changed = [];

  let newSentiment = existing.sentiment;
  if (sentiment !== undefined) {
    if (!validOpts.sentiment.has(sentiment)) {
      const err = new Error(
        `Invalid sentiment value. Allowed: ${[...validOpts.sentiment].join(", ")}`,
      );
      err.status = 400;
      throw err;
    }
    if (sentiment !== existing.sentiment) {
      newSentiment = sentiment;
      changed.push("sentiment");
    }
  }

  let newType = existing.type;
  if (type !== undefined) {
    if (!validOpts.type.has(type)) {
      const err = new Error(
        `Invalid type value. Allowed: ${[...validOpts.type].join(", ")}`,
      );
      err.status = 400;
      throw err;
    }
    if (type !== existing.type) {
      newType = type;
      changed.push("type");
    }
  }

  let newNote = existing.annotationNote;
  if (
    annotationNote !== undefined &&
    annotationNote !== existing.annotationNote
  ) {
    newNote = annotationNote;
    changed.push("annotationNote");
  }

  if (changed.length === 0) {
    const err = new Error("Nothing to update");
    err.status = 400;
    throw err;
  }

  const userId = user.userId;
  const now = new Date();

  const fullyAnnotated =
    newSentiment !== "unannotated" && newType !== "unclassified";
  const newStatus = fullyAnnotated ? "annotated" : "pending";
  if (newStatus !== existing.status) changed.push("status");

  const newVersion = existing.version + 1;

  await Comment.updateById(id, {
    sentiment: newSentiment,
    type: newType,
    annotationNote: newNote,
    status: newStatus,
    annotatedBy: userId,
    annotatedAt: now,
    version: newVersion,
    updatedBy: userId,
  });

  await CommentVersion.create({
    commentId: id,
    version: newVersion,
    snapshot: {
      commentText: existing.commentText,
      sentiment: newSentiment,
      type: newType,
      status: newStatus,
      assignedTo: existing.assignedTo,
      annotatedBy: userId,
      annotatedAt: now,
      annotationNote: newNote,
    },
    changedFields: changed,
    changeType: "annotation",
    changedBy: userId,
    createdAt: now,
  });

  return { version: newVersion, message: "Annotation saved" };
}

async function bulkAnnotate({ ids, sentiment, type, annotationNote }, user) {
  if (!Array.isArray(ids) || ids.length === 0) {
    const err = new Error("ids must be a non-empty array");
    err.status = 400;
    throw err;
  }
  if (ids.length > 200) {
    const err = new Error("Max 200 comments per bulk op");
    err.status = 400;
    throw err;
  }
  if (sentiment === undefined && type === undefined && !annotationNote) {
    const err = new Error("Nothing to update");
    err.status = 400;
    throw err;
  }

  const comments = await Comment.findManyByIds(ids);
  if (comments.length !== ids.length) {
    const err = new Error("One or more comments not found");
    err.status = 404;
    throw err;
  }

  if (user.role !== "admin") {
    const assignedIds = await Dataset.findAssignedToIds(user.userId);
    const assignedSet = new Set(assignedIds);
    for (const c of comments) {
      if (!assignedSet.has(c.datasetId)) {
        const err = new Error("One or more comments are not assigned to you");
        err.status = 403;
        throw err;
      }
    }
  }

  if (sentiment !== undefined || type !== undefined) {
    const datasetIds = [...new Set(comments.map((c) => c.datasetId))];
    const datasets = await Promise.all(
      datasetIds.map((id) => Dataset.findById(id)),
    );
    const map = new Map(datasets.filter(Boolean).map((d) => [d.id, d]));

    for (const c of comments) {
      const ds = map.get(c.datasetId);
      const opts = await getValidOptionsForDataset(ds);

      if (sentiment !== undefined && !opts.sentiment.has(sentiment)) {
        const err = new Error(
          `Invalid sentiment "${sentiment}" for dataset "${ds?.name || c.datasetId}"`,
        );
        err.status = 400;
        throw err;
      }
      if (type !== undefined && !opts.type.has(type)) {
        const err = new Error(
          `Invalid type "${type}" for dataset "${ds?.name || c.datasetId}"`,
        );
        err.status = 400;
        throw err;
      }
    }
  }

  const userId = user.userId;
  const now = new Date();
  const versionsToInsert = [];
  const patches = [];

  for (const existing of comments) {
    const changed = [];
    const newSentiment =
      sentiment !== undefined ? sentiment : existing.sentiment;
    const newType = type !== undefined ? type : existing.type;
    const newNote =
      annotationNote !== undefined ? annotationNote : existing.annotationNote;

    if (newSentiment !== existing.sentiment) changed.push("sentiment");
    if (newType !== existing.type) changed.push("type");
    if (newNote !== existing.annotationNote) changed.push("annotationNote");
    if (changed.length === 0) continue;

    const fullyAnnotated =
      newSentiment !== "unannotated" && newType !== "unclassified";
    const newStatus = fullyAnnotated ? "annotated" : "pending";
    if (newStatus !== existing.status) changed.push("status");

    const newVersion = existing.version + 1;

    patches.push({
      id: existing.id,
      patch: {
        sentiment: newSentiment,
        type: newType,
        annotationNote: newNote,
        status: newStatus,
        annotatedBy: userId,
        annotatedAt: now,
        version: newVersion,
        updatedBy: userId,
      },
    });

    versionsToInsert.push({
      commentId: existing.id,
      version: newVersion,
      snapshot: {
        commentText: existing.commentText,
        sentiment: newSentiment,
        type: newType,
        status: newStatus,
        assignedTo: existing.assignedTo,
        annotatedBy: userId,
        annotatedAt: now,
        annotationNote: newNote,
      },
      changedFields: changed,
      changeType: "bulk_annotation",
      changedBy: userId,
      createdAt: now,
    });
  }

  const updated = patches.length;

  if (patches.length > 0) {
    await Comment.bulkUpdate(patches);
    await CommentVersion.insertMany(versionsToInsert);

    await audit({
      action: "comment.bulk_annotate",
      actor: user,
      metadata: { requested: ids.length, updated, sentiment, type },
    });
  }

  return {
    requested: ids.length,
    updated,
    skipped: ids.length - updated,
  };
}

async function bulkAssign({ ids, assignedTo }, user) {
  if (!Array.isArray(ids) || ids.length === 0) {
    const err = new Error("ids must be a non-empty array");
    err.status = 400;
    throw err;
  }
  if (ids.length > 500) {
    const err = new Error("Max 500 comments per bulk op");
    err.status = 400;
    throw err;
  }

  let newAssignee = null;
  if (assignedTo !== null && assignedTo !== undefined && assignedTo !== "") {
    const assignee = await User.findById(assignedTo);
    if (!assignee || !assignee.isActive) {
      const err = new Error("Assignee not found or inactive");
      err.status = 404;
      throw err;
    }
    newAssignee = assignee.id;
  }

  const now = new Date();
  const result = await Comment.updateMany(
    { ids },
    {
      assignedTo: newAssignee,
      assignedAt: newAssignee ? now : null,
      assignedBy: user.userId,
    },
  );

  await audit({
    action: newAssignee ? "comment.bulk_assign" : "comment.bulk_unassign",
    actor: user,
    metadata: {
      count: result.modifiedCount,
      assignedTo: newAssignee || null,
    },
  });

  return {
    updated: result.modifiedCount,
    message: newAssignee ? "Comments assigned" : "Comments unassigned",
  };
}

async function getCommentVersions(id, query, user) {
  const page = parseInt(query.page, 10) || 1;
  const limit = Math.min(parseInt(query.limit, 10) || 20, 100);
  const skip = (page - 1) * limit;

  const comment = await Comment.findById(id);
  if (!comment) {
    const err = new Error("Comment not found");
    err.status = 404;
    throw err;
  }
  await assertCanAccessComment(comment, user);

  const [total, versions] = await Promise.all([
    CommentVersion.countByCommentId(id),
    CommentVersion.findByCommentId(id, { skip, limit }),
  ]);

  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
    versions,
  };
}

async function restoreCommentVersion(id, targetVersion, user) {
  const existing = await Comment.findById(id);
  if (!existing) {
    const err = new Error("Comment not found");
    err.status = 404;
    throw err;
  }
  await assertCanAccessComment(existing, user);

  const versionRecord = await CommentVersion.findOne({
    commentId: id,
    version: targetVersion,
  });
  if (!versionRecord) {
    const err = new Error("Version not found");
    err.status = 404;
    throw err;
  }

  const snap = versionRecord.snapshot;
  const userId = user.userId;
  const newVersion = existing.version + 1;
  const now = new Date();

  await Comment.updateById(id, {
    commentText: snap.commentText,
    sentiment: snap.sentiment,
    type: snap.type,
    status: snap.status,
    annotationNote: snap.annotationNote,
    version: newVersion,
    updatedBy: userId,
  });

  await CommentVersion.create({
    commentId: id,
    version: newVersion,
    snapshot: {
      commentText: snap.commentText,
      sentiment: snap.sentiment,
      type: snap.type,
      status: snap.status,
      assignedTo: snap.assignedTo,
      annotatedBy: snap.annotatedBy,
      annotatedAt: snap.annotatedAt,
      annotationNote: snap.annotationNote,
    },
    changedFields: ["restore"],
    changeType: "restore",
    restoredFrom: targetVersion,
    changedBy: userId,
    createdAt: now,
  });

  return {
    newVersion,
    restoredFrom: targetVersion,
    message: `Restored from v${targetVersion}`,
  };
}

async function deleteComment(id, actor) {
  const comment = await Comment.findById(id);
  if (!comment) {
    const err = new Error("Comment not found");
    err.status = 404;
    throw err;
  }

  await CommentVersion.deleteByCommentId(id);
  await Comment.deleteById(id);

  await audit({
    action: "comment.delete",
    actor,
    targetType: "comment",
    targetId: id,
    metadata: { datasetId: comment.datasetId },
  });

  return { message: "Comment deleted" };
}

/**
 * Inner export worker. Do NOT call directly — use `exportComments` so
 * the job is enqueued and concurrency is bounded.
 */
async function _exportComments({ query, user, format }) {
  if (!["csv", "xlsx"].includes(format)) {
    const err = new Error("format must be csv or xlsx");
    err.status = 400;
    throw err;
  }

  const filter = buildDomainFilter(query);

  if (user.role !== "admin") {
    const allowedIds = await Dataset.findAssignedToIds(user.userId);
    if (filter.datasetId) {
      if (!allowedIds.includes(filter.datasetId)) {
        const err = new Error("Not assigned to you");
        err.status = 403;
        throw err;
      }
    } else {
      filter.datasetIds = allowedIds;
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
    return {
      contentType: "text/csv; charset=utf-8",
      filename: `comments-${timestamp}.csv`,
      body: "\uFEFF" + lines.join("\r\n"),
    };
  }

  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("comments");
  sheet.addRow(header);
  rows.forEach((r) => sheet.addRow(r));

  const buffer = await workbook.xlsx.writeBuffer();

  return {
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    filename: `comments-${timestamp}.xlsx`,
    body: Buffer.from(buffer),
  };
}

/**
 * Public export entry — enqueued so concurrency is bounded by
 * MAX_CONCURRENT_EXPORTS.
 */
function exportComments(args) {
  return exportQueue.run(() => _exportComments(args));
}

module.exports = {
  buildDomainFilter,
  listComments,
  createComment,
  getComment,
  updateCommentText,
  annotateComment,
  bulkAnnotate,
  bulkAssign,
  getCommentVersions,
  restoreCommentVersion,
  deleteComment,
  exportComments,
};
