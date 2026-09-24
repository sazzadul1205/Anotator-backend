# Controllers — HTTP Layer

> ⚠️ **AI-GENERATED DOCUMENTATION — READ WITH CARE**
>
> This file was written by an AI coding assistant (Cline) from a static reading
> of the source code, last reviewed at commit `742c536` (2026-09-24). It is a
> best-effort explanation, **not** an authoritative specification: it can drift
> out of date and it may contain mistakes.
>
> When this document and the code disagree, **the code is the source of
> truth**. The routers in `routes/*.js` define the real paths and guards — read
> them alongside this file.

---

## Table of contents

1. [What a controller does here](#1-what-a-controller-does-here)
2. [Request lifecycle](#2-request-lifecycle)
3. [Response & error conventions](#3-response--error-conventions)
4. [Controller reference](#4-controller-reference)
5. [Adding an endpoint](#5-adding-an-endpoint)
6. [Sharp edges](#6-sharp-edges)

---

## 1. What a controller does here

A controller is deliberately boring. Its whole job is:

```
read req (params / query / body / file / req.user)
        ↓
call exactly one service function
        ↓
spread the result into a JSON response (or stream a file)
        ↓
next(err) on failure
```

Rules the folder follows:

| Allowed in a controller | Forbidden in a controller |
| --- | --- |
| Reading `req.params`, `req.query`, `req.body`, `req.file`, `req.user` | `require("mongodb")`, `getDB()`, `ObjectId` |
| Light shape checks that decide the HTTP status (missing file, empty name, bad version number) | Business rules (status flips, label validation, cascades) |
| Choosing `res.json` / `res.status(...)` / `res.setHeader` / `res.send` | Filter building or `$operators` |
| `next(err)` | `try/catch` that swallows or reformats service errors |

Because of that, most handlers are 6–10 lines. The only heavier ones are
`datasetController.importDataset` (file validation + queue guard + 202 response)
and the two export handlers (they set `Content-Type` / `Content-Disposition`
before sending what the service built).

---

## 2. Request lifecycle

```
HTTP request
  → express.json()                                        server.js
  → helmet, cors, morgan                                  server.js
  → GET /api/** → global rate limiter (300/min prod, 10000/min dev)
  → DB readiness guard (503 when the Mongo handle is missing)
  → router: routes/<x>Route.js
      → verifyToken  (JWT + isActive + tokenVersion check) middleware/auth.js
      → verifyAdmin  (admin-only routes)
      → optional multer upload / rate limiter
      → controller handler                                controllers/<x>Controller.js
          → service function                              services/<x>Service.js
              → model adapter                             models/<x>.js
                  → MongoDB
  → response, or next(err) → notFound/errorHandler         middleware/errorHandler.js
```

`verifyToken` puts the caller on the request as:

```js
req.user = { userId, role, email, name };  // userId is a string
```

Every service that needs identity reads `req.user` (passed through by the
controller) — there is no other source of truth.

---

## 3. Response & error conventions

**Success**

- Almost everything returns `{ success: true, ...serviceResult }`, so the exact
  keys differ per endpoint (documented per handler below and in `api.md`).
- `201 Created` for newly created resources: `createComment`, `createUser`,
  `createTaxonomy`, `duplicateDataset`.
- `202 Accepted` for `importDataset` — the import only starts a background job.
- Exports return `{ contentType, filename, body }` from the service and the
  controller copies two headers (`Content-Type`, `Content-Disposition`) before
  `res.send(body)`. The body is a `string` (JSONL/CSV) or a `Buffer` (XLSX).

**Failure**

- Controllers never invent error payloads. They call `next(err)` and
  `middleware/errorHandler.js` produces
  `{ success: false, error: message }` with `err.status || 500`.
- In production the message is always `"Internal server error"`, so a 500 in
  production hides the reason from the client (it appears in the server log).
- Unknown routes: `notFound` → `404 { success: false, error: "Route not found", path }`.
- The only hand-built error responses in controllers are cheap shape checks:
  `400 No file uploaded`, `400 Uploaded file is empty`,
  `400 Invalid version` (restore), `503 Import queue is full` (with the queue
  snapshot).

---

## 4. Controller reference

### 4.1 `authController` — `controllers/authController.js`

Routes mounted at `/api/auth` (`routes/authRoute.js`). Bootstrap routes are rate
limited (10/hour in production, 1000 in development) and login is limited to
5 attempts/15 min in production (1000 in development).

| Handler | Route | Auth | Service call | Success response |
| --- | --- | --- | --- | --- |
| `bootstrapStatus` | `GET /bootstrap-status` | public (limited) | `authService.getBootstrapStatus()` | `{ success, adminCount }` |
| `bootstrap` | `POST /bootstrap` | public (limited) | `authService.bootstrapAdmin(req.body)` | `{ success, userId, message }` (400 when an admin exists) |
| `login` | `POST /login` | public (limited) | `authService.login({ ...req.body, ip: req.ip })` | `{ success, user, token }` (401 on bad credentials) |
| `logout` | `POST /logout` | `verifyToken` | `authService.logout(req.user, req.ip)` | `{ success: true }` |
| `me` | `GET /me` | `verifyToken` | — (returns `req.user`) | `{ success, user }` |

`me` is the only handler with no service call and no `try/catch`: it cannot fail.

### 4.2 `userController` — `controllers/userController.js`

Mounted at `/api/users`; the router applies `verifyToken, verifyAdmin` to **every**
route, so all seven endpoints are admin-only.

| Handler | Route | Service call | Notes |
| --- | --- | --- | --- |
| `list` | `GET /` | `userService.listUsers()` | `{ success, users }` |
| `create` | `POST /` | `userService.createUser(req.body, req.user)` | `201`, `{ success, userId, message }` |
| `getOne` | `GET /:id` | `userService.getUser(req.params.id)` | `{ success, user }` |
| `update` | `PATCH /:id` | `userService.updateUser(id, req.body, req.user)` | `{ success, user, message }` |
| `toggleStatus` | `PATCH /:id/status` | `userService.toggleStatus(id, req.user.userId, req.user)` | the caller's own id is passed so the service can refuse self-deactivation |
| `resetPassword` | `POST /:id/reset-password` | `userService.resetPassword(id, req.body, req.user)` | `{ success, message }` |
| `remove` | `DELETE /:id` | `userService.deleteUser(id, req.user.userId, req.user)` | refuses self-delete and users that still own datasets |

### 4.3 `datasetController` — `controllers/datasetController.js`

Mounted at `/api/datasets`. Upload routes use multer (`memoryStorage`, 20 MB,
`.csv`/`.xlsx` only) and are admin-only; reads are available to any logged-in user
(the service scopes them to the caller's assignments).

| Handler | Route | Auth | Service call | Notes |
| --- | --- | --- | --- | --- |
| `importDataset` | `POST /import` (multipart `file`) | admin | `importService.canAcceptImport()`, `importService.startImport(...)`, then `importService.processImportInBackground(...)` | Validates file presence/type/emptiness, `name` (≤ 120 chars, falls back to the file name), `dedupeStrategy` (`rename` else `skip`); answers **503 + queue snapshot** when the queue is full; returns **202** with `{ datasetId, status: "pending", name, taxonomyId, taxonomyName }`; the background job is fired with `.catch(console.error)` |
| `previewDataset` | `POST /preview` (multipart `file`) | admin | `importService.previewFile(buffer, originalname)` | `{ success, preview }` |
| `getStats` | `GET /stats` | admin | `datasetService.getStats()` | `{ success, stats }` |
| `list` | `GET /` | any token | `datasetService.listDatasets(req.query, req.user)` | `{ success, datasets }` |
| `getOne` | `GET /:id` | any token | `datasetService.getDataset(req.params.id, req.user)` | `{ success, dataset, summary }` |
| `assign` | `PATCH /:id/assign` | admin | `datasetService.assignDataset(id, req.body.assignedTo, req.user)` | `{ success, message }` |
| `duplicate` | `POST /:id/duplicate` | admin | `datasetService.duplicateDataset(id, req.body?.name, req.user)` | `201`, `{ success, datasetId, copiedComments, message }` |
| `rename` | `PATCH /:id` | admin | `datasetService.renameDataset(id, req.body.name, req.user)` | `{ success, message }` |
| `remove` | `DELETE /:id` | admin | `datasetService.deleteDataset(req.params.id, req.user)` | `{ success, message, deletedComments }` |

`importDataset` is the one place where a controller talks to a service twice —
first to reserve the record and answer the client, then to run the queued job.

### 4.4 `commentController` — `controllers/commentController.js`

Mounted at `/api/comments`; `verifyToken` on all routes, `verifyAdmin` only on
`bulk-assign` and `delete`. **Declaration order matters**: literal paths
(`/export`, `/bulk-annotate`, ...) are declared before `/:id`, otherwise Express
would treat `export` as an id.

| Handler | Route | Auth | Service call | Notes |
| --- | --- | --- | --- | --- |
| `list` | `GET /` | token | `commentService.listComments(req.query, req.user)` | `{ success, page, limit, total, totalPages, comments }` |
| `create` | `POST /` | token | `commentService.createComment(req.body, req.user)` | `201`, `{ success, commentId, message }`; 409 on duplicate `sourceId` |
| `bulkAnnotate` | `POST /bulk-annotate` | token | `commentService.bulkAnnotate(req.body, req.user)` | `{ success, message: "Bulk annotation applied", requested, updated, skipped }` |
| `bulkAssign` | `POST /bulk-assign` | admin | `commentService.bulkAssign(req.body, req.user)` | `{ success, updated, message }` |
| `exportComments` | `GET /export?format=csv|xlsx` | token | `commentService.exportComments({ query, user, format })` | Sets `Content-Type` + `Content-Disposition: attachment` and sends the body; default format `csv`; runs on the exports queue |
| `getOne` | `GET /:id` | token | `commentService.getComment(id, req.user)` | `{ success, comment }` |
| `updateText` | `PATCH /:id` | token | `commentService.updateCommentText(id, req.body.commentText, req.user)` | `{ success, version, message }` |
| `annotate` | `PATCH /:id/annotation` | token | `commentService.annotateComment(id, req.body, req.user)` | `{ success, version, message }` |
| `getVersions` | `GET /:id/versions` | token | `commentService.getCommentVersions(id, req.query, req.user)` | `{ success, page, limit, total, totalPages, versions }` |
| `restoreVersion` | `POST /:id/restore/:version` | token | `commentService.restoreCommentVersion(id, Number(req.params.version), req.user)` | The controller parses the version and answers `400 Invalid version` when it is not a positive integer |
| `remove` | `DELETE /:id` | admin | `commentService.deleteComment(id, req.user)` | `{ success, message }` |

### 4.5 `taxonomyController` — `controllers/taxonomyController.js`

Mounted at `/api/taxonomies`. Reads need a token; writes (create/update/delete/
assign/unassign) are admin-only. Literal paths are declared first.

| Handler | Route | Auth | Service call | Notes |
| --- | --- | --- | --- | --- |
| `list` | `GET /?kind=&isActive=` | token | `taxonomyService.listTaxonomies(req.query, req.user)` | `{ success, taxonomies }` |
| `getDefaults` | `GET /defaults` | token | `taxonomyService.getDefaults()` | `{ success, defaults }` |
| `getForDataset` | `GET /for-dataset/:datasetId` | token | `taxonomyService.getForDataset(datasetId, req.user)` | `{ success, datasetId, taxonomyId, taxonomyName, sentiment, type }` |
| `create` | `POST /` | admin | `taxonomyService.createTaxonomy(req.body, req.user)` | `201`, `{ success, taxonomyId, message }` |
| `getOne` | `GET /:id` | token | `taxonomyService.getTaxonomy(id, req.user)` | `{ success, taxonomy }` |
| `update` | `PATCH /:id` | admin | `taxonomyService.updateTaxonomy(id, req.body, req.user)` | `{ success, message }` |
| `remove` | `DELETE /:id?hard=true` | admin | `taxonomyService.deleteTaxonomy(id, req.query.hard === "true", req.user)` | soft delete unless `hard=true` |
| `assignToDataset` | `PATCH /:id/assign/:datasetId` | admin | `taxonomyService.assignToDataset(id, datasetId, req.user)` | `{ success, message }` |
| `unassignFromDataset` | `DELETE /:id/assign/:datasetId` | admin | `taxonomyService.unassignFromDataset(id, datasetId, req.user)` | `{ success, message }` |

### 4.6 `auditController` — `controllers/auditController.js`

Mounted at `/api/audit`; the router applies `verifyToken, verifyAdmin` to the
whole router, so both endpoints are admin-only.

| Handler | Route | Service call | Notes |
| --- | --- | --- | --- |
| `list` | `GET /?page=&limit=&action=&actorId=&targetType=&targetId=&from=&to=` | `auditService.listAuditEntries(req.query)` | `{ success, page, limit, total, totalPages, entries }` |
| `actions` | `GET /actions` | `auditService.listActions()` | `{ success, actions }` — used to fill filter dropdowns |

### 4.7 `analyticsController` — `controllers/analyticsController.js`

Mounted at `/api/analytics`; `verifyToken` on all three, `verifyAdmin` on the
global view only. This controller used to build the ML export itself; today it
only forwards parameters and headers.

| Handler | Route | Auth | Service call | Notes |
| --- | --- | --- | --- | --- |
| `datasetAnalytics` | `GET /dataset/:id` | token | `analyticsService.getDatasetAnalytics(id, req.user)` | `{ success, dataset, overview, statusBreakdown, sentiment, type, lengthHistogram, activity, readiness, warnings }` |
| `globalAnalytics` | `GET /global` | admin | `analyticsService.getGlobalAnalytics()` | `{ success, overview, sentiment, type, activityLast14Days, datasetsByStatus, topDatasets }` |
| `exportML` | `GET /dataset/:id/export-ml?format=&split=` | token | `analyticsService.exportMLDataset({ datasetId, user, format, split })` | `format` lower-cased, default `jsonl`; sets `Content-Type` + `Content-Disposition` and sends the body; runs on the exports queue |

---

## 5. Adding an endpoint

1. **Service first.** Write the function in `services/<domain>Service.js`
   (validate → authorise → models → audit → return data). See `services.md` §6.
2. **Controller handler.** Small wrapper: pull inputs off `req`, call the service,
   `res.status(...).json({ success: true, ...result })`, `next(err)` in `catch`.
3. **Route.** Add it to `routes/<domain>Route.js` with the right guards
   (`verifyToken`, `verifyAdmin`) and put literal paths **before** `/:id` paths.
4. **Docs.** Add the endpoint to `docs/api.md` and the handler row to
   `docs/controllers.md`; mention new audit actions in `docs/services.md` §5.
5. **Test it.** `./tests/api-test.ps1 -StartServer` runs the end-to-end suite and
   writes a report into `tests/results/`.

---

## 6. Sharp edges

1. **The controller JSDoc comments are not the router.** The route tables above
   come from `routes/*.js`; the docblocks inside the controllers describe the same
   routes but had drifted (they were corrected in the docs commit accompanying
   this file). Always trust `routes/`.
2. **`importDataset` responds before the work finishes.** A `202` means "the
   record exists and a job is queued", not "the data is imported". Poll
   `GET /api/datasets/:id` (`status`, `progress.phase`, `progress.processed`).
3. **Multer errors are not shaped like API errors.** The file filter calls
   `cb(new Error("Only .csv and .xlsx files allowed"))`, which reaches
   `errorHandler` **without** a `status`, so a rejected upload answers
   `500` (not 400) with that message. Oversized files (> 20 MB) produce a
   `MulterError` the same way.
4. **Order of middleware matters.** `verifyToken` runs before multer on the
   upload routes, so an unauthenticated upload never buffers the file.
5. **Two guards per rule.** Routes enforce roles (`verifyAdmin`) and services
   enforce ownership (403 "Not assigned to you"). Removing either one weakens the
   API — do not "simplify" by dropping the service checks.
6. **Handlers that stream a body cannot use `next(err)` after sending.** The
   export handlers build the whole file in the service first, so the response is
   only started once everything succeeded. Keep it that way (no streaming writes
   followed by error handling).
7. **`req.user` has no `_id`.** It is `{ userId, role, email, name }`. Code that
   expects `req.user._id` silently passes `undefined` to services.

---

## Related documents

- [`services.md`](services.md) — what the handlers call, including validation and
  audit rules
- [`models.md`](models.md) — the data layer below the services
- [`api.md`](api.md) — full endpoint reference (bodies, params, responses)
- [`database.md`](database.md) — collections, indexes, cascade rules



