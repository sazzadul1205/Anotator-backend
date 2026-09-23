const { ObjectId } = require("mongodb");
const Dataset = require("../models/Dataset");
const Comment = require("../models/Comment");
const CommentVersion = require("../models/CommentVersion");
const User = require("../models/User");
const { audit } = require("../utils/audit");

async function getStats() {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalDatasets,
    totalComments,
    annotatedComments,
    pendingComments,
    activeAnnotators,
    datasetsByStatus,
    recentComments,
  ] = await Promise.all([
    Dataset.countAll(),
    Comment.count({}),
    Comment.count({ status: "annotated" }),
    Comment.count({ status: "pending" }),
    User.countActiveAnnotators(),
    Dataset.countByStatus(),
    CommentVersion.activityByDate({ createdAt: { $gte: sevenDaysAgo } }),
  ]);

  const statusMap = { pending: 0, processing: 0, completed: 0, failed: 0 };
  datasetsByStatus.forEach((s) => {
    statusMap[s._id] = s.count;
  });

  const percentAnnotated =
    totalComments === 0
      ? 0
      : Math.round((annotatedComments / totalComments) * 1000) / 10;

  return {
    totalDatasets,
    totalComments,
    annotatedComments,
    pendingComments,
    activeAnnotators,
    percentAnnotated,
    datasetsByStatus: statusMap,
    activityLast7Days: recentComments.map((r) => ({
      date: r._id,
      count: r.count,
    })),
  };
}

async function listDatasets(query, user) {
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.uploadedBy && ObjectId.isValid(query.uploadedBy)) {
    filter.uploadedBy = new ObjectId(query.uploadedBy);
  }
  if (user.role !== "admin") {
    filter.assignedTo = new ObjectId(user.userId);
  }

  const includeCounts = query.includeCounts === "true";

  if (!includeCounts) {
    return Dataset.findAll(filter);
  }

  const datasets = await Dataset.findWithCounts(filter);
  return datasets.map((d) => ({
    ...d,
    summary: {
      total: d.summary.total,
      annotated: d.summary.annotated,
      pending: d.summary.pending,
    },
  }));
}

async function getDataset(id, user) {
  if (!ObjectId.isValid(id)) {
    const err = new Error("Invalid id");
    err.status = 400;
    throw err;
  }
  const datasetId = new ObjectId(id);

  const dataset = await Dataset.findById(datasetId);
  if (!dataset) {
    const err = new Error("Dataset not found");
    err.status = 404;
    throw err;
  }

  if (
    user.role !== "admin" &&
    (!dataset.assignedTo || dataset.assignedTo.toString() !== user.userId)
  ) {
    const err = new Error("Not assigned to you");
    err.status = 403;
    throw err;
  }

  let summary = { total: 0, pending: 0, annotated: 0 };
  if (dataset.status === "completed") {
    summary = await Comment.countByStatus(datasetId);
  }

  return { dataset, summary };
}

async function assignDataset(id, assignedTo, actor) {
  if (!ObjectId.isValid(id)) {
    const err = new Error("Invalid id");
    err.status = 400;
    throw err;
  }
  const datasetId = new ObjectId(id);

  const dataset = await Dataset.findById(datasetId);
  if (!dataset) {
    const err = new Error("Dataset not found");
    err.status = 404;
    throw err;
  }

  let newAssignee = null;
  if (assignedTo !== null && assignedTo !== undefined && assignedTo !== "") {
    if (!ObjectId.isValid(assignedTo)) {
      const err = new Error("Invalid assignedTo");
      err.status = 400;
      throw err;
    }
    newAssignee = new ObjectId(assignedTo);

    const user = await User.findById(newAssignee);
    if (!user) {
      const err = new Error("Assignee not found");
      err.status = 404;
      throw err;
    }
    if (!user.isActive) {
      const err = new Error("Assignee is inactive");
      err.status = 400;
      throw err;
    }
  }

  await Dataset.updateById(datasetId, {
    assignedTo: newAssignee,
    assignedAt: newAssignee ? new Date() : null,
  });

  await audit({
    action: newAssignee ? "dataset.assign" : "dataset.unassign",
    actor,
    targetType: "dataset",
    targetId: datasetId.toString(),
    metadata: { assignedTo: newAssignee?.toString() || null },
  });

  return { message: newAssignee ? "Dataset assigned" : "Dataset unassigned" };
}

async function duplicateDataset(id, name, actor) {
  if (!ObjectId.isValid(id)) {
    const err = new Error("Invalid id");
    err.status = 400;
    throw err;
  }
  const sourceId = new ObjectId(id);

  const source = await Dataset.findById(sourceId);
  if (!source) {
    const err = new Error("Dataset not found");
    err.status = 404;
    throw err;
  }

  const userId = new ObjectId(actor.userId);
  const now = new Date();

  const newName = (name && name.trim()) || `${source.name} (copy)`;

  const newDatasetId = await Dataset.create({
    name: newName,
    originalFileName: source.originalFileName,
    fileType: source.fileType,
    sheetName: source.sheetName,
    checksum: source.checksum,
    totalRows: source.totalRows,
    importedRows: source.importedRows,
    skippedRows: source.skippedRows,
    renamedRows: source.renamedRows || 0,
    dedupeStrategy: source.dedupeStrategy || "skip",
    status: "completed",
    importError: null,
    importErrors: [],
    progress: {
      phase: "completed",
      processed: source.importedRows,
      total: source.importedRows,
      startedAt: now,
      updatedAt: now,
    },
    uploadedBy: userId,
    assignedTo: null,
    assignedAt: null,
    duplicatedFrom: sourceId,
  });

  const sourceComments = await Comment.find({ datasetId: sourceId });
  let copiedCount = 0;

  if (sourceComments.length > 0) {
    const idMap = new Map();

    const newComments = sourceComments.map((c) => {
      const newId = new ObjectId();
      idMap.set(c._id.toString(), newId);
      copiedCount++;

      return {
        ...c,
        _id: newId,
        datasetId: newDatasetId,
        createdBy: userId,
        updatedBy: userId,
        createdAt: now,
        updatedAt: now,
      };
    });

    await Comment.insertMany(newComments);

    const sourceVersions = await CommentVersion.collection()
      .find({ commentId: { $in: sourceComments.map((c) => c._id) } })
      .toArray();

    if (sourceVersions.length > 0) {
      const newVersions = sourceVersions
        .map((v) => {
          const mappedCommentId = idMap.get(v.commentId.toString());
          if (!mappedCommentId) return null;
          return {
            ...v,
            _id: new ObjectId(),
            commentId: mappedCommentId,
            changedBy: userId,
            createdAt: now,
          };
        })
        .filter(Boolean);

      if (newVersions.length > 0) {
        await CommentVersion.insertMany(newVersions);
      }
    }
  }

  await audit({
    action: "dataset.duplicate",
    actor,
    targetType: "dataset",
    targetId: newDatasetId.toString(),
    metadata: { sourceId: sourceId.toString(), copiedComments: copiedCount },
  });

  return {
    datasetId: newDatasetId,
    copiedComments: copiedCount,
    message: "Dataset duplicated",
  };
}

async function renameDataset(id, name, actor) {
  if (!name || typeof name !== "string" || !name.trim()) {
    const err = new Error("name is required");
    err.status = 400;
    throw err;
  }

  if (!ObjectId.isValid(id)) {
    const err = new Error("Invalid id");
    err.status = 400;
    throw err;
  }
  const datasetId = new ObjectId(id);

  const result = await Dataset.updateById(datasetId, { name: name.trim() });
  if (result.matchedCount === 0) {
    const err = new Error("Dataset not found");
    err.status = 404;
    throw err;
  }

  await audit({
    action: "dataset.rename",
    actor,
    targetType: "dataset",
    targetId: datasetId.toString(),
    metadata: { name: name.trim() },
  });

  return { message: "Dataset updated" };
}

async function deleteDataset(id, actor) {
  if (!ObjectId.isValid(id)) {
    const err = new Error("Invalid id");
    err.status = 400;
    throw err;
  }
  const datasetId = new ObjectId(id);

  const dataset = await Dataset.findById(datasetId);
  if (!dataset) {
    const err = new Error("Dataset not found");
    err.status = 404;
    throw err;
  }

  const comments = await Comment.find(
    { datasetId },
    { projection: { _id: 1 } },
  );
  const commentIds = comments.map((c) => c._id);

  if (commentIds.length) {
    await CommentVersion.deleteMany({ commentId: { $in: commentIds } });
    await Comment.deleteMany({ datasetId });
  }
  await Dataset.deleteById(datasetId);

  await audit({
    action: "dataset.delete",
    actor,
    targetType: "dataset",
    targetId: datasetId.toString(),
    metadata: { name: dataset.name, deletedComments: commentIds.length },
  });

  return {
    message: "Dataset and all related data deleted",
    deletedComments: commentIds.length,
  };
}

module.exports = {
  getStats,
  listDatasets,
  getDataset,
  assignDataset,
  duplicateDataset,
  renameDataset,
  deleteDataset,
};
