# Services — Business Logic Layer

> ⚠️ **AI-GENERATED DOCUMENTATION — READ WITH CARE**
>
> This file was written by an AI coding assistant (Cline) from a static reading
> of the source code, last reviewed at commit `742c536` (2026-09-24). It is a
> best-effort explanation, **not** an authoritative specification: it can drift
> out of date and it may contain mistakes.
>
> When this document and the code disagree, **the code is the source of
> truth** (start with `services/`). Verify anything critical against the source
> before you rely on it.

---

## Table of contents

1. [What a service owns](#1-what-a-service-owns)
2. [The error contract](#2-the-error-contract)
3. [Concurrency & background work](#3-concurrency--background-work)
4. [Service reference](#4-service-reference)
5. [Audit action catalogue](#5-audit-action-catalogue)
6. [Adding a service function](#6-adding-a-service-function)

---

## 1. What a service owns

Services sit between controllers and models. They hold **all** the thinking that
is not HTTP and not storage:

| Owned by the service | Example |
| --- | --- |
| Request validation | `createUser` requires name/email/password/role, password ≥ 6 |
| Business rules | a comment is `annotated` only when both sentiment and type are set |
| Authorisation | annotators may only touch datasets assigned to them |
| Orchestration | dataset duplication copies comments, then their version history |
| Audit writes | every mutation calls `audit({ action, actor, targetType, ... })` |
| Background work | the import worker, export jobs and their queues |
| Export formatting | JSONL / CSV (BOM + `\r\n`) / XLSX buffers |
| Domain maths | Shannon entropy, Gini impurity, ML readiness scoring |

Not owned by a service:

- **HTTP**: no `req`/`res`, no status codes, no headers. Controllers do that.
- **Mongo**: no `ObjectId`, no `$operators`, no `getDB()`. Models do that.
- **Presentation**: no rendering, no column layout decisions beyond export files.

Every service module exports plain `async function`s (no classes, no state).
`taxonomyService` additionally exports its pure helpers
(`slugify`, `validateAndNormalize`, `DEFAULT_SENTIMENTS`, `DEFAULT_TYPES`) so
tests and other services can reuse them.

---

## 2. The error contract

Services signal failure by **throwing an `Error` with a `status` property**:

```js
const err = new Error("Dataset not found");
err.status = 404;
throw err;
```

`middleware/errorHandler.js` reads `err.status || 500` and returns
`{ success: false, error: err.message }` — the message is replaced by
`"Internal server error"` when `NODE_ENV=production`.

Statuses used across the services:

| Status | Meaning | Typical trigger |
| --- | --- | --- |
| 400 | Bad input / illegal state transition | missing field, invalid role, invalid label, nothing to update, deleting yourself |
| 401 | Bad credentials | `authService.login` |
| 403 | Authenticated but not allowed | "Not assigned to you" |
| 404 | Record does not exist | unknown id, unknown version, unknown assignee |
| 409 | Duplicate | `sourceId already exists in this dataset` (from `DuplicateKeyError`) |
| 503 | Temporarily unavailable | a full concurrency queue (`config/concurrency.js`) |

Model-raised errors (`DuplicateKeyError`, `ValidationError`) are caught by name
and converted into a friendlier service error where it matters.

---

## 3. Concurrency & background work

Two long-running kinds of work are bounded by an in-process FIFO queue
(`config/concurrency.js`): **imports** and **exports**.

| Queue | Concurrency env var | Default | Timeout env var | Default | Used by |
| --- | --- | --- | --- | --- | --- |
| `imports` | `MAX_CONCURRENT_IMPORTS` | 2 | `JOB_TIMEOUT_MS` | 600000 ms (10 min) | `importService.processImportInBackground` |
| `exports` | `MAX_CONCURRENT_EXPORTS` | 4 | `EXPORT_TIMEOUT_MS` | 60000 ms (1 min) | `analyticsService.exportMLDataset`, `commentService.exportComments` |

Shared: `MAX_QUEUE_SIZE` (default 100 pending jobs) and
`QUEUE_LOG_INTERVAL_MS` (default 60000 ms, `0` disables the queue-depth log).

Behaviour worth knowing:

- **Rejection when full.** `queue.run()` rejects immediately with
  `status: 503` once `pending >= maxQueueSize`. The dataset controller checks
  `importService.canAcceptImport()` *before* creating a dataset record, so a full
  queue answers `503` with a queue snapshot; exports rely on the thrown 503.
- **Job timeout.** A job that exceeds its timeout rejects the caller's promise
  with `status: 500` and bumps the `timedOut` counter. The queue does **not**
  cancel the function — it keeps running in the background, so a slow import can
  still finish (and still write to the database) after the caller saw the error.
- **Depth / stats** are exposed through `snapshot()` and surfaced on
  `GET /health` under `queues.imports` and `queues.exports`
  (`running`, `pending`, `oldestWaitMs`, `stats.{started,completed,failed,rejected,timedOut}`).
- **Per instance.** The queue lives in the Node process. With more than one
  replica, each replica allows its own concurrency — the limits are not global.

## 4. Service reference

### 4.1 `authService` — `services/authService.js`

Bootstrap, login and logout. Uses `bcryptjs` for hashing and `jsonwebtoken` for
tokens (7-day expiry, signed with `JWT_SECRET`).

| Function | Input | Returns | Throws |
| --- | --- | --- | --- |
| `getBootstrapStatus()` | — | `{ adminCount }` | — |
| `bootstrapAdmin({ name, email, password, confirmPassword })` | first-admin payload | `{ userId, message }` | 400 on missing fields / password mismatch / password < 6 chars / admin already exists |
| `login({ email, password, ip })` | credentials + caller IP | `{ user, token }` | 400 missing fields, 401 invalid credentials or inactive user |
| `logout(reqUser, ip)` | `req.user` from the middleware | `undefined` | — |

**Bootstrap flow (mutual exclusion):**

1. Validate the payload (all four fields present, passwords match, length ≥ 6).
2. `SystemLock.claim("admin_bootstrap")` — a `DuplicateKeyError` here means
   "Admin account already exists" (400).
3. Re-check `User.countAdmins()`; if an admin appeared meanwhile, release the lock
   and fail with 400.
4. `bcrypt.hash(password, 10)`, then `User.create({ ..., role: "admin" })`.
5. `audit({ action: "auth.bootstrap", actor: null, targetType: "user", targetId })`.
6. On any error, release the lock if this call claimed it (`lockClaimed` flag).

**Login flow:** `User.findByEmail` (which includes the password hash) →
reject when the user is missing or `isActive` is false → `bcrypt.compare` → sign
the JWT with `{ userId, role, tokenVersion }` → audit `auth.login` with the IP.
`tokenVersion` inside the token is what makes revocation work: the auth
middleware compares it with the stored value on every request.

**Logout** calls `User.bumpTokenVersion(userId)`, which invalidates every token
the user holds (all devices), then audits `auth.logout`.

### 4.2 `userService` — `services/userService.js`

Admin-only user administration. Each mutation writes an audit entry.

| Function | Input | Returns | Validation / rules |
| --- | --- | --- | --- |
| `listUsers()` | — | User DTO[] | newest first |
| `createUser({ name, email, password, role }, actor)` | admin payload | `{ userId, message }` | all fields required; role ∈ `admin, annotator`; password ≥ 6; email lower-cased; 400 if it already exists (pre-check **and** `DuplicateKeyError`) |
| `getUser(id)` | id | User DTO | 404 when missing |
| `updateUser(id, { name, email }, actor)` | partial fields | `{ user, message }` | at least one field; 404 unknown; 400 when the new email belongs to someone else |
| `toggleStatus(id, actorUserId, actor)` | target id + caller id | `{ isActive, message }` | 400 when an admin targets themself; flips `isActive`; deactivating bumps `tokenVersion` (forces logout) |
| `resetPassword(id, { newPassword, confirmPassword }, actor)` | admin payload | `{ message }` | both fields required, must match, ≥ 6 chars; bumps `tokenVersion` |
| `deleteUser(id, actorUserId, actor)` | target id + caller id | `{ message }` | 400 when deleting yourself or when datasets are still assigned (`Dataset.countAssignedTo`) |

Audit actions written: `user.create`, `user.update`, `user.activate`,
`user.deactivate`, `user.password_reset`, `user.delete`.

### 4.3 `datasetService` — `services/datasetService.js`

Dataset lifecycle (the file *upload* path lives in `importService`).

| Function | Input | Returns | Notes |
| --- | --- | --- | --- |
| `getStats()` | — | `{ totalDatasets, totalComments, annotatedComments, pendingComments, activeAnnotators, percentAnnotated, datasetsByStatus, activityLast7Days }` | Seven model calls in parallel; `percentAnnotated` rounded to 1 decimal |
| `listDatasets(query, user)` | `?status=&uploadedBy=&includeCounts=` | Dataset DTO[] | annotators only see datasets assigned to them; `includeCounts=true` adds `summary { total, annotated, pending }` and an `_id` alias |
| `getDataset(id, user)` | id | `{ dataset, summary }` | 404 unknown, 403 not assigned; `summary` is only counted when `status === "completed"` |
| `assignDataset(id, assignedTo, actor)` | id + user id \| null | `{ message }` | 404 unknown dataset/assignee, 400 inactive assignee; empty/null unassigns; audits `dataset.assign` / `dataset.unassign` |
| `duplicateDataset(id, name, actor)` | source id + optional name | `{ datasetId, copiedComments, message }` | copies the dataset row (`duplicatedFrom` set), then comments, then re-keys the version history through an old-id → new-id map; new copy is always `status: "completed"`, unassigned |
| `renameDataset(id, name, actor)` | id + name | `{ message }` | 400 when name is empty; 404 when `matchedCount === 0` |
| `deleteDataset(id, actor)` | id | `{ message, deletedComments }` | cascade: version rows → comments → dataset; audits `dataset.delete` |

**Cascade reminder:** `duplicateDataset` and `deleteDataset` build their comment
lists through `Comment.findMany(..., { limit: 1_000_000 })`, which is silently
capped at 200 (see models.md caveat 1). Treat both as "first page only" until
that cap is lifted.

### 4.4 `importService` — `services/importService.js`

Turns an uploaded CSV/XLSX into a dataset plus comments plus version 1 rows.

**Parsing**

| Function | Purpose |
| --- | --- |
| `parseFile(buffer, originalName)` | `.csv` → `parseCsv` (csv-parse, `columns: true`, `bom: true`); anything else → `parseXlsx` |
| `parseXlsx(buffer)` (internal) | ExcelJS; picks the worksheet named `cmt` (case-insensitive) else the first one; returns `{ sheetName, rows[] }` where each row is `{ header: value }` |
| `normalizeRow(row)` (internal) | Maps header aliases to the four known keys: `id`; `comment_text` ← `commenttext`/`comment`/`text`; `sentiment`; `type`. Header matching ignores case, spaces and underscores |
| `previewFile(buffer, originalName)` | Dry run: `{ totalRows, validRows, missingIdOrText, duplicates, uniqueDuplicateCount, duplicateIds (max 20), fileName, suggestedName, checksum, sample (10 rows, text clipped at 200 chars), errors (max 10) }`. Throws 400 on an empty file |

**Records & queue helpers**

| Function | Returns | Notes |
| --- | --- | --- |
| `createDatasetRecord({...})` | `datasetId` | Creates the dataset row with `status: "pending"` and `progress.phase: "queued"`, checksum stored |
| `startImport({ fileBuffer, originalName, fileType, datasetName, dedupeStrategy, taxonomyId, uploadedBy, actor })` | `{ datasetId, name, taxonomyId, taxonomyName }` | Resolves + validates the taxonomy (404 when missing/inactive), computes the SHA-256 checksum, creates the record, audits `dataset.import_started`. **Does not parse the file** |
| `canAcceptImport()` | boolean | `queue.pending < queue.maxQueueSize` — the controller calls this to fail fast with 503 |
| `importQueueSnapshot()` | queue snapshot | Included in the 503 response body |
| `processImportInBackground(args)` | Promise of the worker | Public entry — wraps the worker in `importQueue.run()` |

**Background worker** (internal `_processImportInBackground`, `CHUNK_SIZE = 1000`):

1. `progress.phase = "parsing"`, parse the file; an empty file marks the dataset
   `failed`.
2. Normalise + validate every row:
   - missing `id` or text → skipped;
   - duplicate `id` within the file → strategy `skip` (default) or `rename`
     (`<id>-dup1`, `-dup2`, ...), reported in `importErrors`;
   - `sentiment` ∈ `positive|negative|neutral` else `unannotated`;
   - `type` ∈ `bangla|english|banglish` else `unclassified`;
   - `status = "annotated"` only when both are known, otherwise `"pending"`.
3. No valid rows at all → dataset becomes `failed` with
   `importError: "No valid rows found"` and returns early.
4. `phase = "inserting"` → `Comment.insertMany` per 1000-row chunk, bumping
   `progress.processed`. Insert failures are swallowed by the model and counted as
   skipped.
5. `phase = "versions"` → one `CommentVersion` row per inserted comment
   (`changeType: "import"`, `changedBy` = uploader).
6. `phase = "finalizing"` → write the final counters (`totalRows`, `importedRows`,
   `skippedRows`, `renamedRows`, last 20 `importErrors`) and `status: "completed"`
   with `phase: "completed"`.
7. Any unexpected error → `status: "failed"` + `importError` + `phase: "failed"`.

The controller returns `202 Accepted` with the new `datasetId` **before** the
worker runs, so the client polls `GET /api/datasets/:id` for progress.

### 4.5 `commentService` — `services/commentService.js`

The largest service: comment CRUD, annotation, bulk operations, version history
and the CSV/XLSX export.

**Shared helpers**

| Helper | Purpose |
| --- | --- |
| `buildDomainFilter(query)` | Query string → model filter (`datasetId`, `sentiment`, `type`, `assignedTo`, `status` or `excludeAnnotated` when `hideAnnotated=true`, `search` capped at 100 chars) |
| `getValidOptionsForDataset(dataset)` (internal) | Allowed label sets: taxonomy `value`s when the dataset has an active taxonomy, otherwise `DEFAULT_SENTIMENTS` / `DEFAULT_TYPES`; always adds `unannotated` / `unclassified` |
| `getAllowedDatasetIds(user)` (internal) | `null` for admins, otherwise the ids assigned to the annotator |
| `assertCanAccessComment(comment, user)` (internal) | Admins pass; annotators need the dataset assigned to them, otherwise 403 |

**Functions**

| Function | Returns | Behaviour |
| --- | --- | --- |
| `listComments(query, user)` | `{ page, limit, total, totalPages, comments }` | page default 1, limit default 50 / **max 200**, sorted `createdAt desc`. Annotators are scoped to their datasets (403 if they ask for a dataset that is not theirs) |
| `createComment({ datasetId, sourceId, commentText, sentiment, type }, user)` | `{ commentId, message }` | requires the three fields; 404 unknown dataset; 403 not assigned; **409** on a duplicate `sourceId` in that dataset (pre-check + `DuplicateKeyError`); invalid labels fall back to `unannotated`/`unclassified`; writes version 1 with `changeType: "create"` |
| `getComment(id, user)` | Comment DTO | 404 unknown, 403 not assigned |
| `updateCommentText(id, commentText, user)` | `{ version, message }` | 400 without text; increments `version`; appends a version row with `changeType: "update"` and `changedFields: ["commentText"]` |
| `annotateComment(id, { sentiment, type, annotationNote }, user)` | `{ version, message }` | validates each provided label against the dataset's allowed set (400 otherwise); 400 "Nothing to update" when no value changed; recomputes `status` (`annotated` only when both labels are known); bumps `version`; appends an `annotation` version |
| `bulkAnnotate({ ids, sentiment, type, annotationNote }, user)` | `{ requested, updated, skipped }` | max **200** ids; every comment must exist (404) and be assigned to the caller (403); labels validated per dataset (400); unchanged comments are skipped; changed ones go through `Comment.bulkUpdate` in one `bulkWrite` + `CommentVersion.insertMany`; audits `comment.bulk_annotate` |
| `bulkAssign({ ids, assignedTo }, user)` | `{ updated, message }` | max **500** ids; assignee must exist and be active (404); one `Comment.updateMany`; audits `comment.bulk_assign` / `comment.bulk_unassign` |
| `getCommentVersions(id, query, user)` | `{ page, limit, total, totalPages, versions }` | limit default 20 / max 100, newest version first |
| `restoreCommentVersion(id, version, user)` | `{ newVersion, restoredFrom, message }` | 404 for unknown comment/version; copies the snapshot into the comment and appends a **new** version with `changeType: "restore"`, `restoredFrom` set (history is never rewritten) |
| `deleteComment(id, actor)` | `{ message }` | deletes the version history first, then the comment; audits `comment.delete` |
| `exportComments({ query, user, format })` | `{ contentType, filename, body }` | CSV or XLSX (400 otherwise) built from the same filter as the list (annotators scoped); columns `id, comment_text, sentiment, type, status, version, annotatedAt`; runs inside the **exports** queue |

**Status rule (used everywhere):** a comment is `annotated` only when
`sentiment !== "unannotated"` **and** `type !== "unclassified"`; otherwise it is
`pending`. `annotatedBy`/`annotatedAt` are stamped on every annotation write.

**Versioning rule:** each mutation appends a row; `version` on the comment
increments by one. `CommentVersion.findOne({ commentId, version })` is what
restore reads, so any manual edit of a snapshot desynchronises history.

**Export details:** CSV output starts with a UTF-8 BOM, uses `\r\n`, quotes
fields that contain `"`, `,` or newlines, and prefixes values starting with
`=`, `+`, `-` or `@` with `'` (CSV injection guard). Filenames are
`comments-<ISO timestamp with - >.csv|xlsx`.

### 4.6 `taxonomyService` — `services/taxonomyService.js`

Owns label sets and their assignment to datasets. Also exports the pure helpers
`slugify` and `validateAndNormalize`.

**Defaults** — `DEFAULT_SENTIMENTS = ["positive","negative","neutral","unannotated"]`,
`DEFAULT_TYPES = ["bangla","english","banglish","unclassified"]`. They are used
for datasets without a taxonomy and for label validation in `commentService`.

**Validation rules for label arrays** (`normalizeList` / `validateAndNormalize`):

- must be a non-empty array, max **50** items
- each item is an object with a non-empty `label` (≤ 60 chars)
- `value` = `slugify(value || label)` — lower-case, non-alphanumerics → `_`,
  trimmed, ≤ 60 chars; must be derivable and unique inside the array
- `order` defaults to the array index; items are returned sorted by `order`
- `unannotated` (sentiment) and `unclassified` (type) are auto-appended with
  `order: 999` when the caller did not supply them

| Function | Returns | Behaviour |
| --- | --- | --- |
| `listTaxonomies(query, user)` | Taxonomy DTO[] | 400 when `kind` is neither `sentiment` nor `type`; annotators only get `isActive: true`; admins may pass `?isActive=true|false` |
| `getDefaults()` | `{ sentiment, type }` | Plain string arrays (not `{value,label}` objects) |
| `getForDataset(datasetId, user)` | `{ datasetId, taxonomyId, taxonomyName, sentiment, type }` | 404 unknown dataset, 403 not assigned; falls back to the default label sets (`taxonomyName: "Default"`) when the dataset has no taxonomy |
| `createTaxonomy({ name, description, sentiment, type }, actor)` | `{ taxonomyId, message }` | name required (≤ 120 chars); description trimmed to 500; labels validated; `isActive: true`; audits `taxonomy.create` |
| `getTaxonomy(id, user)` | Taxonomy DTO | 404 unknown; 403 when an annotator asks for an inactive taxonomy |
| `updateTaxonomy(id, body, actor)` | `{ message }` | partial: `name` (non-empty, ≤ 120), `description` (≤ 500), `isActive`, and the label arrays (re-validated as a whole); stores `updatedBy`; audits `taxonomy.update` |
| `deleteTaxonomy(id, hard, actor)` | `{ message }` | soft delete (`isActive: false`) by default; `hard` requires zero datasets using it (400 otherwise); audits `taxonomy.delete` / `taxonomy.deactivate` |
| `assignToDataset(taxonomyId, datasetId, actor)` | `{ message }` | both must exist (404) and the taxonomy must be active (400); writes `taxonomyId`, `taxonomyName`, `taxonomyAssignedAt` on the dataset; audits `taxonomy.assign_to_dataset` |
| `unassignFromDataset(taxonomyId, datasetId, actor)` | `{ message }` | 404 unknown dataset, 400 when the dataset does not use that taxonomy; calls `Dataset.clearTaxonomy`; audits `taxonomy.unassign_from_dataset` |

Note: `listTaxonomies` forwards `kind` to a model filter that cannot match any
field (see models.md caveat 3), so `?kind=...` currently returns an empty list.

### 4.7 `analyticsService` — `services/analyticsService.js`

Dashboard metrics plus the ML-ready export. Pure maths first, aggregation second.

| Helper | Meaning |
| --- | --- |
| `shannonEntropy(counts)` | Base-2 entropy of the class distribution |
| `giniImpurity(counts)` | `1 − Σ p²` |
| `summarizeDistribution(rows)` | `{ total, classes, distribution[{label,count,percent}], max, min, imbalanceRatio, entropy, maxEntropy, balanceScore, gini }`; rows come from `Comment.groupByField`, `null` labels are dropped, sorted descending |
| `assessReadiness({...})` | `{ level, score, reasons[] }` |
| `countNearDuplicates(texts)` (internal) | First 80 chars, lower-cased/trimmed, compared in a Set |
| `assertDatasetAccess(datasetId, user)` (internal) | 404 unknown, 403 not assigned |
| `LENGTH_BOUNDARIES` | `[0, 20, 50, 100, 200, 500, 1000, 100000]` buckets for the length histogram |

**Readiness scoring** — starts at 100 and deducts:

| Condition | Deduction |
| --- | --- |
| annotated coverage `< 50%` / `< 90%` | −40 / −15 |
| fewer than 100 comments / fewer than 500 | −20 / −8 |
| sentiment classes `< 2` / balance score `< 0.5` / `< 0.75` | −30 / −20 / −8 |
| type classes `< 2` / balance score `< 0.5` | −15 / −10 |
| near-duplicates `> 10%` / `> 3%` | −10 / −4 |

Levels: `ready ≥ 80`, `close ≥ 55`, `needs_work ≥ 30`, else `not_ready`
(and `empty` when the dataset has no comments). A dataset with zero comments
short-circuits to `{ level: "empty", score: 0 }`.

| Function | Returns |
| --- | --- |
| `getDatasetAnalytics(datasetId, user)` | `{ dataset{_id,name,status,taxonomyId,taxonomyName}, overview{totalComments,annotatedComments,pendingComments,percentAnnotated,duplicateCount}, statusBreakdown{}, sentiment{...}, type{...}, lengthHistogram[], activity[], readiness{...}, warnings[] }` |
| `getGlobalAnalytics()` | `{ overview{totalComments,annotatedComments,pendingComments,totalDatasets,totalUsers,activeUsers,percentAnnotated}, sentiment{...}, type{...}, activityLast14Days[], datasetsByStatus{}, topDatasets[] }` |
| `exportMLDataset({ datasetId, user, format, split })` | `{ contentType, filename, body }` — queued on the **exports** queue |

`warnings[]` (dataset view only) contains objects `{ kind, severity, message }`
with kind ∈ `sentiment_imbalance | type_imbalance | low_annotation_coverage |
near_duplicates`. Imbalance appears at ratio ≥ 3, severity becomes `high` at ≥ 8.

**ML export algorithm**

1. `format` must be `jsonl`, `csv` or `xlsx` (400 otherwise).
2. `split` defaults to `0.8,0.1,0.1`, must be three numbers summing to 1 (400).
3. Only `status: "annotated"` comments are used; none → 400.
4. The list is sorted by comment `id` for determinism, then
   `floor(n × trainP)` and `floor(n × valP)` create the `train` / `val`
   boundaries; the remainder is `test`.
5. Output keys/columns: `id, text, sentiment, type, split, dataset, taxonomy`.
   CSV uses the same BOM / `\r\n` / quoting / injection guard as the comment
   export.

Caveats: the 200-row `Comment.findMany` cap applies here too (models.md caveat 1),
and the global view's sentiment/type summaries are always empty because
`Comment.groupByField` is called without a dataset id (models.md caveat 2).

### 4.8 `auditService` — `services/auditService.js`

Read-only view over `audit_log`.

| Function | Returns | Notes |
| --- | --- | --- |
| `listAuditEntries(query)` | `{ page, limit, total, totalPages, entries }` | page default 1, limit default 50 / max 200, newest first; `action`, `actorId`, `targetType`, `targetId`, `from`, `to` are forwarded as a domain filter (an unparsable id simply matches nothing) |
| `listActions()` | string[] | `AuditLog.distinctActions()`, sorted alphabetically |

---

## 5. Audit action catalogue

Every string that appears in `audit_log.action`, and where it comes from.

| Action | Written by | Target | Trigger |
| --- | --- | --- | --- |
| `auth.bootstrap` | `authService.bootstrapAdmin` | `user` | first admin created (actor `null`) |
| `auth.login` | `authService.login` | — | successful login (`metadata.ip`) |
| `auth.logout` | `authService.logout` | — | logout (token version bump) |
| `user.create` | `userService.createUser` | `user` | user created |
| `user.update` | `userService.updateUser` | `user` | name/email changed |
| `user.activate` / `user.deactivate` | `userService.toggleStatus` | `user` | status flipped |
| `user.password_reset` | `userService.resetPassword` | `user` | admin reset a password |
| `user.delete` | `userService.deleteUser` | `user` | user removed |
| `dataset.import_started` | `importService.startImport` | `dataset` | import accepted (file name, checksum, strategy, taxonomy) |
| `dataset.assign` / `dataset.unassign` | `datasetService.assignDataset` | `dataset` | assignee changed |
| `dataset.duplicate` | `datasetService.duplicateDataset` | `dataset` | copy created (source id + copied count) |
| `dataset.rename` | `datasetService.renameDataset` | `dataset` | name changed |
| `dataset.delete` | `datasetService.deleteDataset` | `dataset` | dataset + comments deleted |
| `comment.bulk_annotate` | `commentService.bulkAnnotate` | — | bulk labels applied |
| `comment.bulk_assign` / `comment.bulk_unassign` | `commentService.bulkAssign` | — | bulk assignment |
| `comment.delete` | `commentService.deleteComment` | `comment` | single comment deleted |
| `taxonomy.create` | `taxonomyService.createTaxonomy` | `taxonomy` | label set created |
| `taxonomy.update` | `taxonomyService.updateTaxonomy` | `taxonomy` | label set edited |
| `taxonomy.delete` / `taxonomy.deactivate` | `taxonomyService.deleteTaxonomy` | `taxonomy` | hard / soft delete |
| `taxonomy.assign_to_dataset` | `taxonomyService.assignToDataset` | `dataset` | taxonomy attached |
| `taxonomy.unassign_from_dataset` | `taxonomyService.unassignFromDataset` | `dataset` | taxonomy detached |

**Gaps worth knowing** (not bugs, just unlogged paths):

- single-comment mutations — `createComment`, `updateCommentText`,
  `annotateComment` — write version history but **no** audit entry (only the bulk
  variants do);
- import completion/failure is not audited, only import *started*;
- `utils/audit.js` swallows its own errors (it only `console.error`s), so a failed
  audit write never fails the request and leaves no trace in the database;
- audit entries store metadata, never before/after snapshots — use
  `comment_versions` for history.

---

## 6. Adding a service function

Checklist that keeps the layering intact:

1. **Need a new query?** Add a method to the relevant model first — no
   `ObjectId`, no `$operators`, no `getDB()` in the service.
2. **Validate** the payload and throw `Error` objects with `status: 400`
   (follow the existing `const err = new Error("..."); err.status = 400; throw err;`
   pattern).
3. **Authorise** explicitly: `user.role !== "admin" && dataset.assignedTo !==
   user.userId` → 403. Both the service and the route guard, deliberately.
4. **Query through the models barrel**: `const { Dataset, Comment } = require("../models")`.
5. **Audit** mutations with `audit({ action, actor, targetType, targetId, metadata })`.
6. **Return plain data** (objects/arrays/Buffers). Never touch `res`, never set
   HTTP headers.
7. **Export** the function from `module.exports` at the bottom of the file.
8. **Wire it up**: add a thin controller handler, then a route with
   `verifyToken` (and `verifyAdmin` where admin-only), then document it in
   `docs/api.md` and `docs/controllers.md`.
9. **Long-running work?** Wrap it in a queue (`config/concurrency.js`) like
   `importService.processImportInBackground` or `analyticsService.exportMLDataset`.

---

## Related documents

- [`models.md`](models.md) — the adapters these services call
- [`controllers.md`](controllers.md) — how services are invoked over HTTP
- [`api.md`](api.md) — endpoint reference
- [`database.md`](database.md) — schemas and indexes






