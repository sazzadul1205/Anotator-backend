// tests/api-test.js
// End-to-end route test for the Annotator backend.
// Requires: Node 18+ (native fetch, FormData, Blob) and a running server.
//
//   node tests/api-test.js
//   API_URL=http://localhost:5000/api node tests/api-test.js

"use strict";

const BASE_URL = process.env.API_URL || "http://localhost:5000/api";

const ADMIN_EMAIL = `test-admin-${Date.now()}@example.com`;
const ADMIN_PASS = "test-admin-password-12345";
const ANNOTATOR_EMAIL = `test-annotator-${Date.now()}@example.com`;
const ANNOTATOR_PASS = "test-annotator-password-12345";

const ctx = {
  adminToken: null,
  annotatorToken: null,
  adminId: null,
  annotatorId: null,
  datasetId: null,
  datasetName: null,
  duplicateDatasetId: null,
  commentId: null,
  manualCommentId: null,
  taxonomyId: null,
};

const results = [];
let passed = 0;
let failed = 0;

// ---------------------------------------------------------------------------
// HTTP helper
// ---------------------------------------------------------------------------

async function request(method, path, { token, body, formData } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;

  let fetchBody;
  if (formData) {
    fetchBody = formData;
  } else if (body !== undefined) {
    headers["Content-Type"] = "application/json";
    fetchBody = JSON.stringify(body);
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: fetchBody,
  });

  // --- fix: capture raw bytes so we can check the UTF-8 BOM, which fetch's
  // .text() strips by spec. ---
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get("content-type") || "";

  let data;
  if (ct.includes("application/json")) data = JSON.parse(buf.toString("utf8"));
  else if (ct.includes("text/") || ct.includes("ndjson")) data = buf.toString("utf8");
  else data = buf;

  return { status: res.status, ok: res.ok, data, raw: buf, headers: res.headers };
}

function expect(cond, msg) {
  if (!cond) throw new Error(msg);
}

function expectStatus(res, expected, label = "") {
  if (res.status !== expected) {
    throw new Error(
      `${label}expected HTTP ${expected}, got ${res.status} — ${JSON.stringify(res.data).slice(0, 240)}`,
    );
  }
}

async function check(name, fn) {
  process.stdout.write(`  • ${name} ... `);
  try {
    const result = await fn();
    passed++;
    results.push({ name, status: "PASS" });
    console.log("✅");
    return result;
  } catch (err) {
    failed++;
    results.push({ name, status: "FAIL", error: err.message });
    console.log(`❌  ${err.message}`);
    return null;
  }
}

function section(title) {
  console.log(`\n━━━ ${title} ━━━`);
}

function hasBom(buf) {
  return buf && buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf;
}

// ---------------------------------------------------------------------------
// Sample CSV payload
// ---------------------------------------------------------------------------

function buildSampleCsv() {
  const lines = ["id,comment_text,sentiment,type"];
  const rows = [
    ["1", "Great product, really love it!", "positive", "english"],
    ["2", "একদম খারাপ অভিজ্ঞতা", "negative", "bangla"],
    ["3", "Not sure yet, still testing", "neutral", "english"],
    ["4", "Mised entry, no annotation", "", "english"],
    ["5", "আরেকটা রিভিউ", "negative", "bangla"],
    ["6", "Valo lage", "positive", "banglish"],
    ["7", "Medium quality", "neutral", "english"],
    ["8", "Aro ekta", "positive", "banglish"],
    ["9", "Bhalo na", "negative", "banglish"],
    ["10", "Excellent service", "positive", "english"],
    ["1", "Dup row", "negative", "english"],
    ["11", "", "positive", "english"],
  ];
  for (const r of rows) {
    lines.push(r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
  }
  return lines.join("\n") + "\n";
}

function csvFormData(name = "Test Dataset") {
  const fd = new FormData();
  fd.append("file", new Blob([buildSampleCsv()], { type: "text/csv" }), "test.csv");
  fd.append("name", name);
  fd.append("dedupeStrategy", "skip");
  return fd;
}

// ---------------------------------------------------------------------------
// Poll helper
// ---------------------------------------------------------------------------

async function pollDatasetUntilDone(id, { timeoutMs = 60000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await request("GET", `/datasets/${id}`, { token: ctx.adminToken });
    expectStatus(res, 200, "poll /datasets/:id ");
    const status = res.data.dataset?.status;
    if (status === "completed" || status === "failed") return res.data.dataset;
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error("import did not finish within timeout");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log(`\nTesting API at ${BASE_URL}\n`);
  console.log(`Admin email:     ${ADMIN_EMAIL}`);
  console.log(`Annotator email: ${ANNOTATOR_EMAIL}`);

  // =========================================================================
  section("Bootstrap & Auth");
  // =========================================================================

  const bootstrapStatus = await check("GET /auth/bootstrap-status", async () => {
    const res = await request("GET", "/auth/bootstrap-status");
    expectStatus(res, 200);
    expect(res.data.success === true, "success !== true");
    expect(typeof res.data.adminCount === "number", "adminCount not a number");
    return res.data;
  });

  if (bootstrapStatus && bootstrapStatus.adminCount === 0) {
    await check("POST /auth/bootstrap (creates first admin)", async () => {
      const res = await request("POST", "/auth/bootstrap", {
        body: {
          name: "Test Admin",
          email: ADMIN_EMAIL,
          password: ADMIN_PASS,
          confirmPassword: ADMIN_PASS,
        },
      });
      expectStatus(res, 200);
      expect(res.data.success === true, "success !== true");
      expect(res.data.userId, "no userId returned");
      ctx.adminId = res.data.userId;
    });
  } else {
    console.log("  • bootstrap skipped (admin already exists) — will use an existing admin if available");
  }

  await check("POST /auth/login (admin)", async () => {
    const email = ctx.adminId ? ADMIN_EMAIL : process.env.TEST_ADMIN_EMAIL;
    const password = ctx.adminId ? ADMIN_PASS : process.env.TEST_ADMIN_PASSWORD;
    if (!email) throw new Error("no admin credentials available — set TEST_ADMIN_EMAIL/TEST_ADMIN_PASSWORD or reset DB");

    const res = await request("POST", "/auth/login", { body: { email, password } });
    expectStatus(res, 200);
    expect(res.data.success === true, "success !== true");
    expect(typeof res.data.token === "string", "no token");
    expect(res.data.user && res.data.user._id, "no user object");
    ctx.adminToken = res.data.token;
    ctx.adminId = res.data.user._id;
  });

  await check("GET /auth/me", async () => {
    const res = await request("GET", "/auth/me", { token: ctx.adminToken });
    expectStatus(res, 200);
    expect(res.data.user?.role === "admin", "role mismatch");
  });

  // =========================================================================
  section("User Management (admin)");
  // =========================================================================

  await check("POST /users (create annotator)", async () => {
    const res = await request("POST", "/users", {
      token: ctx.adminToken,
      body: {
        name: "Test Annotator",
        email: ANNOTATOR_EMAIL,
        password: ANNOTATOR_PASS,
        role: "annotator",
      },
    });
    expectStatus(res, 201);
    expect(res.data.userId, "no userId");
    ctx.annotatorId = res.data.userId;
  });

  await check("GET /users", async () => {
    const res = await request("GET", "/users", { token: ctx.adminToken });
    expectStatus(res, 200);
    expect(Array.isArray(res.data.users), "users not array");
    expect(res.data.users.length >= 2, "expected at least 2 users");
    const u = res.data.users[0];
    expect(!("password" in u), "password leaked in /users");
  });

  await check("GET /users/:id", async () => {
    const res = await request("GET", `/users/${ctx.annotatorId}`, { token: ctx.adminToken });
    expectStatus(res, 200);
    expect(res.data.user?.email === ANNOTATOR_EMAIL, "wrong user returned");
  });

  await check("PATCH /users/:id (rename)", async () => {
    const res = await request("PATCH", `/users/${ctx.annotatorId}`, {
      token: ctx.adminToken,
      body: { name: "Annotator Renamed" },
    });
    expectStatus(res, 200);
    expect(res.data.user?.name === "Annotator Renamed", "name not updated");
  });

  await check("PATCH /users/:id/status (deactivate then reactivate)", async () => {
    const off = await request("PATCH", `/users/${ctx.annotatorId}/status`, { token: ctx.adminToken });
    expectStatus(off, 200);
    expect(off.data.isActive === false, "should be inactive");

    const on = await request("PATCH", `/users/${ctx.annotatorId}/status`, { token: ctx.adminToken });
    expectStatus(on, 200);
    expect(on.data.isActive === true, "should be active");
  });

  await check("POST /users/:id/reset-password", async () => {
    const res = await request("POST", `/users/${ctx.annotatorId}/reset-password`, {
      token: ctx.adminToken,
      body: { newPassword: ANNOTATOR_PASS, confirmPassword: ANNOTATOR_PASS },
    });
    expectStatus(res, 200);
  });

  // =========================================================================
  section("Taxonomies");
  // =========================================================================

  await check("GET /taxonomies/defaults", async () => {
    const res = await request("GET", "/taxonomies/defaults", { token: ctx.adminToken });
    expectStatus(res, 200);
    expect(Array.isArray(res.data.defaults?.sentiment), "no sentiment defaults");
    expect(Array.isArray(res.data.defaults?.type), "no type defaults");
  });

  await check("POST /taxonomies", async () => {
    const res = await request("POST", "/taxonomies", {
      token: ctx.adminToken,
      body: {
        name: "Test Taxonomy " + Date.now(),
        description: "created by api-test",
        sentiment: [
          { label: "Positive", order: 0 },
          { label: "Negative", order: 1 },
          { label: "Neutral", order: 2 },
        ],
        type: [
          { label: "Bangla", order: 0 },
          { label: "English", order: 1 },
          { label: "Banglish", order: 2 },
        ],
      },
    });
    expectStatus(res, 201);
    expect(res.data.taxonomyId, "no taxonomyId");
    ctx.taxonomyId = res.data.taxonomyId;
  });

  await check("GET /taxonomies", async () => {
    const res = await request("GET", "/taxonomies", { token: ctx.adminToken });
    expectStatus(res, 200);
    expect(Array.isArray(res.data.taxonomies), "taxonomies not array");
    expect(res.data.taxonomies.length >= 1, "expected at least 1 taxonomy");
  });

  await check("GET /taxonomies/:id", async () => {
    const res = await request("GET", `/taxonomies/${ctx.taxonomyId}`, { token: ctx.adminToken });
    expectStatus(res, 200);
    expect(res.data.taxonomy?.id === ctx.taxonomyId, "id mismatch");
    const values = res.data.taxonomy.sentiment.map((s) => s.value);
    expect(values.includes("unannotated"), "unannotated sentinel missing");
  });

  await check("PATCH /taxonomies/:id (update description)", async () => {
    const res = await request("PATCH", `/taxonomies/${ctx.taxonomyId}`, {
      token: ctx.adminToken,
      body: { description: "updated by api-test" },
    });
    expectStatus(res, 200);
  });

  // =========================================================================
  section("Dataset preview + import");
  // =========================================================================

  await check("POST /datasets/preview", async () => {
    const res = await request("POST", "/datasets/preview", {
      token: ctx.adminToken,
      formData: csvFormData(),
    });
    expectStatus(res, 200);
    const p = res.data.preview;
    expect(p, "no preview returned");
    expect(p.totalRows === 12, `expected 12 rows, got ${p.totalRows}`);
    expect(p.duplicates >= 1, "expected at least one duplicate");
    expect(p.missingIdOrText >= 1, "expected at least one missing-text row");
    expect(Array.isArray(p.sample), "sample not array");
    expect(typeof p.checksum === "string" && p.checksum.length === 64, "bad checksum");
  });

  await check("POST /datasets/import", async () => {
    const res = await request("POST", "/datasets/import", {
      token: ctx.adminToken,
      formData: csvFormData("Test Dataset " + Date.now()),
    });
    expectStatus(res, 202);
    expect(res.data.datasetId, "no datasetId");
    ctx.datasetId = res.data.datasetId;
    ctx.datasetName = res.data.name;
  });

  await check("poll GET /datasets/:id → status=completed", async () => {
    const ds = await pollDatasetUntilDone(ctx.datasetId);
    expect(ds.status === "completed", `import failed: ${JSON.stringify(ds.importError)}`);
    expect(ds.importedRows >= 9, `importedRows too low (${ds.importedRows})`);
  });

  // =========================================================================
  section("Dataset operations");
  // =========================================================================

  await check("GET /datasets/stats", async () => {
    const res = await request("GET", "/datasets/stats", { token: ctx.adminToken });
    expectStatus(res, 200);
    expect(typeof res.data.stats.totalDatasets === "number", "no totalDatasets");
    expect(res.data.stats.datasetsByStatus, "no datasetsByStatus");
  });

  await check("GET /datasets", async () => {
    const res = await request("GET", "/datasets", { token: ctx.adminToken });
    expectStatus(res, 200);
    expect(Array.isArray(res.data.datasets), "datasets not array");
    const found = res.data.datasets.find((d) => d._id === ctx.datasetId);
    expect(found, "newly-imported dataset missing from list");
    expect(found._id, "_id alias missing from list result");
  });

  await check("GET /datasets?includeCounts=true", async () => {
    const res = await request("GET", "/datasets?includeCounts=true", { token: ctx.adminToken });
    expectStatus(res, 200);
    const found = res.data.datasets.find((d) => d._id === ctx.datasetId);
    expect(found, "dataset missing");
    expect(found.summary, "no summary");
    expect(typeof found.summary.total === "number", "summary.total not a number");
  });

  await check("GET /datasets/:id", async () => {
    const res = await request("GET", `/datasets/${ctx.datasetId}`, { token: ctx.adminToken });
    expectStatus(res, 200);
    expect(res.data.dataset?._id ?? res.data.dataset?.id, "no dataset id");
    expect(res.data.summary, "no summary for completed dataset");
  });

  await check("PATCH /datasets/:id (rename)", async () => {
    const newName = "Renamed " + Date.now();
    const res = await request("PATCH", `/datasets/${ctx.datasetId}`, {
      token: ctx.adminToken,
      body: { name: newName },
    });
    expectStatus(res, 200);
    ctx.datasetName = newName;
  });

  await check("PATCH /datasets/:id/assign (annotator)", async () => {
    const res = await request("PATCH", `/datasets/${ctx.datasetId}/assign`, {
      token: ctx.adminToken,
      body: { assignedTo: ctx.annotatorId },
    });
    expectStatus(res, 200);
  });

  await check("POST /datasets/:id/duplicate", async () => {
    const res = await request("POST", `/datasets/${ctx.datasetId}/duplicate`, {
      token: ctx.adminToken,
      body: {},
    });
    expectStatus(res, 201);
    expect(res.data.datasetId, "no duplicate datasetId");
    expect(typeof res.data.copiedComments === "number", "no copiedComments");
    ctx.duplicateDatasetId = res.data.datasetId;
  });

  // =========================================================================
  section("Comments CRUD");
  // =========================================================================

  await check("GET /comments?datasetId=...", async () => {
    const res = await request("GET", `/comments?datasetId=${ctx.datasetId}`, { token: ctx.adminToken });
    expectStatus(res, 200);
    expect(Array.isArray(res.data.comments), "comments not array");
    expect(res.data.total >= 9, `expected >= 9 comments, got ${res.data.total}`);
    ctx.commentId = res.data.comments[0].id;
  });

  await check("POST /comments (manual create)", async () => {
    const res = await request("POST", "/comments", {
      token: ctx.adminToken,
      body: {
        datasetId: ctx.datasetId,
        sourceId: "manual-" + Date.now(),
        commentText: "Manual comment created by api-test",
        sentiment: "positive",
        type: "english",
      },
    });
    expectStatus(res, 201);
    expect(res.data.commentId, "no commentId");
    ctx.manualCommentId = res.data.commentId;
  });

  await check("POST /comments (duplicate sourceId → 409)", async () => {
    const src = "dup-check-" + Date.now();
    const first = await request("POST", "/comments", {
      token: ctx.adminToken,
      body: { datasetId: ctx.datasetId, sourceId: src, commentText: "a" },
    });
    expectStatus(first, 201);
    const second = await request("POST", "/comments", {
      token: ctx.adminToken,
      body: { datasetId: ctx.datasetId, sourceId: src, commentText: "b" },
    });
    expect(second.status === 409, `expected 409, got ${second.status}`);
  });

  await check("GET /comments/:id", async () => {
    const res = await request("GET", `/comments/${ctx.commentId}`, { token: ctx.adminToken });
    expectStatus(res, 200);
    expect(res.data.comment?.id === ctx.commentId, "id mismatch");
  });

  await check("PATCH /comments/:id (update text)", async () => {
    const res = await request("PATCH", `/comments/${ctx.commentId}`, {
      token: ctx.adminToken,
      body: { commentText: "Updated text by api-test" },
    });
    expectStatus(res, 200);
    expect(typeof res.data.version === "number", "no version bumped");
  });

  // =========================================================================
  section("Annotation");
  // =========================================================================

  await check("PATCH /comments/:id/annotation", async () => {
    const res = await request("PATCH", `/comments/${ctx.commentId}/annotation`, {
      token: ctx.adminToken,
      body: { sentiment: "negative", type: "bangla", annotationNote: "test note" },
    });
    expectStatus(res, 200);
    expect(typeof res.data.version === "number", "no version");
  });

  await check("POST /comments/bulk-annotate", async () => {
    const list = await request("GET", `/comments?datasetId=${ctx.datasetId}&limit=5`, {
      token: ctx.adminToken,
    });
    const ids = list.data.comments.map((c) => c.id);
    const res = await request("POST", "/comments/bulk-annotate", {
      token: ctx.adminToken,
      body: { ids, sentiment: "positive", type: "english" },
    });
    expectStatus(res, 200);
    expect(typeof res.data.updated === "number", "no updated count");
    expect(res.data.requested === ids.length, "requested mismatch");
  });

  await check("POST /comments/bulk-assign", async () => {
    const list = await request("GET", `/comments?datasetId=${ctx.datasetId}&limit=3`, {
      token: ctx.adminToken,
    });
    const ids = list.data.comments.map((c) => c.id);
    const res = await request("POST", "/comments/bulk-assign", {
      token: ctx.adminToken,
      body: { ids, assignedTo: ctx.annotatorId },
    });
    expectStatus(res, 200);
    expect(typeof res.data.updated === "number", "no updated count");
  });

  // =========================================================================
  section("Version history");
  // =========================================================================

  await check("GET /comments/:id/versions", async () => {
    const res = await request("GET", `/comments/${ctx.commentId}/versions`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    expect(Array.isArray(res.data.versions), "versions not array");
    expect(res.data.versions.length >= 2, "expected at least 2 versions");
    const v = res.data.versions[0];
    expect(v.snapshot, "version missing snapshot");
    expect(v.changeType, "version missing changeType");
  });

  await check("POST /comments/:id/restore/:version", async () => {
    const versions = await request("GET", `/comments/${ctx.commentId}/versions`, {
      token: ctx.adminToken,
    });
    const target = versions.data.versions[versions.data.versions.length - 1].version;
    const res = await request("POST", `/comments/${ctx.commentId}/restore/${target}`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    expect(typeof res.data.newVersion === "number", "no newVersion");
    expect(res.data.restoredFrom === target, "restoredFrom mismatch");
  });

  // =========================================================================
  section("Taxonomy ↔ dataset binding");
  // =========================================================================

  await check("PATCH /taxonomies/:id/assign/:datasetId", async () => {
    const res = await request("PATCH", `/taxonomies/${ctx.taxonomyId}/assign/${ctx.datasetId}`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
  });

  await check("GET /taxonomies/for-dataset/:datasetId", async () => {
    const res = await request("GET", `/taxonomies/for-dataset/${ctx.datasetId}`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    expect(res.data.taxonomyId === ctx.taxonomyId, "taxonomy not attached");
    expect(Array.isArray(res.data.sentiment), "sentiment not array");
  });

  await check("DELETE /taxonomies/:id/assign/:datasetId", async () => {
    const res = await request("DELETE", `/taxonomies/${ctx.taxonomyId}/assign/${ctx.datasetId}`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
  });

  // --- regression guard: after unassign, dataset reads must still work ---
  await check("GET /datasets/:id (after taxonomy unassign)", async () => {
    const res = await request("GET", `/datasets/${ctx.datasetId}`, { token: ctx.adminToken });
    expectStatus(res, 200);
    expect(res.data.dataset.taxonomyId === null, "taxonomyId should be null after unassign");
  });

  // =========================================================================
  section("Exports");
  // =========================================================================

  await check("GET /comments/export?format=csv", async () => {
    const res = await request("GET", `/comments/export?format=csv&datasetId=${ctx.datasetId}`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    // --- fix: check the raw bytes, not fetch's BOM-stripped .text() ---
    expect(hasBom(res.raw), "CSV missing UTF-8 BOM (checked raw bytes)");
    const text = res.raw.toString("utf8");
    expect(text.split("\r\n").length > 1, "CSV has no rows");
    expect(
      res.headers.get("content-disposition")?.includes("attachment"),
      "no attachment header",
    );
  });

  await check("GET /comments/export?format=xlsx", async () => {
    const res = await request("GET", `/comments/export?format=xlsx&datasetId=${ctx.datasetId}`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    expect(
      res.headers.get("content-type")?.includes("spreadsheetml"),
      "wrong xlsx content-type",
    );
    expect(res.raw.length > 100, "xlsx body suspiciously small");
  });

  // =========================================================================
  section("Analytics");
  // =========================================================================

  await check("GET /analytics/dataset/:id", async () => {
    const res = await request("GET", `/analytics/dataset/${ctx.datasetId}`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    expect(res.data.overview, "no overview");
    expect(res.data.sentiment?.distribution, "no sentiment distribution");
    expect(res.data.readiness?.level, "no readiness level");
    expect(Array.isArray(res.data.warnings), "warnings not array");
  });

  await check("GET /analytics/global", async () => {
    const res = await request("GET", "/analytics/global", { token: ctx.adminToken });
    expectStatus(res, 200);
    expect(res.data.overview, "no global overview");
    expect(Array.isArray(res.data.activityLast14Days), "no activity timeline");
    expect(res.data.activityLast14Days.length === 14, "timeline not 14 days");
  });

  await check("GET /analytics/dataset/:id/export-ml?format=jsonl", async () => {
    const res = await request(
      "GET",
      `/analytics/dataset/${ctx.datasetId}/export-ml?format=jsonl&split=0.8,0.1,0.1`,
      { token: ctx.adminToken },
    );
    expectStatus(res, 200);
    const text = res.raw.toString("utf8");
    const lines = text.trim().split("\n").filter(Boolean);
    expect(lines.length >= 1, "no ML lines");
    const obj = JSON.parse(lines[0]);
    for (const k of ["id", "text", "sentiment", "type", "split", "dataset", "taxonomy"]) {
      expect(k in obj, `ML jsonl missing key: ${k}`);
    }
  });

  await check("GET /analytics/dataset/:id/export-ml?format=csv", async () => {
    const res = await request(
      "GET",
      `/analytics/dataset/${ctx.datasetId}/export-ml?format=csv`,
      { token: ctx.adminToken },
    );
    expectStatus(res, 200);
    // --- fix: byte-level BOM check ---
    expect(hasBom(res.raw), "ML CSV missing BOM (checked raw bytes)");
  });

  // =========================================================================
  section("Audit log");
  // =========================================================================

  await check("GET /audit", async () => {
    const res = await request("GET", "/audit?limit=20", { token: ctx.adminToken });
    expectStatus(res, 200);
    expect(Array.isArray(res.data.entries), "entries not array");
    expect(res.data.entries.length >= 1, "no audit entries");
    const e = res.data.entries[0];
    expect(e.action, "audit entry missing action");
  });

  await check("GET /audit/actions", async () => {
    const res = await request("GET", "/audit/actions", { token: ctx.adminToken });
    expectStatus(res, 200);
    expect(Array.isArray(res.data.actions), "actions not array");
    expect(res.data.actions.includes("auth.login"), "auth.login not in actions");
  });

  // =========================================================================
  section("Annotator role scoping");
  // =========================================================================

  await check("POST /auth/login (annotator)", async () => {
    const res = await request("POST", "/auth/login", {
      body: { email: ANNOTATOR_EMAIL, password: ANNOTATOR_PASS },
    });
    expectStatus(res, 200);
    expect(res.data.user?.role === "annotator", "wrong role");
    ctx.annotatorToken = res.data.token;
  });

  await check("GET /datasets as annotator (only assigned)", async () => {
    const res = await request("GET", "/datasets", { token: ctx.annotatorToken });
    expectStatus(res, 200);
    const ids = res.data.datasets.map((d) => d._id);
    expect(ids.includes(ctx.datasetId), "assigned dataset not visible to annotator");
  });

  await check("GET /users as annotator (should 403)", async () => {
    const res = await request("GET", "/users", { token: ctx.annotatorToken });
    expect(res.status === 403, `expected 403, got ${res.status}`);
  });

  await check("GET /analytics/global as annotator (should 403)", async () => {
    const res = await request("GET", "/analytics/global", { token: ctx.annotatorToken });
    expect(res.status === 403, `expected 403, got ${res.status}`);
  });

  // =========================================================================
  section("Cleanup");
  // =========================================================================

  await check("DELETE /datasets/:id (duplicate)", async () => {
    const res = await request("DELETE", `/datasets/${ctx.duplicateDatasetId}`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    expect(typeof res.data.deletedComments === "number", "no deletedComments");
  });

  await check("DELETE /comments/:id (manual)", async () => {
    const res = await request("DELETE", `/comments/${ctx.manualCommentId}`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
  });

  // --- fix: unassign is now a checked step (used to fail silently, which
  // caused the user-delete below to 400 with "has 1 dataset assigned") ---
  await check("PATCH /datasets/:id/assign (unassign before user delete)", async () => {
    const res = await request("PATCH", `/datasets/${ctx.datasetId}/assign`, {
      token: ctx.adminToken,
      body: { assignedTo: null },
    });
    expectStatus(res, 200);
    expect(res.data.success === true, "success !== true");
  });

  await check("DELETE /users/:id (annotator)", async () => {
    const res = await request("DELETE", `/users/${ctx.annotatorId}`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
  });

  // =========================================================================
  // Summary
  // =========================================================================

  console.log("\n═══════════════════════════════════════════════");
  console.log(` Results:  ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log("═══════════════════════════════════════════════\n");

  if (failed > 0) {
    console.log("Failures:");
    for (const r of results.filter((r) => r.status === "FAIL")) {
      console.log(`  ❌ ${r.name}`);
      console.log(`     ${r.error}`);
    }
    console.log("");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n💥 Fatal:", err);
  process.exit(1);
});