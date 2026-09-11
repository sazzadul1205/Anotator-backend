# Annotator Backend — API Test Results (Round 2: Regression + Hard Test + Pen Test)

- **Date:** 2026-09-11
- **Base URL:** `http://localhost:5000`
- **Target:** `http://localhost:5000/api`
- **Code version tested:** HEAD `c342945` (after "index initialization script" + rewritten routes/server hardening commits). Working tree clean.
- **Method:** Live black-box testing via API Testing MCP + raw curl.
  - **Phase A — Regression:** the exact same 40+ tests as Round 1.
  - **Phase B — Hard tests:** stress, boundary, race conditions, malformed uploads, concurrency.
  - **Phase C — Pen tests:** JWT tampering, NoSQL/SQLi injection, XSS, prototype pollution, mass assignment, IDOR, CORS, header/auth bypass, CSV formula injection, rate-limit bypass.
- **Note:** No application code was modified. All test data created during this run was deleted afterwards (DB restored to only `admin@test.com`).

---

## 1) EXECUTIVE SUMMARY

| Phase | Tests | Pass | Fail / Findings |
|-------|-------|------|-----------------|
| A. Regression (all 25 endpoints, same requests as Round 1) | ~60 requests | ✅ All pass | 0 regressions |
| B. Hard tests | ~25 | ✅ 22 | **3 findings** |
| C. Pen tests | ~30 | ✅ 25 | **5 findings** |

**Overall verdict:** The updated code **passed the entire regression suite — no regressions, all 25 endpoints behave identically to Round 1**. The security hardening you added (global rate limiter, startup import-recovery, centralized error handler, DB-aware health, graceful shutdown, indexes) is working. Several **new robustness/security findings** were uncovered by hard + pen testing (details in §6).

---

## 2) WHAT CHANGED SINCE ROUND 1 (code review)

| Change | Verified |
|--------|----------|
| **DB indexes** — `scripts/init-indexes.js` | ✅ Indexes exist in MongoDB (queried directly): users.email UNIQUE, comments `{datasetId, sourceId}` UNIQUE, `{datasetId,status}`, `{datasetId,sentiment}`, `{datasetId,type}`, `{status,assignedTo}`, `{createdAt:-1}`, **text index on commentText**, `{commentId, version:-1}` |
| **Global rate limiter** (10000/min dev) on `/api` | ✅ Headers `ratelimit-*: 10000;w=60` present on every response |
| **Startup stuck-import recovery** | ✅ Code in place (server.js) |
| **Centralized error handler** | ✅ Present |
| **`/health` now pings DB**, returns 503 on failure | ✅ returns `db: "ok"` |
| **Graceful shutdown** (SIGINT/SIGTERM) | ✅ Present |
| **morgan request logging** + `trust proxy` only in prod | ✅ Present |

---

## 3) PHASE A — REGRESSION (re-run of all Round 1 tests)

All 25 documented endpoints re-tested with identical requests. **Every single one passed**:

- ✅ Health (now with `db:"ok"`), root, 404 route
- ✅ Bootstrap: status (adminCount=1), re-bootstrap rejected (`"Admin account already exists"`)
- ✅ Auth: login, wrong password `401`, inactive user `401`, `/me` with/without/invalid token, logout
- ✅ Users: create annotator (201), list (password excluded), get, update, status toggle off/on, reset-password (new password worked at login), invalid role `400`, duplicate email `400`, reset mismatch `400`, self-status `400`, self-delete `400`, delete nonexistent `404`
- ✅ RBAC: annotator blocked (403) on all admin-only endpoints (list/create users, delete dataset, reset admin password, delete self); annotator can list comments (200)
- ✅ Datasets: import no-file `400`, CSV import (5 rows incl. Bangla) `202` → poll `completed` with summary, list, rename, cascade delete (`deletedComments: 5`)
- ✅ Comments: list + filters, create manual, duplicate sourceId `409`, get, update text (version++), annotate (version++), versions list, restore, delete
- ✅ Export CSV (Bangla intact) / XLSX / invalid format `400`
- ✅ Load test `/api/comments`: **avg 428 ms** (improved from ~535 ms in Round 1)

> **Note:** The login rate limiter (5/15min) was still exhausted from Round 1 at the start; used the Round-1 token until the window expired, then re-tested login fully (including the rate-limit cycle in §5).

**Regression result: 0 failures. The code update introduced no regressions.**

---
## 4) PHASE B — HARD TESTS (stress / boundaries / races)

| # | Test | Result | Verdict |
|---|------|--------|---------|
| H1 | Pagination `page=0&limit=-5` | `200` with **`limit:-5`, `totalPages:-1`** — negative limit accepted | ⚠️ **FINDING B1** |
| H2 | Pagination `page=abc&limit=abc` | `200`, falls back `page:1, limit:50` | ✅ Robust |
| H3 | Pagination `page=9999&limit=200` | `200`, empty array, `totalPages:1` | ✅ Acceptable |
| H4 | `limit=1000000` | `200`, clamped to `limit:200` | ✅ Good |
| H5 | Invalid ObjectId `/comments/notanobjectid` | `400 Invalid id` | ✅ Good |
| H6 | Missing fields on POST /comments | `400` with clear error | ✅ Good |
| H7 | **Invalid ObjectId `/datasets/notanobjectid` (GET/PATCH/DELETE)** | **`500` + leaked Mongo error string** | ⚠️ **FINDING B2** |
| H8 | **Upload `.txt` file** | **`500` "Only .csv and .xlsx files allowed"** (should be 400/415) | ⚠️ **FINDING B3** |
| H9 | Upload **empty CSV** | `202` accepted → background `status:"failed"`, `importError:"File is empty"` | ✅ Good |
| H10 | Upload **header-only CSV** | `202` → `status:"failed"`, `importError:"File is empty"` | ✅ Good |
| H11 | Upload **26 MB file** | rejected (20 MB limit enforced) — **but `500 File too large`** | ⚠️ **FINDING B3** |
| H12 | Upload **2000-row CSV** | `202` → poll `completed`, totalRows=2000, importedRows=2000, ~1 s | ✅ Fast |
| H13 | Cascade delete 2000-row dataset | `200 deletedComments: 2000`, ~2.8 s | ✅ Works |
| H14 | **Concurrent duplicate sourceId (8 parallel)** | **1×201 + 7×409** — unique `{datasetId,sourceId}` index blocked duplicates | ✅ Race-safe now |
| H15 | Malformed CSV (bad quoting) | `202` → `failed` with parse error stored in `importError` | ✅ Good error path |
| H16 | Global rate limiter 50 rapid requests | All `200` (limit is 10000/min in dev) | ✅ By design |
| H17 | Load test on 2000-row dataset (datasetId+status filter) | 20 conc: **avg 914 ms**, p95 1218 ms | ⚠️ Slow at scale (§6 #7) |
| H18 | nodemon watchdog behavior | Creating files in backend dir **restarts server** (uptime resets) | ℹ️ Dev-workflow observation |

---
## 5) PHASE C — PEN TESTS (security)

### 5.1 JWT & auth-header manipulation — ALL PASS

| # | Attack | Response | Verdict |
|---|--------|----------|---------|
| P1 | Tampered role claim (`admin`→`annotator`) with original signature | `401 Invalid or expired token` | ✅ PASS |
| P2 | Token signed with wrong secret | `401` | ✅ PASS |
| P3 | `alg:none` header | `401` | ✅ PASS |
| P4 | Expired token (`exp` in the past) | `401` | ✅ PASS |
| P5 | Random/truncated signature | `401` | ✅ PASS |
| P6 | No token / empty `Bearer ` / wrong scheme (`Basic`, lowercase `bearer`) | `401 Invalid authorization format` / `No token provided` | ✅ PASS |
| P7 | Token as query param instead of header | `401 No token provided` | ✅ PASS |

### 5.2 Injection — 1 finding

| # | Attack | Response | Verdict |
|---|--------|----------|---------|
| P8 | **NoSQL injection on login** `{"email":{"$ne":""}, ...}` | **`500 email.toLowerCase is not a function`** — internal error leaked to client | ⚠️ **FINDING C1** (mitigated by login rate limiter, but still a type-validation gap) |
| P9 | NoSQL `{"password":{"$gt":""}}` | `429` (rate-limited) / not exploitable (bcrypt.compare) | ✅ Safe |
| P10 | SQLi strings in login (`' OR '1'='1`) | treated as literal strings, `401 Invalid password` | ✅ Safe (no SQL layer) |
| P11 | Operator injection in list filters `?sentiment[$ne]`, `?status[$regex]`, `?search[$regex]` | **No filter applied** — Express 5 simple query parser treats them as literal keys; all rows returned | ✅ Safe |
| P12 | ReDoS pattern `?search=((a+)+)+$` | returned fast, no hang | ✅ Safe |

### 5.3 Stored-XSS / CSV formula injection — 1 finding

| # | Attack | Response | Verdict |
|---|--------|----------|---------|
| P13 | Store `<script>alert(1)</script>` in commentText | stored raw in DB (201) | ℹ️ By design (data), see export risk |
| P14 | **CSV export of `=HYPERLINK(...)`, `+2+3`, `@SUM`, `-1+4` formula payloads** | **exported RAW with only CSV quoting — no `'` prefix / sanitization** | ⚠️ **FINDING C2 (CSV injection)** |
| P15 | XLSX export contains same raw content | exported raw | ⚠️ part of C2 |

### 5.4 Mass assignment / prototype pollution — PASS

| # | Attack | Response | Verdict |
|---|--------|----------|---------|
| P16 | Create user with `isActive:false`, `createdAt` override, extra `role2` | Stored doc: `isActive:true`, server `createdAt` — extras **ignored** (whitelist payload) | ✅ PASS |
| P17 | Create user with `__proto__/constructor` pollution keys | `201` but stored user had `role:annotator`, `isActive:true` — **no pollution** | ✅ PASS |
| P18 | Create comment with `_id`, `status:annotated`, `role:admin`, `__proto__` | `_id` was server-generated, `status` stayed per logic, no pollution | ✅ PASS |
| P19 | PATCH comment with `status`/`sentiment` extra | Only `commentText` changed (v6) — extras ignored | ✅ PASS |

### 5.5 IDOR / privilege escalation — PASS

| # | Attack | Response | Verdict |
|---|--------|----------|---------|
| P20 | Annotator GET admin user by id | `403 Unauthorized` | ✅ PASS |
| P21 | Annotator PATCH/DELETE own admin-protected resource | `403` | ✅ PASS |
| P22 | Annotator reset admin's password | `403` | ✅ PASS |
| P23 | Annotator DELETE own account | `403` (admin-only route) | ✅ PASS |

### 5.6 Rate-limit bypass — PASS

| # | Attack | Response | Verdict |
|---|--------|----------|---------|
| P24 | **X-Forwarded-For spoofing** to reset login limiter | Still `429 Too many login attempts` — XFF ignored (trust proxy only in prod) | ✅ PASS |
| P25 | Login brute force | Exactly 5 attempts allowed → 6th `429` with `Retry-After: 540` | ✅ PASS |
| P26 | 50 rapid requests bypass global limiter | All `200` (10000/min dev limit — correctly high in dev) | ✅ PASS (configured limit) |

### 5.7 Miscellaneous — 3 findings

| # | Test | Result | Verdict |
|---|------|--------|---------|
| P27 | Security headers via curl | Full helmet suite present (CSP, HSTS, X-Frame-Options SAMEORIGIN, nosniff, no-referrer...) | ✅ PASS |
| P28 | **CORS** | `Access-Control-Allow-Origin: *` with `Allow-Methods: GET,HEAD,PUT,PATCH,POST,DELETE` | ⚠️ **FINDING C3** (open CORS) |
| P29 | Method tampering (`PUT`/`PATCH` on wrong route, `OPTIONS`) | `404 Route not found` / `204` preflight | ✅ PASS |
| P30 | **Login intermittent `500 Cannot read properties of undefined (reading 'collection')`** | `getDB()` returned `undefined` once during heavy parallel load | ⚠️ **FINDING C4** (reliability — no null-check on `getDB()`) |
| P31 | Transient failures aligned with **nodemon auto-restart** (backend-dir file writes trigger watch restarts) | Server restarted mid-test; in-memory rate-limit windows reset; brief request failure | ⚠️ **FINDING C5** (dev env + prod startup robustness) |

---
## 6) FINDINGS & RECOMMENDATIONS

### B1 / C1 — Input type validation gaps (low severity)
- `GET|PATCH|DELETE /api/datasets/:id` and `/api/datasets/:id` don't guard `ObjectId.isValid()` before `new ObjectId(...)` → **HTTP 500 with raw Mongo error** (`input must be a 24 character hex string...`). The `/comments` and `/users` routes validate correctly — apply the same guard to `/datasets/:id`.
- Login route calls `email.toLowerCase()` on `req.body.email` without ensuring it's a string → passing an object yields **500 `email.toLowerCase is not a function`** (leaks internals). Add a type check (`typeof email !== "string"`).
- **Recommendation:** a small validation layer (zod/express-validator) or consistent manual guards + global 400 for malformed IDs.

### B3 — Multer error status codes (minor)
- Wrong file type and `>20MB` uploads are rejected with **HTTP 500** (multer error flows into the centralized handler as a generic error). These should be **400/415/413**.
- **Recommendation:** map `err instanceof multer.MulterError` → `400` (LIMIT_FILE_SIZE → `413`) in the centralized error handler; return a clean JSON `{ error }`.

### C2 — CSV formula-injection on export (medium)
- The CSV/XLSX exporter does **not sanitize cells starting with `= + - @`**. An uploaded comment `=HYPERLINK("http://evil.com","Click")` is exported verbatim; opening the file in Excel executes the formula (classic **CSV injection**).
- **Recommendation:** prefix dangerous leading characters with a single quote (`'=...`) or a tab when writing string cells in both `exceljs` and the CSV serializer, e.g. `if (/^[=+@-]/.test(v)) v = "'" + v`.

### C3 — Open CORS (medium)
- `app.use(cors())` with no origin restriction → `Access-Control-Allow-Origin: *` for an authenticated API. Combined with JWT in localStorage, any malicious website can `fetch` the API (it won't get the token, but the header is wrong for a credentialed API).
- **Recommendation:** configure CORS to the frontend origin (e.g. `cors({ origin: [process.env.CLIENT_URL], credentials: false })`). Keep `*` only if the API is genuinely public.

### C4 — `getDB()` null-safety (low)
- One login call during heavy load returned `500 Cannot read properties of undefined (reading 'collection')` — `getDB()` returned `undefined`, likely during a restart/connection blip. A null guard that returns `503` (or waits for connect) is safer than a raw 500.

### C5 — Dev/workflow robustness (info / minor)
- The server runs under `nodemon`; writing any file inside `Anotator-backend/` (e.g. export files, scripts, fixtures) **triggers an auto-restart**, which resets in-memory rate-limit counters and can briefly shed in-flight requests. Not a production bug, but worth knowing: run exports/scripts under a path excluded from the watch (add `ignore` patterns to `nodemon.json`), or run with `npm start` while testing.
- On a fresh restart the **startup recovery marks any `pending/processing` dataset as failed** — desired behavior, but confirm no production dataset would be interrupted unexpectedly.

### H1 — Pagination bounds (minor)
- `page=0&limit=-5` returns `limit:-5, totalPages:-1` and executes an odd skip. Clamp inputs: `page = Math.max(1, parseInt(...) || 1)`, `limit = Math.min(Math.max(1, parseInt(...) || 50), 200)`, and guard `totalPages` for empty result sets (`Math.max(1, ...)` to avoid `totalPages: 0`).

### #7 — Performance at scale (worth tracking)
- Load test on the 2,000-row dataset (`datasetId+status` filter) averaged **914 ms** at 20 concurrent on the free-tier Atlas cluster. The new indexes clearly help correctness/filters, but throughput is still limited by (a) the shared/Atlas free tier and (b) per-request `countDocuments` on the same collection. Options: a small **cache/count** on the dataset doc, or **lean() cursors** and a `$limit`-only fast path for page 1; avoid `$regex` search on large sets (text index exists but the route still builds `$regex`).

---

## 7) CLEANUP PERFORMED (all test data removed)

- Deleted the 2000-row import dataset (cascade `deletedComments: 2000`)
- Deleted the 5-row import dataset (cascade 5), the traversal dataset (2 comments), XSS/formula/mass-assign comments (11 comments), and all failed import records (empty/headers-only/bad-quoting/26MB)
- Deleted all temporary users (annotator, Mass Test, Proto Test)
- Removed all fixture files (`test-comments.csv`, `pentest/`, `out.csv`, `out.xlsx`)

**Final DB state:** only `admin@test.com` remains — identical to the state at the start. No code was modified.

---

*Generated from live API testing — Round 2 (regression against updated code + hard/pen testing). See `api-test-results.md` for the Round-1 baseline.*