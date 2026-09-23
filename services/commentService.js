const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");
const Comment = require("../models/Comment");
const CommentVersion = require("../models/CommentVersion");
const Dataset = require("../models/Dataset");
const Taxonomy = require("../models/Taxonomy");
const { audit } = require("../utils/audit");

function toObjectId(id) {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildFilter(query) {
  const filter = {};

  if (query.datasetId) {
    const dsId = toObjectId(query.datasetId);
    if (dsId) filter.datasetId = dsId;
  }
  if (query.sentiment) filter.sentiment = query.sentiment;
  if (query.type) filter.type = query.type;
  if (query.assignedTo) {
    const uid = toObjectId(query.assignedTo);
    if (uid) filter.assignedTo = uid;
  }
  if (query.status) {
    filter.status = query.status;
  } else if (query.hideAnnotated === "true") {
    filter.status = { $ne: "annotated" };
  }
  if (query.search && typeof query.search === "string") {
    const trimmed = query.search.trim().slice(0, 100);
    if (trimmed) {
      filter.commentText = { $regex: escapeRegex(trimmed), $options: "i" };
    }
  }
  return filter;
}

async function getAllowedDatasetIds(user) {
  if (user.role === "admin") return null;
  const db = getDB();
  const datasets = await db
    .collection("datasets")
    .find({ assignedTo: new ObjectId(user.userId) }, { projection: { _id: 1 } })
    .toArray();
  return datasets.map((d) => d._id);
}

async function assertCanAccessComment(comment, user) {
  if (user.role === "admin") return true;
  const dataset = await Dataset.findById(comment.datasetId);
  if (!dataset?.assignedTo) return false;
  return dataset.assignedTo.toString() === user.userId;
}

async function getValidOptionsForDataset(dataset) {
  let sentiment = new Set(["positive", "negative", "neutral", "unannotated"]);
  let type = new Set(["bangla", "english", "banglish", "unclassified"]);

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

async function listComments(query, user) {
  const page = parseInt(query.page, 10) || 1;
  const limit = Math.min(parseInt(query.limit, 10) || 50, 200);
  const skip = (page - 1) * limit;

  const filter = buildFilter(query);

  const allowedIds = await getAllowedDatasetIds(user);
  if (allowedIds !== null) {
    if (filter.datasetId) {
      if (!allowedIds.some((id) => id.equals(filter.datasetId))) {
        const err = new Error("Not assigned to you");
        err.status = 403;
        throw err;
      }
    } else {
      filter.datasetId = { $in: allowedIds };
    }
  }

  const total = await Comment.count(filter);
  const comments = await Comment.find(filter, {
    sort: { createdAt: -1 },
    skip,
    limit,
  });

  return { page, limit, total, totalPages: Math.ceil(total / limit), comments };
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

  const dsId = toObjectId(datasetId);
  if (!dsId) {
    const err = new Error("Invalid datasetId");
    err.status = 400;
    throw err;
  }

  const dataset = await Dataset.findById(dsId);
  if (!dataset) {
    const err = new Error("Dataset not found");
    err.status = 404;
    throw err;
  }

  if (user.role !== "admin") {
    if (!dataset.assignedTo || dataset.assignedTo.toString() !== user.userId) {
      const err = new Error("Not assigned to you");
      err.status = 403;
      throw err;
    }
  }

  const trimmedSourceId = String(sourceId).trim();
  const trimmedText = String(commentText).trim();

  const duplicate = await Comment.findOne({
    datasetId: dsId,
    sourceId: trimmedSourceId,
  });
  if (duplicate) {
    const err = new Error("sourceId already exists in this dataset");
    err.status = 409;
    throw err;
  }

  const userId = new ObjectId(user.userId);
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

  let commentId;
  try {
    commentId = await Comment.create({
      datasetId: dsId,
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
    if (err.code === 11000) {
      const e = new Error("sourceId already exists in this dataset");
      e.status = 409;
      throw e;
    }
    throw err;
  }

  await CommentVersion.create({
    commentId,
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

  return { commentId, message: "Comment created" };
}

async function getComment(id, user) {
  const comment = await Comment.findById(id);
  if (!comment) {
    const err = new Error("Comment not found");
    err.status = 404;
    throw err;
  }

  if (!(await assertCanAccessComment(comment, user))) {
    const err = new Error("Not assigned to you");
    err.status = 403;
    throw err;
  }

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

  if (!(await assertCanAccessComment(existing, user))) {
    const err = new Error("Not assigned to you");
    err.status = 403;
    throw err;
  }

  const userId = new ObjectId(user.userId);
  const newVersion = existing.version + 1;
  const now = new Date();
  const newText = commentText.trim();

  await Comment.updateById(id, {
    commentText: newText,
    version: newVersion,
    updatedBy: userId,
    updatedAt: now,
  });

  await CommentVersion.create({
    commentId: new ObjectId(id),
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

  if (!(await assertCanAccessComment(existing, user))) {
    const err = new Error("Not assigned to you");
    err.status = 403;
    throw err;
  }

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

  const userId = new ObjectId(user.userId);
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
    updatedAt: now,
  });

  await CommentVersion.create({
    commentId: new ObjectId(id),
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

  const objectIds = [];
  for (const raw of ids) {
    const oid = toObjectId(raw);
    if (!oid) {
      const err = new Error(`Invalid id: ${raw}`);
      err.status = 400;
      throw err;
    }
    objectIds.push(oid);
  }

  const comments = await Comment.find({ _id: { $in: objectIds } });

  if (comments.length !== objectIds.length) {
    const err = new Error("One or more comments not found");
    err.status = 404;
    throw err;
  }

  if (user.role !== "admin") {
    const datasetIds = [
      ...new Set(comments.map((c) => c.datasetId.toString())),
    ];
    const allowed = await Dataset.find({
      _id: { $in: datasetIds.map((id) => new ObjectId(id)) },
      assignedTo: new ObjectId(user.userId),
    });
    const allowedIds = new Set(allowed.map((d) => d._id.toString()));
    for (const c of comments) {
      if (!allowedIds.has(c.datasetId.toString())) {
        const err = new Error("One or more comments are not assigned to you");
        err.status = 403;
        throw err;
      }
    }
  }

  if (sentiment !== undefined || type !== undefined) {
    const dsIds = [...new Set(comments.map((c) => c.datasetId.toString()))].map(
      (id) => new ObjectId(id),
    );
    const datasets = await Dataset.find({ _id: { $in: dsIds } });
    const map = new Map();
    datasets.forEach((d) => map.set(d._id.toString(), d));

    for (const c of comments) {
      const ds = map.get(c.datasetId.toString());
      const opts = await getValidOptionsForDataset(ds);

      if (sentiment !== undefined && !opts.sentiment.has(sentiment)) {
        const err = new Error(
          `Invalid sentiment "${sentiment}" for dataset "${ds?.name || c.datasetId.toString()}"`,
        );
        err.status = 400;
        throw err;
      }
      if (type !== undefined && !opts.type.has(type)) {
        const err = new Error(
          `Invalid type "${type}" for dataset "${ds?.name || c.datasetId.toString()}"`,
        );
        err.status = 400;
        throw err;
      }
    }
  }

  const userId = new ObjectId(user.userId);
  const now = new Date();
  const versionsToInsert = [];
  const bulkOps = [];
  let updated = 0;

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

    bulkOps.push({
      updateOne: {
        filter: { _id: existing._id },
        update: {
          $set: {
            sentiment: newSentiment,
            type: newType,
            annotationNote: newNote,
            status: newStatus,
            annotatedBy: userId,
            annotatedAt: now,
            version: newVersion,
            updatedBy: userId,
            updatedAt: now,
          },
        },
      },
    });

    versionsToInsert.push({
      commentId: existing._id,
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

    updated++;
  }

  if (bulkOps.length > 0) {
    await Comment.bulkWrite(bulkOps);
    await CommentVersion.insertMany(versionsToInsert);

    await audit({
      action: "comment.bulk_annotate",
      actor: user,
      metadata: { requested: objectIds.length, updated, sentiment, type },
    });
  }

  return {
    requested: objectIds.length,
    updated,
    skipped: objectIds.length - updated,
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
    const uid = toObjectId(assignedTo);
    if (!uid) {
      const err = new Error("Invalid assignedTo");
      err.status = 400;
      throw err;
    }
    const assignee = await getDB()
      .collection("users")
      .findOne({ _id: uid, isActive: true });
    if (!assignee) {
      const err = new Error("Assignee not found or inactive");
      err.status = 404;
      throw err;
    }
    newAssignee = uid;
  }

  const objectIds = [];
  for (const raw of ids) {
    const oid = toObjectId(raw);
    if (!oid) {
      const err = new Error(`Invalid id: ${raw}`);
      err.status = 400;
      throw err;
    }
    objectIds.push(oid);
  }

  const now = new Date();
  const result = await Comment.updateMany(
    { _id: { $in: objectIds } },
    {
      $set: {
        assignedTo: newAssignee,
        assignedAt: newAssignee ? now : null,
        assignedBy: new ObjectId(user.userId),
        updatedAt: now,
      },
    },
  );

  await audit({
    action: newAssignee ? "comment.bulk_assign" : "comment.bulk_unassign",
    actor: user,
    metadata: {
      count: result.modifiedCount,
      assignedTo: newAssignee?.toString() || null,
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
  if (!(await assertCanAccessComment(comment, user))) {
    const err = new Error("Not assigned to you");
    err.status = 403;
    throw err;
  }

  const [total, versions] = await Promise.all([
    CommentVersion.countByCommentId(id),
    CommentVersion.findByCommentId(id, { skip, limit }),
  ]);

  return { page, limit, total, totalPages: Math.ceil(total / limit), versions };
}

async function restoreCommentVersion(id, targetVersion, user) {
  const existing = await Comment.findById(id);
  if (!existing) {
    const err = new Error("Comment not found");
    err.status = 404;
    throw err;
  }

  if (!(await assertCanAccessComment(existing, user))) {
    const err = new Error("Not assigned to you");
    err.status = 403;
    throw err;
  }

  const versionRecord = await CommentVersion.findOne({
    commentId: new ObjectId(id),
    version: targetVersion,
  });
  if (!versionRecord) {
    const err = new Error("Version not found");
    err.status = 404;
    throw err;
  }

  const snap = versionRecord.snapshot;
  const userId = new ObjectId(user.userId);
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
    updatedAt: now,
  });

  await CommentVersion.create({
    commentId: new ObjectId(id),
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

  await CommentVersion.deleteMany({ commentId: new ObjectId(id) });
  await Comment.deleteById(id);

  await audit({
    action: "comment.delete",
    actor,
    targetType: "comment",
    targetId: id,
    metadata: { datasetId: comment.datasetId.toString() },
  });

  return { message: "Comment deleted" };
}

module.exports = {
  buildFilter,
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
};
