// services/analyticsService.js
// Dataset-level and global analytics.

const { Comment, CommentVersion, Dataset, User } = require("../models");
const { exports: exportQueue } = require("../config/concurrency");

// ---------------------------------------------------------------------------
// Pure statistical helpers
// ---------------------------------------------------------------------------

function shannonEntropy(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let h = 0;
  for (const c of counts) {
    if (c === 0) continue;
    const p = c / total;
    h -= p * Math.log2(p);
  }
  return h;
}

function giniImpurity(counts) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total === 0) return 0;
  let s = 0;
  for (const c of counts) {
    const p = c / total;
    s += p * p;
  }
  return 1 - s;
}

function summarizeDistribution(rows) {
  const entries = rows
    .filter((r) => r && r.label !== null)
    .map((r) => [String(r.label), Number(r.count) || 0])
    .sort((a, b) => b[1] - a[1]);

  const counts = entries.map(([, c]) => c);
  const total = counts.reduce((a, b) => a + b, 0);
  const max = counts[0] || 0;
  const min = counts[counts.length - 1] || 0;
  const entropy = shannonEntropy(counts);
  const maxEntropy = entries.length > 1 ? Math.log2(entries.length) : 0;
  const balanceScore = maxEntropy > 0 ? entropy / maxEntropy : 1;

  return {
    total,
    classes: entries.length,
    distribution: entries.map(([label, count]) => ({
      label,
      count,
      percent: total > 0 ? Math.round((count / total) * 1000) / 10 : 0,
    })),
    max,
    min,
    imbalanceRatio: min > 0 ? Math.round((max / min) * 100) / 100 : null,
    entropy: Math.round(entropy * 1000) / 1000,
    maxEntropy: Math.round(maxEntropy * 1000) / 1000,
    balanceScore: Math.round(balanceScore * 1000) / 1000,
    gini: Math.round(giniImpurity(counts) * 1000) / 1000,
  };
}

function assessReadiness({
  totalComments,
  annotatedComments,
  sentimentSummary,
  typeSummary,
  duplicateCount,
}) {
  const reasons = [];
  let score = 100;

  if (totalComments === 0) {
    return {
      level: "empty",
      score: 0,
      reasons: ["Dataset has no comments."],
    };
  }

  const annotatedPct = (annotatedComments / totalComments) * 100;

  if (annotatedPct < 50) {
    score -= 40;
    reasons.push(
      `Only ${annotatedPct.toFixed(1)}% of comments are annotated (need ≥ 50% to even consider training).`,
    );
  } else if (annotatedPct < 90) {
    score -= 15;
    reasons.push(
      `${annotatedPct.toFixed(1)}% annotated — finish the rest for a cleaner split.`,
    );
  }

  if (totalComments < 100) {
    score -= 20;
    reasons.push(
      `Only ${totalComments} comments — most text models need at least a few hundred.`,
    );
  } else if (totalComments < 500) {
    score -= 8;
    reasons.push(
      `${totalComments} comments — workable for prototyping, thin for production.`,
    );
  }

  const sClasses = sentimentSummary.classes;
  const sBalance = sentimentSummary.balanceScore;
  if (sClasses < 2) {
    score -= 30;
    reasons.push("Sentiment has fewer than 2 classes — nothing to classify.");
  } else if (sBalance < 0.5) {
    score -= 20;
    reasons.push(
      `Sentiment classes are very imbalanced (balance score ${sBalance}). Consider collecting more of the minority class.`,
    );
  } else if (sBalance < 0.75) {
    score -= 8;
    reasons.push(
      `Sentiment classes are moderately imbalanced (balance score ${sBalance}).`,
    );
  }

  const tClasses = typeSummary.classes;
  const tBalance = typeSummary.balanceScore;
  if (tClasses < 2) {
    score -= 15;
    reasons.push("Type/Language has fewer than 2 classes.");
  } else if (tBalance < 0.5) {
    score -= 10;
    reasons.push(
      `Type/Language classes are imbalanced (balance score ${tBalance}).`,
    );
  }

  if (duplicateCount > 0) {
    const dupPct = (duplicateCount / totalComments) * 100;
    if (dupPct > 10) {
      score -= 10;
      reasons.push(
        `${duplicateCount} near-duplicate comments (${dupPct.toFixed(1)}%) — dedupe before training.`,
      );
    } else if (dupPct > 3) {
      score -= 4;
      reasons.push(`${duplicateCount} near-duplicate comments detected.`);
    }
  }

  score = Math.max(0, Math.min(100, score));

  let level;
  if (score >= 80) level = "ready";
  else if (score >= 55) level = "close";
  else if (score >= 30) level = "needs_work";
  else level = "not_ready";

  if (reasons.length === 0) {
    reasons.push("Looks good — no obvious issues detected.");
  }

  return { level, score, reasons };
}

// ---------------------------------------------------------------------------
// Domain helpers
// ---------------------------------------------------------------------------

const LENGTH_BOUNDARIES = [0, 20, 50, 100, 200, 500, 1000, 100000];

function countNearDuplicates(texts) {
  const seen = new Set();
  let dup = 0;
  for (const t of texts) {
    const key = String(t || "")
      .toLowerCase()
      .trim()
      .slice(0, 80);
    if (!key) continue;
    if (seen.has(key)) dup++;
    else seen.add(key);
  }
  return dup;
}

async function assertDatasetAccess(datasetId, user) {
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
  return dataset;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function getDatasetAnalytics(datasetId, user) {
  const dataset = await assertDatasetAccess(datasetId, user);

  const [
    statusCounts,
    sentimentRows,
    typeRows,
    lengthRows,
    statusRows,
    versionActivity,
    duplicateTexts,
  ] = await Promise.all([
    Comment.countByStatus(datasetId),
    Comment.groupByField(datasetId, "sentiment"),
    Comment.groupByField(datasetId, "type"),
    Comment.lengthHistogram(datasetId, LENGTH_BOUNDARIES),
    Comment.groupByField(datasetId, "status"),
    CommentVersion.activityByDateForDataset(datasetId),
    Comment.findTextsForDuplicates(datasetId, 2000),
  ]);

  const {
    total: totalComments,
    pending: pendingComments,
    annotated: annotatedComments,
  } = statusCounts;

  const sentimentSummary = summarizeDistribution(sentimentRows);
  const typeSummary = summarizeDistribution(typeRows);

  const lengthHistogram = lengthRows.map((r) => ({
    label: r.label,
    count: r.count,
  }));

  const statusMap = {};
  for (const r of statusRows) {
    statusMap[r.label || "unknown"] = r.count;
  }

  const duplicateCount = countNearDuplicates(duplicateTexts);

  const readiness = assessReadiness({
    totalComments,
    annotatedComments,
    sentimentSummary,
    typeSummary,
    duplicateCount,
  });

  const warnings = [];

  if (sentimentSummary.imbalanceRatio && sentimentSummary.imbalanceRatio >= 3) {
    const top = sentimentSummary.distribution[0];
    const bottom =
      sentimentSummary.distribution[sentimentSummary.distribution.length - 1];
    warnings.push({
      kind: "sentiment_imbalance",
      severity: sentimentSummary.imbalanceRatio >= 8 ? "high" : "medium",
      message: `Sentiment "${top.label}" is ${sentimentSummary.imbalanceRatio}× more common than "${bottom.label}".`,
    });
  }
  if (typeSummary.imbalanceRatio && typeSummary.imbalanceRatio >= 3) {
    const top = typeSummary.distribution[0];
    const bottom =
      typeSummary.distribution[typeSummary.distribution.length - 1];
    warnings.push({
      kind: "type_imbalance",
      severity: typeSummary.imbalanceRatio >= 8 ? "high" : "medium",
      message: `Type "${top.label}" is ${typeSummary.imbalanceRatio}× more common than "${bottom.label}".`,
    });
  }
  if (totalComments > 0 && annotatedComments / totalComments < 0.5) {
    warnings.push({
      kind: "low_annotation_coverage",
      severity: "high",
      message: `Less than half the dataset is annotated (${annotatedComments}/${totalComments}).`,
    });
  }
  if (duplicateCount > 0) {
    warnings.push({
      kind: "near_duplicates",
      severity: duplicateCount / totalComments > 0.1 ? "high" : "low",
      message: `${duplicateCount} near-duplicate comment${duplicateCount === 1 ? "" : "s"} detected.`,
    });
  }

  return {
    dataset: {
      _id: dataset.id,
      name: dataset.name,
      status: dataset.status,
      taxonomyId: dataset.taxonomyId || null,
      taxonomyName: dataset.taxonomyName || null,
    },
    overview: {
      totalComments,
      annotatedComments,
      pendingComments,
      percentAnnotated:
        totalComments === 0
          ? 0
          : Math.round((annotatedComments / totalComments) * 1000) / 10,
      duplicateCount,
    },
    statusBreakdown: statusMap,
    sentiment: sentimentSummary,
    type: typeSummary,
    lengthHistogram,
    activity: versionActivity,
    readiness,
    warnings,
  };
}

async function getGlobalAnalytics() {
  const now = new Date();
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const [
    totalComments,
    annotatedComments,
    pendingComments,
    totalDatasets,
    totalUsers,
    activeUsers,
    sentimentRows,
    typeRows,
    versionActivity,
    datasetStatusRows,
    topDatasets,
  ] = await Promise.all([
    Comment.count({}),
    Comment.count({ status: "annotated" }),
    Comment.count({ status: "pending" }),
    Dataset.countAll(),
    User.countAll(),
    User.countActive(),
    Comment.groupByField(null, "sentiment"),
    Comment.groupByField(null, "type"),
    CommentVersion.activityByDate(fourteenDaysAgo),
    Dataset.countByStatus(),
    Dataset.topByCommentCount(10),
  ]);

  const sentimentSummary = summarizeDistribution(sentimentRows);
  const typeSummary = summarizeDistribution(typeRows);

  const activityByDate = new Map(versionActivity.map((v) => [v.date, v.count]));
  const timeline = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    timeline.push({ date: key, count: activityByDate.get(key) || 0 });
  }

  const datasetsByStatus = {};
  for (const row of datasetStatusRows) {
    datasetsByStatus[row.status || "unknown"] = row.count;
  }

  return {
    overview: {
      totalComments,
      annotatedComments,
      pendingComments,
      totalDatasets,
      totalUsers,
      activeUsers,
      percentAnnotated:
        totalComments === 0
          ? 0
          : Math.round((annotatedComments / totalComments) * 1000) / 10,
    },
    sentiment: sentimentSummary,
    type: typeSummary,
    activityLast14Days: timeline,
    datasetsByStatus,
    topDatasets: topDatasets.map((d) => ({
      _id: d.id,
      name: d.name,
      status: d.status,
      total: d.total,
      annotated: d.annotated,
      percent:
        d.total > 0 ? Math.round((d.annotated / d.total) * 1000) / 10 : 0,
    })),
  };
}

/**
 * Build an ML-ready export of annotated comments for one dataset.
 * Returns { contentType, filename, body }.
 */
async function _exportMLDataset({ datasetId, user, format, split }) {
  if (!["jsonl", "csv", "xlsx"].includes(format)) {
    const err = new Error("format must be jsonl, csv or xlsx");
    err.status = 400;
    throw err;
  }

  const dataset = await assertDatasetAccess(datasetId, user);

  const splitStr = String(split || "0.8,0.1,0.1");
  const [trainP, valP, testP] = splitStr.split(",").map(Number);
  if (
    !Number.isFinite(trainP) ||
    !Number.isFinite(valP) ||
    !Number.isFinite(testP) ||
    Math.abs(trainP + valP + testP - 1) > 1e-6
  ) {
    const err = new Error(
      "split must be three numbers summing to 1 (e.g. 0.8,0.1,0.1)",
    );
    err.status = 400;
    throw err;
  }

  const { comments } = await Comment.findMany(
    { datasetId, status: "annotated" },
    { page: 1, limit: 1_000_000, sortBy: "createdAt", sortDir: "asc" },
  );

  if (comments.length === 0) {
    const err = new Error("No annotated comments to export");
    err.status = 400;
    throw err;
  }

  const sorted = comments
    .slice()
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const n = sorted.length;
  const nTrain = Math.floor(n * trainP);
  const nVal = Math.floor(n * valP);
  const trainIds = new Set(sorted.slice(0, nTrain).map((c) => c.id));
  const valIds = new Set(sorted.slice(nTrain, nTrain + nVal).map((c) => c.id));

  const splitFor = (c) =>
    trainIds.has(c.id) ? "train" : valIds.has(c.id) ? "val" : "test";

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const baseName = String(dataset.name)
    .replace(/[^\w-]+/g, "_")
    .slice(0, 40);

  if (format === "jsonl") {
    const lines = sorted.map((c) =>
      JSON.stringify({
        id: c.sourceId,
        text: c.commentText,
        sentiment: c.sentiment,
        type: c.type,
        split: splitFor(c),
        dataset: dataset.name,
        taxonomy: dataset.taxonomyName || "Default",
      }),
    );
    return {
      contentType: "application/x-ndjson; charset=utf-8",
      filename: `${baseName}-ml-${timestamp}.jsonl`,
      body: lines.join("\n") + "\n",
    };
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
  const rows = sorted.map((c) => [
    c.sourceId,
    c.commentText,
    c.sentiment,
    c.type,
    splitFor(c),
    dataset.name,
    dataset.taxonomyName || "Default",
  ]);

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
      filename: `${baseName}-ml-${timestamp}.csv`,
      body: "\uFEFF" + lines.join("\r\n"),
    };
  }

  const ExcelJS = require("exceljs");
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("ml-data");
  sheet.addRow(header);
  rows.forEach((r) => sheet.addRow(r));
  const buffer = await workbook.xlsx.writeBuffer();

  return {
    contentType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    filename: `${baseName}-ml-${timestamp}.xlsx`,
    body: Buffer.from(buffer),
  };
}

/**
 * Public entry — queued so concurrency is bounded by MAX_CONCURRENT_EXPORTS.
 */
function exportMLDataset(args) {
  return exportQueue.run(() => _exportMLDataset(args));
}

module.exports = {
  summarizeDistribution,
  assessReadiness,
  getDatasetAnalytics,
  getGlobalAnalytics,
  exportMLDataset,
};
