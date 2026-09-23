const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");
const Dataset = require("../models/Dataset");
const Comment = require("../models/Comment");
const CommentVersion = require("../models/CommentVersion");
const User = require("../models/User");

function toObjectId(id) {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

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

function summarizeDistribution(countMap) {
  const entries = Object.entries(countMap).sort((a, b) => b[1] - a[1]);
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
    return { level: "empty", score: 0, reasons: ["Dataset has no comments."] };
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

  if (reasons.length === 0)
    reasons.push("Looks good — no obvious issues detected.");

  return { level, score, reasons };
}

async function getDatasetAnalytics(datasetId, user) {
  const db = getDB();
  const id = toObjectId(datasetId);
  if (!id) {
    const err = new Error("Invalid datasetId");
    err.status = 400;
    throw err;
  }

  const dataset = await Dataset.findById(id);
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

  const [
    totalComments,
    annotatedComments,
    pendingComments,
    sentimentAgg,
    typeAgg,
    lengthAgg,
    statusAgg,
    versionAgg,
    sampleComments,
  ] = await Promise.all([
    Comment.count({ datasetId: id }),
    Comment.count({ datasetId: id, status: "annotated" }),
    Comment.count({ datasetId: id, status: "pending" }),
    Comment.aggregate([
      { $match: { datasetId: id } },
      { $group: { _id: "$sentiment", count: { $sum: 1 } } },
    ]),
    Comment.aggregate([
      { $match: { datasetId: id } },
      { $group: { _id: "$type", count: { $sum: 1 } } },
    ]),
    Comment.aggregate([
      { $match: { datasetId: id } },
      { $project: { len: { $strLenCP: { $ifNull: ["$commentText", ""] } } } },
      {
        $bucket: {
          groupBy: "$len",
          boundaries: [0, 20, 50, 100, 200, 500, 1000, 100000],
          default: "1000+",
          output: { count: { $sum: 1 } },
        },
      },
    ]),
    Comment.aggregate([
      { $match: { datasetId: id } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]),
    db
      .collection("comment_versions")
      .aggregate([
        {
          $lookup: {
            from: "comments",
            localField: "commentId",
            foreignField: "_id",
            as: "c",
          },
        },
        { $unwind: "$c" },
        { $match: { "c.datasetId": id } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray(),
    Comment.find(
      { datasetId: id },
      { projection: { commentText: 1 }, limit: 2000 },
    ),
  ]);

  const sentimentMap = {};
  sentimentAgg.forEach((r) => {
    sentimentMap[r._id || "unannotated"] = r.count;
  });
  const typeMap = {};
  typeAgg.forEach((r) => {
    typeMap[r._id || "unclassified"] = r.count;
  });
  const statusMap = {};
  statusAgg.forEach((r) => {
    statusMap[r._id || "unknown"] = r.count;
  });

  const sentimentSummary = summarizeDistribution(sentimentMap);
  const typeSummary = summarizeDistribution(typeMap);

  const lengthBinLabels = {
    0: "0–19",
    20: "20–49",
    50: "50–99",
    100: "100–199",
    200: "200–499",
    500: "500–999",
    1000: "1000+",
  };
  const lengthBuckets = {};
  lengthAgg.forEach((b) => {
    const label =
      b._id === "1000+" ? "1000+" : lengthBinLabels[b._id] || String(b._id);
    lengthBuckets[label] = b.count;
  });
  const lengthHistogram = Object.entries(lengthBuckets).map(
    ([label, count]) => ({ label, count }),
  );

  const seen = new Map();
  let duplicateCount = 0;
  for (const c of sampleComments) {
    const key = String(c.commentText || "")
      .toLowerCase()
      .trim()
      .slice(0, 80);
    if (!key) continue;
    if (seen.has(key)) duplicateCount++;
    else seen.set(key, 1);
  }

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
      _id: dataset._id,
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
    activity: versionAgg.map((r) => ({ date: r._id, count: r.count })),
    readiness,
    warnings,
  };
}

async function getGlobalAnalytics() {
  const db = getDB();
  const now = new Date();
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const [
    totalComments,
    annotatedComments,
    pendingComments,
    totalDatasets,
    totalUsers,
    activeUsers,
    sentimentAgg,
    typeAgg,
    versionsOverTime,
    datasetsByStatus,
    topDatasets,
  ] = await Promise.all([
    Comment.count({}),
    Comment.count({ status: "annotated" }),
    Comment.count({ status: "pending" }),
    Dataset.countAll(),
    User.countAll(),
    User.countActive(),
    Comment.aggregate([{ $group: { _id: "$sentiment", count: { $sum: 1 } } }]),
    Comment.aggregate([{ $group: { _id: "$type", count: { $sum: 1 } } }]),
    CommentVersion.activityByDate({ createdAt: { $gte: fourteenDaysAgo } }),
    Dataset.countByStatus(),
    db
      .collection("datasets")
      .aggregate([
        {
          $lookup: {
            from: "comments",
            let: { dsId: "$_id" },
            pipeline: [
              { $match: { $expr: { $eq: ["$datasetId", "$$dsId"] } } },
              {
                $group: {
                  _id: null,
                  total: { $sum: 1 },
                  annotated: {
                    $sum: { $cond: [{ $eq: ["$status", "annotated"] }, 1, 0] },
                  },
                },
              },
            ],
            as: "counts",
          },
        },
        {
          $addFields: {
            summary: {
              $ifNull: [
                { $arrayElemAt: ["$counts", 0] },
                { total: 0, annotated: 0 },
              ],
            },
          },
        },
        { $match: { "summary.total": { $gt: 0 } } },
        { $sort: { "summary.total": -1 } },
        { $limit: 10 },
        {
          $project: {
            name: 1,
            status: 1,
            total: "$summary.total",
            annotated: "$summary.annotated",
          },
        },
      ])
      .toArray(),
  ]);

  const sentimentMap = {};
  sentimentAgg.forEach((r) => {
    sentimentMap[r._id || "unannotated"] = r.count;
  });
  const typeMap = {};
  typeAgg.forEach((r) => {
    typeMap[r._id || "unclassified"] = r.count;
  });

  const timeline = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const key = d.toISOString().slice(0, 10);
    const found = versionsOverTime.find((v) => v._id === key);
    timeline.push({ date: key, count: found ? found.count : 0 });
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
    sentiment: summarizeDistribution(sentimentMap),
    type: summarizeDistribution(typeMap),
    activityLast14Days: timeline,
    datasetsByStatus: datasetsByStatus.reduce((acc, r) => {
      acc[r._id || "unknown"] = r.count;
      return acc;
    }, {}),
    topDatasets: topDatasets.map((d) => ({
      _id: d._id,
      name: d.name,
      status: d.status,
      total: d.total,
      annotated: d.annotated,
      percent:
        d.total > 0 ? Math.round((d.annotated / d.total) * 1000) / 10 : 0,
    })),
  };
}

module.exports = {
  summarizeDistribution,
  assessReadiness,
  getDatasetAnalytics,
  getGlobalAnalytics,
};
