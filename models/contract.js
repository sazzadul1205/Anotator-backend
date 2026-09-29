// models/contract.js
// The bulwark: a machine-checkable description of every method the model
// layer guarantees to the rest of the application.
//
// Services and controllers are written against this list and nothing else.
// If a new provider is added — or a method is renamed on one provider and
// forgotten on another — `verifyContract()` fails loudly at boot instead of
// throwing `TypeError: Comment.groupByField is not a function` on the first
// user who hits that code path.
//
// A contract is only worth something if it is enforced, so models/index.js
// calls verifyContract() as soon as a strategy is loaded.

/** Methods each model must expose. `static` in the class, plain here. */
const CONTRACT = {
  Comment: [
    // reads
    "findById",
    "findOne",
    "findMany",
    "count",
    "countByStatus",
    "groupByField",
    "lengthHistogram",
    "findTextsForDuplicates",
    "findForExport",
    "findManyByIds",
    // writes
    "create",
    "updateById",
    "updateMany",
    "bulkUpdate",
    "insertMany",
    "deleteById",
    "deleteMany",
    "rawInsertMany",
  ],
  CommentVersion: [
    "create",
    "insertMany",
    "findByCommentId",
    "countByCommentId",
    "findOne",
    "deleteByCommentId",
    "deleteByCommentIds",
    "activityByDate",
    "activityByDateForDataset",
    "findRawByCommentIds",
    "rawInsertMany",
  ],
  Dataset: [
    "findById",
    "findOne",
    "findMany",
    "findManyWithCounts",
    "findAssignedToIds",
    "create",
    "updateById",
    "updateProgress",
    "setProgressProcessed",
    "clearTaxonomy",
    "deleteById",
    "countAll",
    "countByStatus",
    "countAssignedTo",
    "topByCommentCount",
    "cleanupStaleImports",
  ],
  User: [
    "findById",
    "findByIdWithPassword",
    "findByEmail",
    "findOne",
    "findMany",
    "findAll",
    "create",
    "updateById",
    "updateStatus",
    "updatePassword",
    "bumpTokenVersion",
    "deleteById",
    "countAdmins",
    "countActiveAnnotators",
    "countAll",
    "countActive",
  ],
  Taxonomy: [
    "findById",
    "findMany",
    "create",
    "updateById",
    "deactivate",
    "deleteById",
    "countDatasetsUsing",
  ],
  AuditLog: ["create", "findMany", "count", "distinctActions"],
  SystemLock: ["claim", "release", "exists"],
};

const MODEL_NAMES = Object.keys(CONTRACT);

/** Aggregate check, used by the parity test suite and the boot-time guard. */
function findGaps(models) {
  const gaps = [];
  for (const [modelName, methods] of Object.entries(CONTRACT)) {
    const model = models[modelName];
    if (!model) {
      gaps.push(`${modelName}: model missing from the selected provider`);
      continue;
    }
    for (const method of methods) {
      if (typeof model[method] !== "function") {
        gaps.push(`${modelName}.${method}: missing`);
      }
    }
  }
  return gaps;
}

function verifyContract(models, { throwOnGap = true } = {}) {
  const gaps = findGaps(models);
  if (gaps.length && throwOnGap) {
    const error = new Error(
      `Model contract violation (provider "${models.__providerName || "unknown"}"):\n  - ${gaps.join(
        "\n  - ",
      )}`,
    );
    error.gaps = gaps;
    throw error;
  }
  return gaps;
}

module.exports = { CONTRACT, MODEL_NAMES, findGaps, verifyContract };
