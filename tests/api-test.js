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

/** A minimal valid PNG header for the given dimensions — enough to probe. */
function pngBytes(width, height) {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
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
  section("Media domain · label sets");
  // =========================================================================

  await check("POST /media/label-sets (create)", async () => {
    const res = await request("POST", "/media/label-sets", {
      token: ctx.adminToken,
      body: {
        name: "Road Signs",
        description: "signs and markings",
        labels: [
          { label: "Stop Sign" },
          { label: "Traffic Light" },
        ],
      },
    });
    expectStatus(res, 201);
    expect(res.data.success === true, "success !== true");
    const set = res.data.data;
    expect(set.id, "no id returned");
    // Slugs are what the exporters use, so they are part of the contract.
    expect(
      JSON.stringify(set.labels.map((l) => l.value)) ===
        JSON.stringify(["stop_sign", "traffic_light"]),
      `unexpected slugs: ${JSON.stringify(set.labels)}`,
    );
    expect(set._id === set.id, "_id alias missing");
    ctx.labelSetId = set.id;
  });

  await check("POST /media/label-sets as annotator (should 403)", async () => {
    const res = await request("POST", "/media/label-sets", {
      token: ctx.annotatorToken,
      body: { name: "Nope", labels: [{ label: "x" }] },
    });
    expect(res.status === 403, `expected 403, got ${res.status}`);
  });

  await check("POST /media/label-sets with a duplicate slug (should 400)", async () => {
    const res = await request("POST", "/media/label-sets", {
      token: ctx.adminToken,
      body: { name: "Dupes", labels: [{ label: "Cat" }, { label: "cat" }] },
    });
    expect(res.status === 400, `expected 400, got ${res.status}`);
  });

  await check("POST /media/label-sets with no labels (should 400)", async () => {
    const res = await request("POST", "/media/label-sets", {
      token: ctx.adminToken,
      body: { name: "Empty", labels: [] },
    });
    expect(res.status === 400, `expected 400, got ${res.status}`);
  });

  await check("GET /media/label-sets (list)", async () => {
    const res = await request("GET", "/media/label-sets", { token: ctx.adminToken });
    expectStatus(res, 200);
    const list = res.data.data;
    expect(Array.isArray(list), "label set list is not an array");
    expect(list.some((s) => s.id === ctx.labelSetId), "created label set missing from list");
  });

  // =========================================================================
  section("Media domain · datasets & upload");
  // =========================================================================

  await check("POST /media/datasets (create)", async () => {
    ctx.mediaDatasetName = `Media DS ${Date.now()}`;
    const res = await request("POST", "/media/datasets", {
      token: ctx.adminToken,
      body: {
        name: ctx.mediaDatasetName,
        mediaKind: "image",
        labelSetId: ctx.labelSetId,
        description: "api test",
      },
    });
    expectStatus(res, 201);
    const ds = res.data.data;
    expect(ds.id, "no id");
    expect(ds.status === "active", `unexpected status ${ds.status}`);
    expect(ds.totalAssets === 0, "new dataset should have no assets");
    expect(ds.mediaKind === "image", `unexpected mediaKind ${ds.mediaKind}`);
    expect(ds.labelSetId === ctx.labelSetId, "label set not bound at create time");
    expect(ds._id === ds.id, "_id alias missing");
    ctx.mediaDatasetId = ds.id;
  });

  await check("POST /media/datasets (a duplicate name is allowed)", async () => {
    // Dataset names are not unique in this API, in the text domain either —
    // only asset checksums are. Asserted so nobody later assumes otherwise.
    const res = await request("POST", "/media/datasets", {
      token: ctx.adminToken,
      body: { name: ctx.mediaDatasetName, mediaKind: "image" },
    });
    expectStatus(res, 201);
    const dup = await request("DELETE", `/media/datasets/${res.data.data.id}`, {
      token: ctx.adminToken,
    });
    expectStatus(dup, 200);
  });
  await check("POST /media/datasets as annotator (should 403)", async () => {
    const res = await request("POST", "/media/datasets", {
      token: ctx.annotatorToken,
      body: { name: "Nope", mediaKind: "image" },
    });
    expect(res.status === 403, `expected 403, got ${res.status}`);
  });

  await check("GET /media/datasets without a token (should 401)", async () => {
    const res = await request("GET", "/media/datasets");
    expect(res.status === 401, `expected 401, got ${res.status}`);
  });

  await check("GET /media/datasets (list)", async () => {
    const res = await request("GET", "/media/datasets", { token: ctx.adminToken });
    expectStatus(res, 200);
    const list = res.data.data.datasets;
    expect(Array.isArray(list), "dataset list is not an array");
    expect(list.some((d) => d.id === ctx.mediaDatasetId), "created dataset missing");
  });

  await check("GET /media/datasets/:id (detail)", async () => {
    const res = await request("GET", `/media/datasets/${ctx.mediaDatasetId}`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    expect(res.data.data.labelSetId === ctx.labelSetId, "label set not bound");
  });

  await check("POST /media/datasets/:id/assets (upload two PNGs)", async () => {
    const fd = new FormData();
    fd.append("files", new Blob([pngBytes(640, 480)], { type: "image/png" }), "a.png");
    fd.append("files", new Blob([pngBytes(800, 600)], { type: "image/png" }), "b.png");
    const res = await request("POST", `/media/datasets/${ctx.mediaDatasetId}/assets`, {
      token: ctx.adminToken,
      formData: fd,
    });
    expectStatus(res, 201);
    const { stored, failed } = res.data.data;
    expect(failed.length === 0, `unexpected rejections: ${JSON.stringify(failed)}`);
    expect(stored.length === 2, `expected 2 assets, got ${stored.length}`);
    ctx.mediaAssetA = stored.find((a) => a.originalFileName === "a.png");
  });

  await check("upload probed image dimensions", async () => {
    const res = await request("GET", `/media/assets/${ctx.mediaAssetA.id}`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    const a = res.data.data;
    expect(a.width === 640 && a.height === 480, `bad dimensions ${a.width}x${a.height}`);
    expect(a.sizeBytes > 0, "size not recorded");
    expect(!("storagePath" in a), "storagePath must never reach the client");
    expect(a.fileUrl === `/api/media/assets/${a.id}/file`, "fileUrl is wrong");
  });

  await check("upload rejected a disallowed extension", async () => {
    const fd = new FormData();
    fd.append("files", new Blob([Buffer.from("MZ "), ], { type: "image/png" }), "bad.exe");
    const res = await request("POST", `/media/datasets/${ctx.mediaDatasetId}/assets`, {
      token: ctx.adminToken,
      formData: fd,
    });
    expect(res.status === 400, `expected 400 for a .exe upload, got ${res.status}`);
  });

  await check("duplicate upload rejected, and no orphan file left behind", async () => {
    const before = await request("GET", `/media/datasets/${ctx.mediaDatasetId}`, {
      token: ctx.adminToken,
    });
    const fd = new FormData();
    fd.append("files", new Blob([pngBytes(640, 480)], { type: "image/png" }), "a-copy.png");
    const res = await request("POST", `/media/datasets/${ctx.mediaDatasetId}/assets`, {
      token: ctx.adminToken,
      formData: fd,
    });
    // 207, not 409: a folder upload is a batch, so one rejected file is a
    // partial success the client has to be told about rather than a hard fail.
    expectStatus(res, 207);
    expect(res.data.data.stored.length === 0, "a duplicate was stored anyway");
    expect(res.data.data.failed.length === 1, "the duplicate was not reported as failed");
    const after = await request("GET", `/media/datasets/${ctx.mediaDatasetId}`, {
      token: ctx.adminToken,
    });
    expect(
      after.data.data.totalAssets === before.data.data.totalAssets,
      "a rejected duplicate still created an asset row",
    );
  });

  // =========================================================================
  section("Media domain · file streaming");
  // =========================================================================

  await check("GET /media/assets/:id/file (full body)", async () => {
    const res = await request("GET", `/media/assets/${ctx.mediaAssetA.id}/file`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    expect(Buffer.isBuffer(res.data), "file response is not binary");
    expect(res.data.length > 0, "empty file body");
  });

  await check("GET file without a token (should 401)", async () => {
    const res = await request("GET", `/media/assets/${ctx.mediaAssetA.id}/file`);
    expect(res.status === 401, `expected 401, got ${res.status}`);
  });

  await check("GET file with a Range header (206 partial content)", async () => {
    const res = await fetch(`${BASE_URL}/media/assets/${ctx.mediaAssetA.id}/file`, {
      headers: { Authorization: `Bearer ${ctx.adminToken}`, Range: "bytes=0-15" },
    });
    expect(res.status === 206, `expected 206, got ${res.status}`);
    expect(
      (res.headers.get("content-range") || "").startsWith("bytes 0-15/"),
      `bad content-range: ${res.headers.get("content-range")}`,
    );
    const body = Buffer.from(await res.arrayBuffer());
    expect(body.length === 16, `expected 16 bytes, got ${body.length}`);
    expect(body.equals(pngBytes(640, 480).subarray(0, 16)), "range bytes do not match the file");
  });

  await check("GET file with an unsatisfiable Range (416)", async () => {
    const res = await fetch(`${BASE_URL}/media/assets/${ctx.mediaAssetA.id}/file`, {
      headers: { Authorization: `Bearer ${ctx.adminToken}`, Range: "bytes=99999999-" },
    });
    expect(res.status === 416, `expected 416, got ${res.status}`);
  });

  await check("GET file for an unknown asset (should 404)", async () => {
    const res = await request("GET", "/media/assets/000000000000000000000000/file", {
      token: ctx.adminToken,
    });
    expect(res.status === 404, `expected 404, got ${res.status}`);
  });

  // The 410 path (a row whose bytes are gone from disk) is not reachable
  // through the API, so it is not asserted here; config/media.js's `exists`
  // behaviour is covered by the unit suite.

  // =========================================================================
  section("Media domain · annotations");
  // =========================================================================

  await check("POST /media/assets/:id/annotations (bbox)", async () => {
    const res = await request("POST", `/media/assets/${ctx.mediaAssetA.id}/annotations`, {
      token: ctx.adminToken,
      body: {
        kind: "bbox",
        label: "stop_sign",
        box: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 },
      },
    });
    expectStatus(res, 201);
    const a = res.data.data;
    expect(a.box.x === 0.1, "box not stored normalised");
    expect(a.boxPixels, "boxPixels not derived");
    // 0.1 * 640 = 64, 0.2 * 480 = 96.
    expect(a.boxPixels.x === 64 && a.boxPixels.y === 96, `bad pixel box ${JSON.stringify(a.boxPixels)}`);
    expect(a._id === a.id, "_id alias missing");
    ctx.mediaAnnotationId = a.id;
  });

  await check("POST annotation with a label outside the label set (should 400)", async () => {
    const res = await request("POST", `/media/assets/${ctx.mediaAssetA.id}/annotations`, {
      token: ctx.adminToken,
      body: { kind: "bbox", label: "not_in_set", box: { x: 0, y: 0, width: 0.5, height: 0.5 } },
    });
    expect(res.status === 400, `expected 400, got ${res.status}`);
  });

  await check("POST annotation with a zero-area box (should 400)", async () => {
    const res = await request("POST", `/media/assets/${ctx.mediaAssetA.id}/annotations`, {
      token: ctx.adminToken,
      body: { kind: "bbox", label: "stop_sign", box: { x: 0, y: 0, width: 0, height: 0.5 } },
    });
    expect(res.status === 400, `expected 400, got ${res.status}`);
  });

  await check("POST annotation (classification)", async () => {
    const res = await request("POST", `/media/assets/${ctx.mediaAssetA.id}/annotations`, {
      token: ctx.adminToken,
      body: { kind: "classification", label: "traffic_light" },
    });
    expectStatus(res, 201);
    expect(res.data.data.box === null, "a classification must not have a box");
  });

  await check("GET /media/assets/:id/annotations (list)", async () => {
    const res = await request("GET", `/media/assets/${ctx.mediaAssetA.id}/annotations`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    expect(Array.isArray(res.data.data), "annotation list is not an array");
    expect(res.data.data.length === 2, `expected 2 annotations, got ${res.data.data.length}`);
  });

  await check("asset status became annotated once it had annotations", async () => {
    const res = await request("GET", `/media/assets/${ctx.mediaAssetA.id}`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    expect(res.data.data.annotationCount === 2, "wrong annotation count");
    expect(res.data.data.status === "annotated", `status is ${res.data.data.status}`);
  });

  await check("PATCH /media/annotations/:id (update bumps the revision)", async () => {
    const res = await request("PATCH", `/media/annotations/${ctx.mediaAnnotationId}`, {
      token: ctx.adminToken,
      body: { label: "traffic_light" },
    });
    expectStatus(res, 200);
    expect(res.data.data.revision === 2, `expected revision 2, got ${res.data.data.revision}`);
  });

  await check("GET /media/annotations/:id/history (create + update)", async () => {
    const res = await request("GET", `/media/annotations/${ctx.mediaAnnotationId}/history`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    expect(Array.isArray(res.data.data), "history is not an array");
    expect(res.data.data.length === 2, `expected 2 history entries, got ${res.data.data.length}`);
  });

  await check("POST restore on a live annotation (should 400)", async () => {
    // Restore undoes a *delete*. Reverting a live annotation is what PATCH is
    // for, and silently re-creating the row would fork the history.
    const res = await request("POST", `/media/annotations/${ctx.mediaAnnotationId}/restore`, {
      token: ctx.adminToken,
    });
    expect(res.status === 400, `expected 400, got ${res.status}`);
  });

  await check("DELETE /media/annotations/:id", async () => {
    const res = await request("DELETE", `/media/annotations/${ctx.mediaAnnotationId}`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
  });

  await check("the deleted annotation is gone", async () => {
    const res = await request("PATCH", `/media/annotations/${ctx.mediaAnnotationId}`, {
      token: ctx.adminToken,
      body: { label: "stop_sign" },
    });
    expect(res.status === 404, `expected 404, got ${res.status}`);
  });

  await check("the delete was appended to history, not erased", async () => {
    const res = await request("GET", `/media/annotations/${ctx.mediaAnnotationId}/history`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    expect(res.data.data.length === 3, `expected 3 history entries, got ${res.data.data.length}`);
    const latest = res.data.data[0];
    expect(latest.changeType === "delete", `latest change is ${latest.changeType}`);
  });

  await check("asset count fell back after the delete", async () => {
    const res = await request("GET", `/media/assets/${ctx.mediaAssetA.id}`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    expect(res.data.data.annotationCount === 1, `count is ${res.data.data.annotationCount}`);
  });

  await check("POST /media/annotations/:id/restore (appends, does not rewrite)", async () => {
    const res = await request("POST", `/media/annotations/${ctx.mediaAnnotationId}/restore`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 201);
    const restored = res.data.data;
    expect(restored.id !== ctx.mediaAnnotationId, "restore must create a new row");
    expect(restored.revision === 1, `a restored row starts at revision 1, got ${restored.revision}`);
    expect(restored.label === "traffic_light", "restore did not bring back the deleted state");
    ctx.restoredAnnotationId = restored.id;
  });

  await check("the restored annotation's own history starts fresh", async () => {
    const res = await request("GET", `/media/annotations/${ctx.restoredAnnotationId}/history`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    expect(res.data.data.length === 1, `expected 1 entry, got ${res.data.data.length}`);
    expect(res.data.data[0].changeType === "restore", "first entry is not the restore");
  });

  await check("GET /media/datasets/:id/stats", async () => {
    const res = await request("GET", `/media/datasets/${ctx.mediaDatasetId}/stats`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    const s = res.data.data;
    // stats is the annotation/asset breakdown, not a repeat of the dataset row.
    expect(s.totalBoxes === 1, `expected 1 box, got ${s.totalBoxes}`);
    expect(
      s.byStatus.annotated === 1 && s.byStatus.pending === 1,
      `unexpected byStatus ${JSON.stringify(s.byStatus)}`,
    );
    // The histogram counts boxes only, so the classification is not in it.
    expect(
      JSON.stringify(s.labelHistogram) === JSON.stringify([{ label: "traffic_light", count: 1 }]),
      `unexpected histogram ${JSON.stringify(s.labelHistogram)}`,
    );
  });

  await check("GET /media/datasets/:id/annotations", async () => {
    const res = await request("GET", `/media/datasets/${ctx.mediaDatasetId}/annotations`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    expect(Array.isArray(res.data.data.annotations), "not a paged annotation list");
    expect(res.data.data.total === 2, `expected 2 annotations, got ${res.data.data.total}`);
  });

  // =========================================================================
  section("Media domain · exports");
  // =========================================================================

  await check("GET /media/datasets/:id/export?format=coco", async () => {
    const res = await request("GET", `/media/datasets/${ctx.mediaDatasetId}/export?format=coco`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    const c = res.data;
    expect(Array.isArray(c.images), "coco.images missing");
    expect(Array.isArray(c.annotations), "coco.annotations missing");
    expect(c.categories.length === 2, `expected 2 categories, got ${c.categories.length}`);
    const ann = c.annotations[0];
    expect(ann.bbox.length === 4, "coco bbox is not [x,y,w,h]");
    // COCO wants absolute pixels, not the normalised form.
    expect(ann.bbox[0] > 1, "coco bbox looks normalised");
    expect(Math.abs(ann.area - ann.bbox[2] * ann.bbox[3]) < 2, "coco area does not match bbox");
  });

  await check("GET export with an unknown format (should 400)", async () => {
    const res = await request("GET", `/media/datasets/${ctx.mediaDatasetId}/export?format=parquet`, {
      token: ctx.adminToken,
    });
    expect(res.status === 400, `expected 400, got ${res.status}`);
  });

  // =========================================================================
  section("Cleanup");
  // =========================================================================

  await check("DELETE /media/datasets/:id (cascade removes assets and annotations)", async () => {
    const res = await request("DELETE", `/media/datasets/${ctx.mediaDatasetId}`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
    const d = res.data.data;
    expect(d.deletedCount === 1, `expected the dataset row to be deleted, got ${d.deletedCount}`);
    expect(d.assets === 2, `expected 2 assets cascaded, got ${d.assets}`);
    expect(d.annotations === 2, `expected 2 annotations cascaded, got ${d.annotations}`);
  });

  await check("GET the deleted media dataset (should 404)", async () => {
    const res = await request("GET", `/media/datasets/${ctx.mediaDatasetId}`, {
      token: ctx.adminToken,
    });
    expect(res.status === 404, `expected 404, got ${res.status}`);
  });

  await check("GET the deleted asset's file (should 404)", async () => {
    const res = await request("GET", `/media/assets/${ctx.mediaAssetA.id}/file`, {
      token: ctx.adminToken,
    });
    expect(res.status === 404, `expected 404, got ${res.status}`);
  });

  await check("DELETE /media/label-sets/:id", async () => {
    const res = await request("DELETE", `/media/label-sets/${ctx.labelSetId}`, {
      token: ctx.adminToken,
    });
    expectStatus(res, 200);
  });

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