// services/datasetService.js
// Stats, listing, assignment, duplication, rename, delete for datasets.

const { Comment, CommentVersion, Dataset, User } = require("../models");
const { audit } = require("../utils/audit");

/**
 * Admin dashboard stats.
 */
async function getStats() {
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  const [
    totalDatasets,
    totalComments,
    annotatedComments,
    pendingComments,
    activeAnnotators,
    statusRows,
    activityRows,
  ] = await Promise.all([
    Dataset.countAll(),
    Comment.count({}),
    Comment.count({ status: "annotated" }),
    Comment.count({ status: "pending" }),
    User.countActiveAnnotators(),
    Dataset.countByStatus(),
    CommentVersion.activityByDate(sevenDaysAgo),
  ]);

  const statusMap = { pending: 0, processing: 0, completed: 0, failed: 0 };
  for (const row of statusRows) {
    statusMap[row.status] = row.count;
  }

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
    activityLast7Days: activityRows,
  };
}

/**
 * List datasets. Admins see all; annotators only see assigned ones.
 * When includeCounts=true, attaches per-dataset comment counts.
 */
async function listDatasets(query, user) {
  const filter = {};
  if (query.status) filter.status = query.status;
  if (query.uploadedBy) filter.uploadedBy = query.uploadedBy;
  if (user.role !== "admin") filter.assignedTo = user.userId;

  const includeCounts = query.includeCounts === "true";

  if (!includeCounts) {
    return Dataset.findMany(filter);
  }

  const datasets = await Dataset.findManyWithCounts(filter);
  return datasets.map((d) => ({
    ...d,
    _id: d.id,
    summary: {
      total: d.summary.total,
      annotated: d.summary.annotated,
      pending: d.summary.pending,
    },
  }));
}

async function getDataset(id, user) {
  const dataset = await Dataset.findById(id);
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

  let summary = { total: 0, pending: 0, annotated: 0 };
  if (dataset.status === "completed") {
    summary = await Comment.countByStatus(id);
  }

  return { dataset, summary };
}

async function assignDataset(id, assignedTo, actor) {
  const dataset = await Dataset.findById(id);
  if (!dataset) {
    const err = new Error("Dataset not found");
    err.status = 404;
    throw err;
  }

  let newAssignee = null;
  if (assignedTo !== null && assignedTo !== undefined && assignedTo !== "") {
    const user = await User.findById(assignedTo);
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
    newAssignee = user.id;
  }

  await Dataset.updateById(id, {
    assignedTo: newAssignee,
    assignedAt: newAssignee ? new Date() : null,
  });

  await audit({
    action: newAssignee ? "dataset.assign" : "dataset.unassign",
    actor,
    targetType: "dataset",
    targetId: id,
    metadata: { assignedTo: newAssignee || null },
  });

  return {
    message: newAssignee ? "Dataset assigned" : "Dataset unassigned",
  };
}

async function duplicateDataset(id, name, actor) {
  const source = await Dataset.findById(id);
  if (!source) {
    const err = new Error("Dataset not found");
    err.status = 404;
    throw err;
  }

  const userId = actor.userId;
  const now = new Date();
  const newName = (name && name.trim()) || `${source.name} (copy)`;

  const { id: newDatasetId } = await Dataset.create({
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
    duplicatedFrom: source.id,
  });

  // Fetch all source comments + their versions, then remap ids
  const sourceComments = await Comment.findMany(
    { datasetId: source.id },
    { page: 1, limit: 1_000_000 },
  );
  const comments = sourceComments.comments;

  let copiedCount = 0;

  if (comments.length > 0) {
    // Insert new comments one by one so we can capture new ids
    // (also handles duplicate sourceId constraints cleanly per dataset).
    const idMap = new Map();
    const newCommentDtos = comments.map((c) => {
      const dto = {
        datasetId: newDatasetId,
        sourceId: c.sourceId,
        commentText: c.commentText,
        sentiment: c.sentiment,
        type: c.type,
        status: c.status,
        assignedTo: null,
        assignedAt: null,
        assignedBy: null,
        annotatedBy: c.annotatedBy,
        annotatedAt: c.annotatedAt,
        annotationNote: c.annotationNote,
        version: c.version,
        createdBy: userId,
        updatedBy: userId,
        createdAt: now,
        updatedAt: now,
        _oldId: c.id,
      };
      return dto;
    });

    const inserted = await Comment.insertMany(newCommentDtos);
    for (const ins of inserted) {
      const dto = newCommentDtos[ins.index];
      if (dto && dto._oldId) idMap.set(dto._oldId, ins.id);
    }
    copiedCount = inserted.length;

    // Copy versions
    const oldIds = comments.map((c) => c.id);
    const sourceVersions = await CommentVersion.findRawByCommentIds(oldIds);

    if (sourceVersions.length > 0) {
      const newVersions = [];
      for (const v of sourceVersions) {
        const oldCid = v.commentId.toString();
        const newCid = idMap.get(oldCid);
        if (!newCid) continue;
        newVersions.push({
          commentId: newCid,
          version: v.version,
          snapshot: v.snapshot,
          changedFields: v.changedFields || [],
          changeType: v.changeType,
          restoredFrom: v.restoredFrom ?? null,
          changedBy: userId,
          createdAt: now,
        });
      }
      if (newVersions.length > 0) {
        await CommentVersion.insertMany(newVersions);
      }
    }
  }

  await audit({
    action: "dataset.duplicate",
    actor,
    targetType: "dataset",
    targetId: newDatasetId,
    metadata: { sourceId: id, copiedComments: copiedCount },
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

  const result = await Dataset.updateById(id, { name: name.trim() });
  if (result.matchedCount === 0) {
    const err = new Error("Dataset not found");
    err.status = 404;
    throw err;
  }

  await audit({
    action: "dataset.rename",
    actor,
    targetType: "dataset",
    targetId: id,
    metadata: { name: name.trim() },
  });

  return { message: "Dataset updated" };
}

async function deleteDataset(id, actor) {
  const dataset = await Dataset.findById(id);
  if (!dataset) {
    const err = new Error("Dataset not found");
    err.status = 404;
    throw err;
  }

  // Delete comments + their versions first
  const { comments } = await Comment.findMany(
    { datasetId: id },
    { page: 1, limit: 1_000_000 },
  );
  const commentIds = comments.map((c) => c.id);

  if (commentIds.length) {
    await CommentVersion.deleteByCommentIds(commentIds);
    await Comment.deleteMany({ datasetId: id });
  }
  await Dataset.deleteById(id);

  await audit({
    action: "dataset.delete",
    actor,
    targetType: "dataset",
    targetId: id,
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
