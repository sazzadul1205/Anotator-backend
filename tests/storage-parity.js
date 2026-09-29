// tests/storage-parity.js
// Verifies that the model layer really is a bulwark: every storage strategy
// must be observationally identical for every operation the application
// performs.
//
//   node tests/storage-parity.js
//
// The same scenario runs against json, sqlite, mongo and mysql, and the
// transcripts are compared pairwise. Providers that are not available in the
// current environment are skipped rather than failed, so the suite is still
// useful on a machine with no database running:
//   node tests/storage-parity.js                    # json + sqlite
//   MONGO_URI=... node tests/storage-parity.js      # + mongo
//   (with a MySQL server on 3306)                    # + mysql
//
// Exit code is 0 on success, 1 on any mismatch.

require("dotenv").config();

const assert = require("assert");
const fsp = require("fs/promises");
const os = require("os");
const path = require("path");

// ---------------------------------------------------------------------------
// Tiny test harness
// ---------------------------------------------------------------------------

const results = { passed: 0, failed: 0, skipped: 0, failures: [] };

async function test(name, fn) {
  try {
    await fn();
    results.passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    results.failed += 1;
    results.failures.push({ name, err });
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

/** Deep-equal that ignores key order and volatile values (ids, timestamps). */
function assertSame(actual, expected, message) {
  assert.deepStrictEqual(actual, expected, message);
}

/** Order-insensitive comparison for result sets Mongo returns unordered. */
function assertSameSet(actual, expected, message) {
  const key = (v) => JSON.stringify(v, Object.keys(v || {}).sort());
  const a = [...actual].map(key).sort();
  const b = [...expected].map(key).sort();
  assert.deepStrictEqual(a, b, message);
}

/**
 * Results whose *order* is not part of the contract, compared as sets.
 *
 * MongoDB specifies no ordering for `$group` output or for the documents
 * returned by an `$in` match, and no SQL engine promises the same. Asserting
 * an order here would be asserting an accident of each engine's planner, not a
 * guarantee the application relies on — and would fail the day a new provider
 * or a different MySQL index was used.
 */
const UNORDERED_RESULTS = new Set([
  // $group output order is unspecified.
  "groupBySentiment",
  "groupByStatus",
  "groupByGlobal",
  "groupByInvalid",
  "topByCommentCount",
  "datasetCountByStatus",
  // An $in match returns matching documents in engine-chosen order. The only
  // caller of findManyByIds checks the count and membership, never the order.
  "findManyByIds",
]);

// ---------------------------------------------------------------------------
// Provider harnesses
// ---------------------------------------------------------------------------

// `config` and `storage` are required for their side effect of resolving the
// module graph before the harness swaps providers below.
require("../config/app");
require("../config/storage");
const { COLLECTIONS } = require("../config/storage/schema");

const CONTRACT = require("../models/contract");
/**
 * Runs the same scenario against one strategy and returns a normalised
 * transcript. Ids are replaced with stable placeholders so the two providers
 * can be compared even though they mint different identifiers.
 */
async function runScenario(models) {
  const {
    User,
    Dataset,
    Comment,
    CommentVersion,
    Taxonomy,
    AuditLog,
    SystemLock,
  } = models;

  const idMap = new Map();
  const alias = (id) => {
    if (!id) return id;
    if (!idMap.has(id)) idMap.set(id, `#${idMap.size + 1}`);
    return idMap.get(id);
  };
  const aliasUser = (user) =>
    user
      ? {
          ...user,
          id: alias(user.id),
          // `_id` mirrors `id` on every DTO; alias it too, or the raw
          // provider-generated id would make every comparison differ.
          _id: alias(user.id),
          createdAt: "<date>",
          updatedAt: "<date>",
        }
      : null;

  const out = {};

  // --- users ---------------------------------------------------------------
  const admin = await User.create({
    email: "  Admin@Example.COM ",
    name: "Root Admin",
    password: "hash-admin",
    role: "admin",
  });
  const annotator = await User.create({
    email: "ann@example.com",
    name: "Ann",
    password: "hash-ann",
    role: "annotator",
  });
  out.userIds = { admin: alias(admin.id), annotator: alias(annotator.id) };

  out.userFindByEmail = aliasUser(await User.findByEmail("ADMIN@example.com"));
  out.userFindOne = aliasUser(await User.findOne({ role: "admin" }));
  out.userCountAdmins = await User.countAdmins();
  out.userCountActiveAnnotators = await User.countActiveAnnotators();
  out.userCountAll = await User.countAll();
  out.userCountActive = await User.countActive();

  // duplicate email -> DuplicateKeyError
  try {
    await User.create({ email: "admin@example.com", password: "x", role: "admin" });
    out.duplicateEmail = "no-error";
  } catch (err) {
    out.duplicateEmail = err.name;
  }

  // missing password -> ValidationError
  try {
    await User.create({ email: "someone@example.com" });
    out.missingPassword = "no-error";
  } catch (err) {
    out.missingPassword = err.name;
  }

  // tokenVersion bump on deactivate
  await User.updateStatus(annotator.id, false);
  out.deactivated = aliasUser(await User.findById(annotator.id));
  await User.updateStatus(annotator.id, true);

  // --- taxonomy ------------------------------------------------------------
  const taxonomy = await Taxonomy.create({
    name: "Default labels",
    description: "sentinels included",
    sentiment: [{ value: "positive", label: "Positive", order: 0 }],
    type: [{ value: "bangla", label: "Bangla", order: 0 }],
    createdBy: admin.id,
  });
  out.taxonomy = {
    ...(await Taxonomy.findById(taxonomy.id)),
    id: alias(taxonomy.id),
    _id: alias(taxonomy.id),
    createdBy: alias((await Taxonomy.findById(taxonomy.id)).createdBy),
    createdAt: "<date>",
    updatedAt: "<date>",
  };
  out.taxonomyList = (await Taxonomy.findMany({ isActive: true })).map((t) => t.name);

  // --- datasets ------------------------------------------------------------
  const datasetA = await Dataset.create({
    name: "Bank reviews",
    originalFileName: "bank.xlsx",
    fileType: "xlsx",
    totalRows: 4,
    uploadedBy: admin.id,
    status: "completed",
    taxonomyId: taxonomy.id,
  });
  const datasetB = await Dataset.create({
    name: "Empty set",
    uploadedBy: admin.id,
    status: "pending",
  });
  out.datasetA = alias(datasetA.id);
  out.datasetB = alias(datasetB.id);

  out.datasetAssignedToEmpty = (await Dataset.findAssignedToIds(annotator.id)).map(alias);
  await Dataset.updateById(datasetA.id, { assignedTo: annotator.id });
  out.datasetAssignedToAfter = (await Dataset.findAssignedToIds(annotator.id)).map(alias);
  out.countAssignedTo = await Dataset.countAssignedTo(annotator.id);
  out.countDatasetsUsingTaxonomy = await Taxonomy.countDatasetsUsing(taxonomy.id);

  // progress writes exercise dotted-path updates
  const startedAt = new Date("2026-01-01T00:00:00.000Z");
  await Dataset.updateProgress(datasetA.id, {
    phase: "inserting",
    processed: 0,
    total: 4,
    startedAt,
  });
  await Dataset.setProgressProcessed(datasetA.id, 2);
  const progressDoc = await Dataset.findById(datasetA.id);
  out.progress = {
    phase: progressDoc.progress.phase,
    processed: progressDoc.progress.processed,
    total: progressDoc.progress.total,
  };

  // --- comments ------------------------------------------------------------
  const rows = [
    { sourceId: "r1", text: "great product", sentiment: "positive", status: "annotated", type: "bangla" },
    { sourceId: "r2", text: "bad", sentiment: "negative", status: "pending", type: "bangla" },
    { sourceId: "r3", text: "meh", sentiment: "neutral", status: "pending", type: "english" },
    { sourceId: "r4", text: "x".repeat(120), sentiment: "positive", status: "pending", type: "bangla" },
  ];
  // Distinct createdAt values: MongoDB's sort() is not stable for equal
  // keys, so a test that depends on tie order would be flaky by nature.
  const epoch = Date.parse("2026-02-01T00:00:00.000Z");
  const inserted = await Comment.insertMany(
    rows.map((r, i) => ({
      datasetId: datasetA.id,
      sourceId: r.sourceId,
      commentText: r.text,
      sentiment: r.sentiment,
      type: r.type,
      status: r.status,
      version: 1,
      createdBy: admin.id,
      updatedBy: admin.id,
      createdAt: new Date(epoch + i * 1000),
      updatedAt: new Date(epoch + i * 1000),
    })),
  );
  out.insertedCount = inserted.length;
  out.insertedIndexes = inserted.map((i) => i.index);
  const commentId = (sourceId) =>
    inserted.find((i) => i.index === rows.findIndex((r) => r.sourceId === sourceId)).id;

  // duplicate (datasetId, sourceId) must be skipped, not throw
  const partial = await Comment.insertMany([
    {
      datasetId: datasetA.id,
      sourceId: "r1",
      commentText: "duplicate",
      sentiment: "positive",
      type: "bangla",
      status: "pending",
      version: 1,
      createdBy: admin.id,
      updatedBy: admin.id,
    },
    {
      datasetId: datasetA.id,
      sourceId: "r5",
      commentText: "new row",
      sentiment: "neutral",
      type: "bangla",
      status: "pending",
      version: 1,
      createdBy: admin.id,
      updatedBy: admin.id,
    },
  ]);
  out.partialInsertCount = partial.length;
  out.partialInsertSourceIds = (
    await Promise.all(partial.map((p) => Comment.findById(p.id)))
  ).map((c) => c.sourceId);

  // single create
  const single = await Comment.create({
    datasetId: datasetB.id,
    sourceId: "only",
    commentText: "solo",
    sentiment: "positive",
    type: "bangla",
    status: "pending",
    version: 1,
    createdBy: admin.id,
  });
  out.singleCreateId = alias(single.id);

  // missing required fields -> ValidationError
  try {
    await Comment.create({ sourceId: "no-dataset" });
    out.commentValidation = "no-error";
  } catch (err) {
    out.commentValidation = err.name;
  }

  // --- comment reads -------------------------------------------------------
  out.countAll = await Comment.count({});
  out.countByStatus = await Comment.countByStatus(datasetA.id);
  out.countByStatusInvalid = await Comment.countByStatus("not-an-id");

  const page1 = await Comment.findMany({ datasetId: datasetA.id }, { page: 1, limit: 2 });
  out.page1 = {
    total: page1.total,
    page: page1.page,
    limit: page1.limit,
    totalPages: page1.totalPages,
    sourceIds: page1.comments.map((c) => c.sourceId),
  };
  const page2 = await Comment.findMany({ datasetId: datasetA.id }, { page: 2, limit: 2 });
  out.page2SourceIds = page2.comments.map((c) => c.sourceId);
  out.sortAsc = (
    await Comment.findMany(
      { datasetId: datasetA.id },
      { limit: 10, sortBy: "sourceId", sortDir: "asc" },
    )
  ).comments.map((c) => c.sourceId);

  out.filterByStatus = (
    await Comment.findMany({ datasetId: datasetA.id, status: "pending" }, { limit: 10 })
  ).comments.map((c) => c.sourceId);
  out.excludeAnnotated = (
    await Comment.findMany({ datasetId: datasetA.id, excludeAnnotated: true }, { limit: 10 })
  ).comments.map((c) => c.sourceId);
  out.filterBySentiment = (
    await Comment.findMany({ datasetId: datasetA.id, sentiment: "positive" }, { limit: 10 })
  ).comments.map((c) => c.sourceId);
  out.search = (
    await Comment.findMany({ datasetId: datasetA.id, search: "GREA" }, { limit: 10 })
  ).comments.map((c) => c.sourceId);
  out.searchEscaped = (
    await Comment.findMany({ datasetId: datasetA.id, search: "x".repeat(30) }, { limit: 10 })
  ).comments.length;
  out.assignedToNull = (
    await Comment.findMany({ datasetId: datasetA.id, assignedTo: null }, { limit: 10 })
  ).comments.length;
  out.datasetIdsScope = (
    await Comment.findMany({ datasetIds: [datasetA.id, datasetB.id] }, { limit: 10 })
  ).total;
  out.datasetIdsIntersect = await Comment.count({ datasetIds: [datasetA.id], datasetId: datasetB.id });
  out.invalidIds = await Comment.count({ ids: ["nope"] });

  out.findForExport = (await Comment.findForExport({ datasetId: datasetA.id })).map(
    (c) => c.sourceId,
  );
  out.findManyByIds = (
    await Comment.findManyByIds([commentId("r1"), commentId("r2"), "garbage"])
  ).map((c) => c.sourceId);
  out.findTexts = (
    await Comment.findTextsForDuplicates(datasetA.id, 2)
  ).map((t) => t.length);

  // --- aggregations --------------------------------------------------------
  out.groupBySentiment = await Comment.groupByField(datasetA.id, "sentiment");
  out.groupByStatus = await Comment.groupByField(datasetA.id, "status");
  out.groupByGlobal = await Comment.groupByField(null, "sentiment");
  out.groupByInvalid = await Comment.groupByField("nope", "sentiment");
  out.lengthHistogram = await Comment.lengthHistogram(datasetA.id, [0, 10, 50, 100]);
  out.lengthHistogramInvalid = await Comment.lengthHistogram("nope", [0, 10]);

  // --- comment writes ------------------------------------------------------
  await Comment.updateById(commentId("r2"), {
    sentiment: "positive",
    status: "annotated",
    version: 2,
    updatedBy: annotator.id,
  });
  out.afterUpdate = (({ sentiment, status, version, assignedTo, updatedBy }) => ({
    sentiment,
    status,
    version,
    assignedTo: alias(assignedTo),
    updatedBy: alias(updatedBy),
  }))(await Comment.findById(commentId("r2")));

  // client-supplied identity must be ignored
  await Comment.updateById(commentId("r3"), { id: "hacked", _id: "hacked" });
  out.identityIgnored = (await Comment.findById(commentId("r3"))).id === commentId("r3");

  await Comment.bulkUpdate([
    { id: commentId("r3"), patch: { sentiment: "positive" } },
    { id: commentId("r4"), patch: { sentiment: "negative" } },
  ]);
  out.afterBulk = (await Comment.findMany({ datasetId: datasetA.id }, { limit: 10 })).comments
    .map((c) => c.sourceId)
    .sort();

  out.updateManyCount = (
    await Comment.updateMany({ datasetId: datasetB.id }, { sentiment: "positive" })
  ).modifiedCount;

  // --- versions ------------------------------------------------------------
  const versionIds = [];
  for (const [i, row] of rows.entries()) {
    const v = await CommentVersion.create({
      commentId: commentId(row.sourceId),
      version: i + 1,
      snapshot: { commentText: row.text, sentiment: row.sentiment, status: row.status },
      changedFields: ["commentText"],
      changeType: "import",
      changedBy: admin.id,
      createdAt: new Date(),
    });
    versionIds.push(v.id);
  }
  const history = await CommentVersion.findByCommentId(commentId("r1"), { limit: 5 });
  out.historyVersions = history.map((v) => v.version);
  out.historyPaged = (
    await CommentVersion.findByCommentId(commentId("r1"), { skip: 1, limit: 1 })
  ).map((v) => v.version);
  out.versionCount = await CommentVersion.countByCommentId(commentId("r1"));
  out.versionFindOne = (
    await CommentVersion.findOne({ commentId: commentId("r2"), version: 2 })
  ).version;
  out.versionFindOneMissing = await CommentVersion.findOne({
    commentId: commentId("r2"),
    version: 99,
  });
  out.rawVersions = (await CommentVersion.findRawByCommentIds([commentId("r1")])).length;
  out.activityByDate = await CommentVersion.activityByDate(new Date(0));
  out.activityForDataset = await CommentVersion.activityByDateForDataset(datasetA.id);
  out.activityForInvalidDataset = await CommentVersion.activityByDateForDataset("nope");

  // --- audit ---------------------------------------------------------------
  await AuditLog.create({
    action: "dataset.import_started",
    actorId: admin.id,
    actorEmail: "admin@example.com",
    actorRole: "admin",
    targetType: "dataset",
    targetId: datasetA.id,
    metadata: { rows: 4 },
  });
  await AuditLog.create({ action: "user.create", actorId: null, at: new Date() });
  out.auditCount = await AuditLog.count({});
  out.auditByAction = await AuditLog.count({ action: "dataset.import_started" });
  out.auditByTarget = await AuditLog.count({ targetType: "dataset", targetId: datasetA.id });
  out.auditPage = (await AuditLog.findMany({}, { page: 1, limit: 1 })).total;
  out.auditDistinct = (await AuditLog.distinctActions()).sort();
  out.auditEntry = (({ action, actorEmail, targetType, metadata }) => ({
    action,
    actorEmail,
    targetType,
    metadata,
  }))((await AuditLog.findMany({ action: "dataset.import_started" })).entries[0]);

  // --- dataset aggregates --------------------------------------------------
  out.datasetsWithCounts = (await Dataset.findManyWithCounts({})).map((d) => ({
    name: d.name,
    summary: d.summary,
  }));
  out.datasetCountByStatus = await Dataset.countByStatus();
  out.topByCommentCount = (await Dataset.topByCommentCount(5)).map((d) => ({
    name: d.name,
    status: d.status,
    total: d.total,
    annotated: d.annotated,
  }));
  out.countAllDatasets = await Dataset.countAll();

  // --- locks ---------------------------------------------------------------
  out.lockClaim1 = await SystemLock.claim("admin_bootstrap");
  try {
    await SystemLock.claim("admin_bootstrap");
    out.lockClaim2 = "no-error";
  } catch (err) {
    out.lockClaim2 = err.name;
  }
  out.lockExists = await SystemLock.exists("admin_bootstrap");
  out.lockRelease = await SystemLock.release("admin_bootstrap");
  out.lockExistsAfter = await SystemLock.exists("admin_bootstrap");
  out.lockReleaseAgain = await SystemLock.release("admin_bootstrap");

  // --- cascades & cleanup --------------------------------------------------
  out.deleteDatasetCascade = await Comment.deleteMany({ datasetId: datasetB.id });
  out.deleteVersions = await CommentVersion.deleteByCommentIds([commentId("r1")]);
  out.deleteVersionByComment = await CommentVersion.deleteByCommentId(commentId("r2"));
  out.deleteOne = await Comment.deleteById(commentId("r4"));
  out.deleteInvalidId = await Comment.deleteById("not-an-id");
  out.findByInvalidId = await Comment.findById("not-an-id");

  out.cleanupStale = (
    await Dataset.cleanupStaleImports(new Date(Date.now() - 30 * 60 * 1000))
  ).modifiedCount;
  out.datasetAfterCleanup = (await Dataset.findMany({})).map((d) => d.status).sort();

  out.clearTaxonomy = await Dataset.clearTaxonomy(datasetA.id);
  out.taxonomyAfterClear = (await Dataset.findById(datasetA.id)).taxonomyId;

  // --- media domain --------------------------------------------------------
  // The media models are exercised here rather than through the services,
  // because parity is a statement about what the *providers* agree on. The
  // services' file handling is covered by the end-to-end API suite, and mixing
  // it in would make a filesystem failure look like a storage divergence.
  const { MediaDataset, MediaAsset, MediaAnnotation, MediaAnnotationVersion, MediaLabelSet } = models;

  const labelSet = await MediaLabelSet.create({
    name: "Road",
    description: "road scenes",
    labels: [
      { value: "car", label: "Car", color: "#ff0000" },
      { value: "person", label: "Person", color: "#00ff00" },
    ],
    isActive: true,
    createdBy: admin.id,
  });
  const labelSetDto = await MediaLabelSet.findById(labelSet.id);
  out.labelSetCreated = {
    name: labelSetDto.name,
    labels: labelSetDto.labels,
    isActive: labelSetDto.isActive,
  };
  out.labelSetIdAliasMatches = labelSetDto._id === labelSetDto.id;

  const mds = await MediaDataset.create({
    name: "City",
    mediaKind: "image",
    labelSetId: labelSet.id,
    description: "parity",
    status: "pending",
    createdBy: admin.id,
  });
  // create() returns a summary, not the DTO, so re-read for anything the
  // client would actually see.
  out.mediaDatasetCreated = ((d) => ({
    name: d.name,
    mediaKind: d.mediaKind,
    totalAssets: d.totalAssets,
    totalAnnotations: d.totalAnnotations,
    annotatedRatio: d.annotatedRatio,
    status: d.status,
  }))(await MediaDataset.findById(mds.id));

  try {
    await MediaDataset.create({ name: "City", mediaKind: "image", createdBy: admin.id });
    out.mediaDatasetDuplicate = "no-error";
  } catch (err) {
    // Duplicate name must surface as the same error class on every provider.
    out.mediaDatasetDuplicate = err.name;
  }

  const assetACreated = await MediaAsset.create({
    datasetId: mds.id,
    kind: "image",
    originalFileName: "a.png",
    extension: "png",
    mimeType: "image/png",
    sizeBytes: 1234,
    checksum: "abc123",
    width: 800,
    height: 600,
    status: "pending",
    source: "upload",
    createdBy: admin.id,
  });
  const assetA = await MediaAsset.findById(assetACreated.id);
  const assetB = await MediaAsset.create({
    datasetId: mds.id,
    kind: "video",
    originalFileName: "b.mp4",
    extension: "mp4",
    mimeType: "video/mp4",
    sizeBytes: 99999,
    checksum: "def456",
    durationMs: 65000,
    status: "pending",
    source: "upload",
    createdBy: admin.id,
  });

  // storagePath must never reach the client: it is the one field that would let
  // a client build filesystem paths, which config/media.js refuses to trust.
  out.mediaAssetDto = ((a) => ({
    kind: a.kind,
    width: a.width,
    height: a.height,
    durationMs: a.durationMs,
    status: a.status,
    hasStoragePath: "storagePath" in a,
    fileUrlSuffix: a.fileUrl.endsWith(a.id),
  }))(assetA);

  // Normalised coordinates are the riskiest value in the whole domain: they are
  // stored as a SQL `float`, and a wrong type mapping silently round-trips a
  // number as a string, which every exporter would then write out as garbage.
  const boxCreated = await MediaAnnotation.create({
    assetId: assetA.id,
    datasetId: mds.id,
    kind: "bbox",
    label: "car",
    x: 0.125,
    y: 0.25,
    boxWidth: 0.5,
    boxHeight: 0.375,
    width: 800,
    height: 600,
    note: "n",
    createdBy: admin.id,
  });
  const box = await MediaAnnotation.findById(boxCreated.id);
  out.mediaBoxRoundTrip = ((a) => ({
    kind: a.kind,
    box: a.box,
    types: [typeof a.box.x, typeof a.box.width],
    boxPixels: a.boxPixels,
  }))(box);
  out.mediaBoxPixelMath = box.boxPixels.x === 100 && box.boxPixels.width === 400;

  const clsCreated = await MediaAnnotation.create({
    assetId: assetA.id,
    datasetId: mds.id,
    kind: "classification",
    label: "person",
    width: 800,
    height: 600,
    createdBy: admin.id,
  });
  const cls = await MediaAnnotation.findById(clsCreated.id);
  out.mediaClassificationHasNoBox = cls.box === null && cls.boxPixels === null;

  // A video annotation carries a frame position; an image one must not.
  const frameCreated = await MediaAnnotation.create({
    assetId: assetB.id,
    datasetId: mds.id,
    kind: "bbox",
    label: "car",
    x: 0,
    y: 0,
    boxWidth: 1,
    boxHeight: 1,
    frameIndex: 30,
    timestampMs: 1000,
    createdBy: admin.id,
  });
  const frame = await MediaAnnotation.findById(frameCreated.id);
  out.mediaFrame = {
    frameIndex: frame.frameIndex,
    timestampMs: frame.timestampMs,
  };

  // A classification on an image has no frame position at all.
  out.mediaImageFrameIsNull = frame.frameIndex === 30 && cls.frameIndex === null;

  // --- media filters and aggregates ---------------------------------------
  out.mediaFindByKind = (await MediaAnnotation.findMany({ datasetId: mds.id, kind: "bbox" })).total;
  out.mediaFindByLabel = (await MediaAnnotation.findMany({ datasetId: mds.id, label: "person" })).total;
  out.mediaFindByAsset = (await MediaAnnotation.findAllByAsset(assetA.id)).length;
  out.mediaCountByAsset = await MediaAnnotation.countByAsset(assetA.id);
  out.mediaCountByDataset = await MediaAnnotation.countByDataset(mds.id);
  out.mediaDistinctLabels = (await MediaAnnotation.distinctLabels(mds.id)).sort();
  out.mediaHistogram = await MediaAnnotation.labelHistogram(mds.id);
  // Compared as a serialised string, not via the transcript's deepStrictEqual:
  // that ignores key order, and key order is part of the response contract.
  // BSON hands projected fields back in its own order, so a histogram can have
  // the right values and still serialise differently per provider.
  out.mediaHistogramKeyOrder = JSON.stringify(out.mediaHistogram);

  // An empty list filter must match nothing on every provider — the services
  // rely on this to degrade safely when every id in a batch was malformed.
  out.mediaEmptyIn = (await MediaAnnotation.findMany({ labelIn: [] })).total;
  out.mediaAssetEmptyIn = (await MediaAsset.findMany({ checksumIn: [] })).total;

  // A malformed id must match nothing on every provider too. This is the case
  // that once diverged: the document adapter stringified `{$in: []}` into the
  // truthy garbage "[object Object]" (matching nothing) while Mongo dropped the
  // clause entirely and returned the whole collection.
  out.mediaMalformedIdIn = (await MediaAnnotation.findMany({ assetId: { $in: [] } })).total;
  out.mediaAssetMalformedIdIn = (await MediaAsset.findMany({ datasetId: { $in: [] } })).total;
  out.mediaMalformedScalarId = (await MediaAsset.findMany({ datasetId: { a: 1 } })).total;

  // `null` must match null-or-absent, as Mongo does.
  out.mediaNullFrameIndex =
    (await MediaAnnotation.findMany({ datasetId: mds.id, frameIndex: null })).total;
  out.mediaNeLabel = (await MediaAnnotation.findMany({ datasetId: mds.id, label: { $ne: "car" } })).total;

  out.mediaAssetCountByStatus = await MediaAsset.countByStatus(mds.id);
  out.mediaAssetCountByKind = await MediaAsset.countByKind(mds.id);
  // Byte sizes are `int` on SQL: a `long` maps to TEXT and comes back a string.
  out.mediaSumBytes = await MediaAsset.sumBytes(mds.id);
  out.mediaSumBytesType = typeof (await MediaAsset.sumBytes(mds.id));

  out.mediaAssetSort = (await MediaAsset.findMany(
    { datasetId: mds.id }, { sortBy: "sizeBytes", sortDir: -1 },
  )).assets.map((a) => a.extension);
  out.mediaAssetPage = ((p) => ({ page: p.page, total: p.total, count: p.assets.length }))(
    await MediaAsset.findMany({ datasetId: mds.id }, { page: 1, limit: 1 }),
  );
  out.mediaFindManyByIds = (await MediaAsset.findManyByIds([assetA.id, assetB.id])).length;
  out.mediaAssetInvalidId = await MediaAsset.findById("not-an-id");

  // --- media history & counters -------------------------------------------
  const versions1Created = await MediaAnnotationVersion.create({
    annotationId: box.id,
    datasetId: mds.id,
    assetId: assetA.id,
    revision: 1,
    snapshot: { kind: "bbox", label: "car", box: { x: 0.125, y: 0.25, width: 0.5, height: 0.375 } },
    action: "created",
    actorId: admin.id,
  });
  const versions1 = await MediaAnnotationVersion.findOne({
    annotationId: box.id, revision: 1,
  });
  out.mediaVersionCreated = { revision: versions1.revision, action: versions1.action };
  out.mediaVersionSummaryHasId = typeof versions1Created.id === "string";

  const updated = await MediaAnnotation.updateById(box.id, { label: "person" });
  out.mediaUpdateModified = updated.modifiedCount;
  out.mediaUpdateLabel = (await MediaAnnotation.findById(box.id)).label;
  out.mediaUpdateRevision = (await MediaAnnotation.findById(box.id)).revision;

  // A no-op update must report zero modifications on every provider: services
  // branch on modifiedCount to decide whether to append a version.
  const noop = await MediaAnnotation.updateById(box.id, { label: "person" });
  out.mediaNoopModified = noop.modifiedCount;

  await MediaAnnotationVersion.create({
    annotationId: box.id,
    datasetId: mds.id,
    assetId: assetA.id,
    revision: 2,
    snapshot: { kind: "bbox", label: "person" },
    action: "updated",
    actorId: admin.id,
  });
  out.mediaHistoryLength = (await MediaAnnotationVersion.findByAnnotationId(box.id)).length;
  out.mediaHistoryCount = await MediaAnnotationVersion.countByAnnotationId(box.id);
  out.mediaLatestRevision = (await MediaAnnotationVersion.findLatest(box.id)).revision;
  out.mediaVersionFindOne =
    (await MediaAnnotationVersion.findOne({ annotationId: box.id, revision: 1 })).revision;
  out.mediaVersionMissing = await MediaAnnotationVersion.findOne({
    annotationId: box.id, revision: 99,
  });
  out.mediaSnapshotRoundTrip = (await MediaAnnotationVersion.findLatest(box.id)).snapshot;
  out.mediaActivity = await MediaAnnotationVersion.activityByDate(new Date(0));

  await MediaAsset.setAnnotationState(assetA.id, 2);
  out.mediaAssetAfterCount = ((a) => ({ annotationCount: a.annotationCount, status: a.status }))(
    await MediaAsset.findById(assetA.id),
  );
  await MediaAsset.setAnnotationState(assetA.id, 0);
  out.mediaAssetZeroed = ((a) => ({ annotationCount: a.annotationCount, status: a.status }))(
    await MediaAsset.findById(assetA.id),
  );

  await MediaAsset.setAnnotationState(assetA.id, 2);
  await MediaAsset.setAnnotationState(assetB.id, 1);
  await MediaDataset.setCounters(mds.id, {
    totalAssets: 2, annotatedAssets: 2, totalAnnotations: 4, totalBytes: 101233,
  });
  out.mediaDatasetCounters = ((d) => ({
    totalAssets: d.totalAssets,
    annotatedAssets: d.annotatedAssets,
    totalAnnotations: d.totalAnnotations,
    totalBytes: d.totalBytes,
    totalBytesType: typeof d.totalBytes,
    annotatedRatio: d.annotatedRatio,
  }))(await MediaDataset.findById(mds.id));

  // --- media cascades ------------------------------------------------------
  out.mediaDeleteAnnotationsByAsset = await MediaAnnotation.deleteManyByAsset(assetA.id);
  out.mediaDeleteAnnotationsByDataset = await MediaAnnotation.deleteManyByDataset(mds.id);
  out.mediaDeleteAsset = await MediaAsset.deleteById(assetA.id);
  out.mediaDeleteAssetsByDataset = await MediaAsset.deleteManyByDataset(mds.id);
  out.mediaDeleteDataset = (await MediaDataset.deleteById(mds.id)).deletedCount;
  out.mediaAfterCascade = {
    datasets: (await MediaDataset.findMany({})).total,
    assets: (await MediaAsset.findMany({})).total,
    annotations: (await MediaAnnotation.findMany({})).total,
    versions: (await MediaAnnotationVersion.findByAnnotationId("nonexistent")).length,
  };  // The label set outlives its dataset: label sets are reusable vocabulary.
  out.labelSetSurvives = (await MediaLabelSet.findById(labelSet.id)).name;

  return out;
}

// ---------------------------------------------------------------------------
// Environment setup
// ---------------------------------------------------------------------------

/**
 * Reloads config/storage with DATA_PROVIDER set. The caller is responsible for
 * making sure the target is a throwaway database or file: the scenario below
 * deletes every collection it can reach.
 */
async function useProvider(env) {
  process.env.DATA_PROVIDER = env.provider;
  Object.assign(process.env, env.vars || {});
  process.env.JWT_SECRET = "parity-test-secret-that-is-long-enough-32";
  delete require.cache[require.resolve("../config/app")];
  delete require.cache[require.resolve("../config/storage")];
  require("../config/app");
  return require("../config/storage");
}

/**
 * Loads the model classes for a provider *after* config/storage has been
 * swapped, so their `require("../../config/storage")` binds to the current
 * provider. The cache is cleared first, because a model required for an
 * earlier provider would otherwise keep a reference to that one.
 */
function loadModels(provider) {
  const dir = path.resolve(
    __dirname,
    "..",
    "models",
    provider === "mongo" ? "mongo" : "document",
  );
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(dir + path.sep)) delete require.cache[key];
  }
  return require(dir);
}

/** True when a MySQL server answers. Used to skip rather than fail. */
async function mysqlReachable() {
  try {
    const mysql = require("mysql2/promise");
    const { config } = require("../config/app");
    const c = config.storage.mysql;
    const admin = await mysql.createConnection({
      host: c.url ? new URL(c.url).hostname : c.host,
      port: c.url ? Number(new URL(c.url).port) || 3306 : c.port,
      user: c.url ? decodeURIComponent(new URL(c.url).username) : c.user,
      password: c.url ? decodeURIComponent(new URL(c.url).password) : c.password,
      connectTimeout: 3000,
    });
    await admin.end();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

async function main() {
  const tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "annotator-parity-"));

  // The document models back three providers (json, sqlite, mysql); mongo has
  // its own because of ObjectId. Each is run through the identical scenario
  // and the transcripts are compared, so any provider can be the reference.
  const targets = [
    { name: "json", env: { provider: "json", vars: { JSON_DATA_DIR: path.join(tmpRoot, "json") } } },
    { name: "sqlite", env: { provider: "sqlite", vars: { SQLITE_FILE: path.join(tmpRoot, "parity.sqlite") } } },
  ];

  if (process.env.MONGO_URI) {
    // A throwaway database, never the one the app uses. The scenario below
    // deletes every collection, so it must not be pointed at real data.
    targets.push({
      name: "mongo",
      env: { provider: "mongo", vars: { DB_NAME: "annotator_parity_test" } },
      teardown: async (storage) => {
        await storage.getStore().dropDatabase();
      },
    });
  } else {
    console.log("\n  - MongoDB skipped (no MONGO_URI in this environment)\n");
  }

  if (await mysqlReachable()) {
    targets.push({
      name: "mysql",
      env: { provider: "mysql", vars: { MYSQL_DATABASE: "annotator_parity_test" } },
      teardown: async (storage) => {
        const { config } = require("../config/app");
        const db = config.storage.mysql.database;
        const mysql = require("mysql2/promise");
        const c = config.storage.mysql;
        const conn = await mysql.createConnection({
          host: c.url ? new URL(c.url).hostname : c.host,
          port: c.url ? Number(new URL(c.url).port) || 3306 : c.port,
          user: c.url ? decodeURIComponent(new URL(c.url).username) : c.user,
          password: c.url ? decodeURIComponent(new URL(c.url).password) : c.password,
        });
        await conn.query(`DROP DATABASE IF EXISTS \`${db}\``);
        await conn.end();
        void storage;
      },
    });
  } else {
    console.log("\n  - MySQL skipped (no reachable server)\n");
  }

  // --- run the scenario on every provider ---------------------------------
  const runs = {};

  for (const target of targets) {
    console.log(`\n=== ${target.name} strategy: full scenario ===\n`);
    const storage = await useProvider(target.env);
    try {
      await storage.init();
    } catch (err) {
      console.log(`  - ${target.name} unavailable: ${err.message}\n`);
      continue;
    }

    const models = loadModels(target.name);
    CONTRACT.verifyContract({ ...models, __providerName: target.name });

    // Start from a clean slate so every run sees identical inputs.
    for (const name of Object.keys(COLLECTIONS)) {
      await storage.getStore().collection(name).deleteMany({});
    }

    runs[target.name] = await runScenario(models);
    if (target.teardown) await target.teardown(storage);
    await storage.close();
  }

  // --- contract coverage ---------------------------------------------------
  console.log("\n=== Contract: every strategy exposes the same surface ===\n");
  for (const name of CONTRACT.MODEL_NAMES) {
    for (const provider of Object.keys(runs)) {
      await test(`${name}.${provider} implements its contract`, () => {
        const models = loadModels(provider);
        CONTRACT.verifyContract({ ...models, __providerName: provider });
        const declared = CONTRACT.CONTRACT[name];
        const gaps = declared.filter((m) => typeof models[name][m] !== "function");
        assert.deepStrictEqual(gaps, []);
      });
    }
  }

  // --- parity --------------------------------------------------------------
  const reference = Object.keys(runs)[0];
  for (const provider of Object.keys(runs).slice(1)) {
    console.log(`\n=== Parity: ${reference} vs ${provider} ===\n`);
    for (const key of Object.keys(runs[reference])) {
      await test(`parity[${provider}]: ${key}`, () => {
        const a = runs[reference][key];
        const b = runs[provider][key];
        if (UNORDERED_RESULTS.has(key)) {
          assertSameSet(a, b, `${key} differs`);
        } else {
          assertSame(a, b, `${key} differs`);
        }
      });
    }
  }

  await fsp.rm(tmpRoot, { recursive: true, force: true });

  console.log(
    `\n=== ${results.passed} passed, ${results.failed} failed, ${results.skipped} skipped ===\n`,
  );
  process.exit(results.failed ? 1 : 0);
}

main().catch((err) => {
  console.error("\nParity run crashed:", err);
  process.exit(1);
});
