# Models — Data Access Layer

> ⚠️ **AI-GENERATED DOCUMENTATION — READ WITH CARE**
>
> This file was written by an AI coding assistant (Cline) from a static reading
> of the source code, last reviewed at commit `742c536` (2026-09-24). It is a
> best-effort explanation, **not** an authoritative specification: it can drift
> out of date and it may contain mistakes.
>
> When this document and the code disagree, **the code is the source of
> truth** (start with `models/`). Verify anything critical against the source
> before you rely on it.

---

## Table of contents

1. [What "model" means here](#1-what-model-means-here)
2. [The repeated patterns](#2-the-repeated-patterns)
3. [Domain errors](#3-domain-errors)
4. [Collections at a glance](#4-collections-at-a-glance)
5. [Model reference](#5-model-reference)
6. [Indexes](#6-indexes)
7. [Caveats & sharp edges](#7-caveats--sharp-edges)

---

## 1. What "model" means here

`models/` is the **only** layer in this project that talks to MongoDB. Each file
wraps exactly one collection in a class with `static` methods (an "adapter") and
converts between Mongo documents and the plain objects the rest of the app uses.

Rules the project follows (by convention — nothing enforces them automatically):

1. **Services and controllers never touch the driver.** They do not
   `require("mongodb")`, do not build `$operators`, do not call `getDB()`, and do
   not call `collection()` themselves.
2. **Ids are strings on the outside.** Every model accepts and returns string
   ids (`id`, `datasetId`, `assignedTo`, ...). `ObjectId` instances never leave
   this folder.
3. **Driver errors never leak.** The adapters translate Mongo error codes into
   the domain errors in `models/errors.js` (see [section 3](#3-domain-errors)).
4. **Write methods return small summaries**, not raw driver results:
   `{ id }`, `{ matchedCount, modifiedCount }`, `{ deletedCount }`, `{ entries, total }`.

### The barrel file

`models/index.js` re-exports every model so callers write one require:

```js
const { Comment, CommentVersion, Dataset, User } = require("../models");
```

It also re-exports the error classes under the `errors` key
(`require("../models").errors`). Models that need an error class import it
directly instead (`require("./errors")`) to avoid a circular require through the
barrel.

`models/index.js` requires **all** models at load time. A syntax error or bad
require in any single model breaks every consumer, so keep this folder clean.

---

## 2. The repeated patterns

Every adapter is built from the same five pieces. Once you understand them, you
can read any model file quickly.

### 2.1 `static collection()`

```js
class Dataset {
  static collection() {
    return getDB().collection(COLLECTION); // COLLECTION = "datasets"
  }
}
```

`getDB()` (from `config/db.js`) returns the connected `Db` handle, and returns
`null` until `connectDB()` has finished. `server.js` only starts listening after
that, so in practice the collection is always available — but calling a model
method from a script that never called `connectDB()` will throw
`Cannot read properties of null`.

### 2.2 DTO mapping (`toDTO`)

Raw documents hold `_id: ObjectId`, references as `ObjectId`, and possibly
fields from older versions. `toDTO(doc)` normalises a document for the rest of
the app:

- `doc._id` → `dto.id` (string)
- every reference (`datasetId`, `assignedTo`, `annotatedBy`, ...) → string or `null`
- missing optional values get a stable default: `?? null`, `|| []`, `|| 0`
- `doc._id.toString()` never appears outside the model

**Gotcha — the mapper is a whitelist.** If you add a field to a document, it is
invisible to services until you add it to `toDTO`. The same is true in reverse:
services cannot accidentally read internal fields the mapper omits.

### 2.3 Domain filters (`toMongoFilter`)

Services pass *domain* filters — plain, operator-free objects — and the adapter
turns them into a Mongo query:

```js
// service
const filter = { datasetId: "652f...", status: "pending" };
const { comments, total } = await Comment.findMany(filter, { page, limit });

// model (Comment.toMongoFilter)
{ datasetId: ObjectId("652f..."), status: "pending" }
```

Supported filter keys per model (anything else is ignored):

| Model | Filter keys |
| --- | --- |
| `Comment` | `ids[]`, `datasetIds[]`, `datasetId`, `status`, `excludeAnnotated`, `sentiment`, `type`, `assignedTo` (`null` = unassigned), `search` |
| `Dataset` | `status`, `assignedTo`, `uploadedBy`, `taxonomyId` |
| `User` | `role`, `isActive`, `email` (lower-cased + trimmed for you) |
| `Taxonomy` | `kind`, `isActive` (see [caveats](#7-caveats--sharp-edges)) |
| `AuditLog` | `action`, `actorId`, `targetType`, `targetId`, `from`, `to` (date range on `at`) |

`Comment` is the only model with "list" semantics built in: `datasetIds` lets an
annotator scope a query to the datasets assigned to them, and `search` uses an
escaped regex capped at 100 characters so a user cannot inject a regex.

### 2.4 Patch sanitising (`patchToSet` / `dtoToDoc`)

Write methods accept a `patch`/`dto` object and clean it before hitting the
driver:

- `id` and `_id` are stripped — a client cannot change an identity
- id-like fields (`assignedTo`, `taxonomyId`, `updatedBy`, ...) become `ObjectId`
  or `null`; empty strings become `null`
- `updateX` methods always stamp `updatedAt: new Date()` themselves

`Comment.dtoToDoc` additionally strips `_oldId`, an internal bookkeeping field
used only while duplicating a dataset.

### 2.5 Error translation (`translateError`)

```js
function translateError(err) {
  if (err && err.code === 11000) return new DuplicateKeyError("sourceId");
  return err;
}
```

`User.create`, `User.updateById` and `Comment.create`/`insertMany` funnel driver
errors through this. `SystemLock.claim` does the same check inline. Everything
else bubbles up untouched, so a driver error that is not a duplicate key reaches
the service and surfaces as a 500 with the raw message (in non-production).

---

## 3. Domain errors

`models/errors.js` defines four classes, and each carries a `status` — which is
exactly what `middleware/errorHandler.js` writes into the HTTP response. That is
why translating a driver error into a domain error turns a 500 into a correct 4xx.

| Class | `status` | Meaning | Thrown by |
| --- | --- | --- | --- |
| `DuplicateKeyError` | 409 | A unique index rejected the write (`E11000`) | `User.create`, `User.updateById`, `Comment.create`/`insertMany`, `SystemLock.claim` |
| `NotFoundError` | 404 | Requested record does not exist | Defined for use, **not thrown anywhere yet** — services build their own `Error` with `status = 404` |
| `ValidationError` | 400 | Input the model refuses (missing required field) | `User.create` (needs `email` + `password`), `Comment.create` (needs `datasetId` + `sourceId`) |
| `ConflictError` | 409 | Business-rule conflict | Defined for use, **not thrown anywhere yet** |

`DuplicateKeyError` also carries `field` and `value`, so a caller can name the
value that collided. Services detect it by `name`:

```js
try {
  created = await User.create({ ... });
} catch (err) {
  if (err.name === "DuplicateKeyError") { /* -> "User already exists" */ }
  throw err;
}
```

> There is a deliberate mix in this codebase: models raise
> `DuplicateKeyError`/`ValidationError`, while services mostly raise plain
> `Error` objects with a `status` property. Both work because `errorHandler`
> only reads `err.status`.

---

## 4. Collections at a glance

| Model | Collection | One document = | Identity / uniqueness |
| --- | --- | --- | --- |
| `User` | `users` | A person who can log in | unique `email` |
| `Dataset` | `datasets` | One imported file (CSV/XLSX) plus its import status | `_id`; `checksum` is stored but **not** unique |
| `Comment` | `comments` | One row of an imported dataset | unique `(datasetId, sourceId)` |
| `CommentVersion` | `comment_versions` | Immutable snapshot of a comment at a version | `(commentId, version)`, no unique index — services keep the counter |
| `Taxonomy` | `taxonomies` | A reusable label set (sentiment + type) | `_id`; `name` is indexed but not unique |
| `AuditLog` | `audit_log` | One recorded action | `_id` only, append-only |
| `SystemLock` | `system_locks` | A named mutex (`_id` = the lock name) | `_id`, e.g. `admin_bootstrap` |

Relations (MongoDB — no foreign keys, no cascades at the database level):

```
User 1─∞ Dataset          (uploadedBy, assignedTo)
Dataset 1─∞ Comment       (datasetId)
Comment 1─∞ CommentVersion(commentId)
Taxonomy 1─∞ Dataset      (taxonomyId + taxonomyName cached on the dataset)
User 1─∞ AuditLog         (actorId, never deleted)
```

Deleting a parent is the **service's** job: `datasetService.deleteDataset`
removes comments and their versions, `commentService.deleteComment` removes the
version history. Deleting a user is refused while datasets are still assigned.

## 5. Model reference

### 5.1 `User` — `models/User.js`

| Method | Returns | Notes |
| --- | --- | --- |
| `findById(id)` | DTO \| `null` | Never includes the password hash |
| `findByIdWithPassword(id)` | DTO \| `null` | Adds `password` (bcrypt hash) |
| `findByEmail(email)` | DTO \| `null` | **Includes the password hash** — login only |
| `findOne({ role?, isActive?, email? })` | DTO \| `null` | Existence checks (no hash) |
| `findMany(filter)` / `findAll()` | DTO[] | Sorted `createdAt: -1` |
| `create({ email, name, password, role })` | `{ id }` | `isActive: true`, `tokenVersion: 0`; password must already be hashed by the caller; throws `ValidationError` / `DuplicateKeyError` |
| `updateById(id, patch)` | `{ matchedCount, modifiedCount }` | Lower-cases + trims `email`; `DuplicateKeyError` on collision |
| `updateStatus(id, isActive)` | `{ matchedCount }` | Deactivating also increments `tokenVersion` → all existing JWTs become invalid |
| `updatePassword(id, hashedPassword)` | `{ matchedCount }` | Always increments `tokenVersion` (forces re-login everywhere) |
| `bumpTokenVersion(id)` | `{ matchedCount }` | Used by logout |
| `deleteById(id)` | `{ deletedCount }` | Hard delete; services refuse while datasets are assigned |
| `countAdmins()` | number | Powers bootstrap-status |
| `countActiveAnnotators()` | number | Dashboard stat |
| `countAll()` / `countActive()` | number | Dashboard stats |

DTO fields: `id, email, name, role, isActive, tokenVersion, createdAt, updatedAt`
(+ `password` only when explicitly requested).

### 5.2 `Dataset` — `models/Dataset.js`

**Reads**

| Method | Returns | Notes |
| --- | --- | --- |
| `findById(id)` | DTO \| `null` | |
| `findOne({ status?, assignedTo?, uploadedBy?, taxonomyId? })` | DTO \| `null` | No guard against an empty filter |
| `findMany(filter)` | DTO[] | Sorted `createdAt: -1` |
| `findManyWithCounts(filter)` | DTO[] + `summary` | `$lookup` into `comments`; adds `summary: { total, annotated, pending }` |
| `findAssignedToIds(userId)` | string[] | Used for annotator scoping |

**Writes**

| Method | Returns | Notes |
| --- | --- | --- |
| `create(dto)` | `{ id }` | Converts `taxonomyId`/`uploadedBy`/`assignedTo`/`duplicatedFrom`; stamps `createdAt`/`updatedAt` |
| `updateById(id, patch)` | `{ matchedCount, modifiedCount }` | Stamps `updatedAt` |
| `updateProgress(id, progress)` | `{ matchedCount }` | **Replaces the whole `progress` object** and stamps `updatedAt` |
| `setProgressProcessed(id, processed)` | `{ matchedCount }` | Cheap update during the import loop |
| `clearTaxonomy(id)` | `{ matchedCount }` | `$unset`s `taxonomyId`, `taxonomyName`, `taxonomyAssignedAt` |
| `deleteById(id)` | `{ deletedCount }` | Does **not** touch comments — the service does that |

**Aggregations (read-only)**

| Method | Returns |
| --- | --- |
| `countAll()` | number |
| `countByStatus()` | `[{ status, count }]` |
| `countAssignedTo(userId)` | number |
| `topByCommentCount(limit = 10)` | `[{ id, name, status, total, annotated }]` |
| `cleanupStaleImports(cutoff)` | `{ modifiedCount }` — marks `pending`/`processing` datasets older than `cutoff` as `failed` with `importError: "Server restarted during import"` |

**Import progress phases** written into `progress.phase`:
`queued` → `parsing` → `inserting` → `versions` → `finalizing` → `completed`,
or `failed`. `progress.processed`/`progress.total` drive the frontend progress bar.

### 5.3 `Comment` — `models/Comment.js`

The biggest adapter: reads with pagination, three different bulk-write helpers and
the aggregations the analytics service needs.

**Reads**

| Method | Returns | Notes |
| --- | --- | --- |
| `findById(id)` / `findOne(filter)` | DTO \| `null` | |
| `findMany(filter, { page, limit, sortBy, sortDir })` | `{ comments, total, page, limit, totalPages }` | Default page 1, 50 per page, **hard max 200**, default sort `createdAt desc` |
| `findForExport(filter)` | DTO[] | Sorted `createdAt: 1`, **no limit** — used for CSV/XLSX export |
| `findManyByIds(ids)` | DTO[] | Order of `ids` is not preserved |
| `findTextsForDuplicates(datasetId, limit = 2000)` | string[] | Text-only projection for near-duplicate detection |
| `count(filter)` | number | |
| `countByStatus(datasetId)` | `{ total, pending, annotated }` | Three `countDocuments` in parallel |
| `groupByField(datasetId, field)` | `[{ label, count }]` | `$group`; requires a valid `datasetId` (see caveats) |
| `lengthHistogram(datasetId, boundaries)` | `[{ label, count }]` | `$bucket`; last bucket labelled `"<last>+"` |

**Writes**

| Method | Returns | Notes |
| --- | --- | --- |
| `create(dto)` | `{ id }` | Requires `datasetId` + `sourceId` (`ValidationError` otherwise); `DuplicateKeyError` on the unique pair |
| `updateById(id, patch)` | `{ matchedCount, modifiedCount }` | Stamps `updatedAt` |
| `updateMany(filter, patch)` | `{ modifiedCount }` | Used by bulk assign |
| `bulkUpdate([{ id, patch }])` | `{ modifiedCount }` | One `bulkWrite` — used by bulk annotate |
| `insertMany(dtos)` | `[{ id, index }]` | `ordered: false`; **write errors are swallowed** and only successful ids are returned; `index` = position in the input array |
| `deleteById(id)` / `deleteMany(filter)` | `{ deletedCount }` | Versions are deleted by the service |
| `rawInsertMany(docs)` | `[{ id }]` | Pre-shaped docs, used by dataset duplication |

DTO fields: `id, datasetId, sourceId, commentText, sentiment, type, status,
assignedTo, assignedAt, assignedBy, annotatedBy, annotatedAt, annotationNote,
version, createdBy, updatedBy, createdAt, updatedAt`.

### 5.4 `CommentVersion` — `models/CommentVersion.js`

Append-only history. A row is written on create, import, text update, annotation,
bulk annotation and restore — never updated in place.

| Method | Returns | Notes |
| --- | --- | --- |
| `create(dto)` / `insertMany(dtos)` | `{ id }` / `[{ id }]` | `snapshot` is stored verbatim |
| `findByCommentId(commentId, { skip, limit })` | DTO[] | Sorted `version: -1` (newest first) |
| `countByCommentId(commentId)` | number | |
| `findOne({ commentId, version })` | DTO \| `null` | Used by restore |
| `deleteByCommentId(id)` / `deleteByCommentIds(ids)` | `{ deletedCount }` | |
| `activityByDate(since)` | `[{ date: "YYYY-MM-DD", count }]` | `$dateToString` grouping, ascending |
| `activityByDateForDataset(datasetId)` | `[{ date, count }]` | Adds a `$lookup` into `comments` because versions carry no `datasetId` |
| `findRawByCommentIds(ids)` | raw Mongo docs | For duplication (the caller re-keys `commentId`) |
| `rawInsertMany(docs)` | `[{ id }]` | Used by duplication |

`snapshot` shape: `{ commentText, sentiment, type, status, assignedTo,
annotatedBy, annotatedAt, annotationNote }`.
`changeType` is one of `create | import | update | annotation | bulk_annotation | restore`.

### 5.5 `Taxonomy` — `models/Taxonomy.js`

| Method | Returns | Notes |
| --- | --- | --- |
| `findById(id)` | DTO \| `null` | |
| `findMany({ kind?, isActive? })` | DTO[] | Sorted by `kind, order, label` — see caveats |
| `create(dto)` | `{ id }` | Defaults `description: ""`, empty label arrays, `isActive: true` |
| `updateById(id, patch)` | `{ matchedCount, modifiedCount }` | Stamps `updatedAt`, converts `updatedBy` |
| `deactivate(id, userId)` | `{ matchedCount }` | Soft delete (`isActive: false`) |
| `deleteById(id)` | `{ deletedCount }` | Hard delete, services guard against in-use taxonomies |
| `countDatasetsUsing(id)` | number | Counts `datasets.taxonomyId` |

Document shape: `sentiment` and `type` are arrays of `{ value, label, order }`,
sorted by `order`; `value` is a slug derived with `taxonomyService.slugify`.

### 5.6 `AuditLog` — `models/AuditLog.js`

| Method | Returns | Notes |
| --- | --- | --- |
| `create(dto)` | driver result of `insertOne` | Called through `utils/audit.js`, which never throws |
| `findMany(filter, { page, limit })` | `{ entries, total }` | Sorted `at: -1`; limit capped at 200 (default 50) |
| `count(filter)` | number | |
| `distinctActions()` | string[] | Powers the audit filter dropdowns |

DTO fields: `id, action, actorId, actorEmail, actorRole, targetType, targetId,
metadata, at`.

### 5.7 `SystemLock` — `models/SystemLock.js`

| Method | Returns | Notes |
| --- | --- | --- |
| `claim(id)` | `{ claimed: true }` | Inserts `{ _id: id, claimedAt }`; **throws `DuplicateKeyError`** when the lock is already held — this is the mutual-exclusion primitive |
| `release(id)` | `{ released: boolean }` | Idempotent `deleteOne` |
| `exists(id)` | boolean | |

Only `admin_bootstrap` is used today. The lock is not time-based: if a process
dies mid-bootstrap, the lock row stays behind (the service releases it in a
`catch`, but a hard crash would not).

---

## 6. Indexes

Created by `ensureIndexes(db)` in `config/indexes.js` on every boot (and by
`npm run init-indexes`). Creating an existing index is a no-op, so the call is
safe to repeat.

| Collection | Index | Serves |
| --- | --- | --- |
| `users` | `email` (unique) | login, duplicate prevention |
| `users` | `role` | `countAdmins`, `countActiveAnnotators` |
| `comments` | `(datasetId, sourceId)` (unique) | dedupe on import, `createComment` conflict, `findOne` duplicate check |
| `comments` | `(datasetId, status)` | `countByStatus`, filtered lists |
| `comments` | `(datasetId, createdAt: -1)` | comment list, newest first |
| `comments` | `(datasetId, sentiment)` / `(datasetId, type)` | analytics grouping |
| `comments` | `(datasetId, status, sentiment)` | combined analytics filters |
| `comments` | `assignedTo` | annotator scoping |
| `comments` | `status` | global counts |
| `comment_versions` | `(commentId, version: -1)` | version history, restore |
| `comment_versions` | `createdAt: -1` | activity timeline |
| `datasets` | `assignedTo`, `createdAt: -1`, `status`, `taxonomyId` | list filters, status stats, taxonomy usage |
| `audit_log` | `at: -1`, `(actorId, at: -1)`, `(action, at: -1)`, `(targetType, targetId)` | audit listing + filters |
| `system_locks` | `claimedAt` | housekeeping |
| `taxonomies` | `isActive`, `name` | list filters |

Note: `comment_versions` has **no** unique index on `(commentId, version)` and
`datasets.checksum` is not indexed at all.

---

## 7. Caveats & sharp edges

Things a reader (or a future contributor) should know before trusting the
behaviour above. These are observations from the code, not wishes.

1. **`findMany` caps pages at 200.** `Comment.findMany` computes
   `limit = Math.min(200, Math.max(1, options.limit || 50))`. Callers that pass
   `limit: 1_000_000` (`analyticsService._exportMLDataset`,
   `datasetService.duplicateDataset`, `datasetService.deleteDataset`) still get
   **200 rows per call**. For the ML export and dataset duplication/deletion this
   means "first 200 comments only" — worth fixing before the feature is used at
   scale. `Comment.findForExport` has no such cap and is used for the CSV/XLSX
   comment export.
2. **`Comment.groupByField` needs a dataset id.** It returns `[]` when
   `toOid(datasetId)` fails. `analyticsService.getGlobalAnalytics` passes `null`
   for global results, so the global sentiment/type summaries come back empty
   (all counts 0). The per-dataset variant works.
3. **`Taxonomy` filters/sorts reference fields that do not exist.**
   `toMongoFilter` maps a `kind` key and `findMany` sorts by
   `{ kind: 1, order: 1, label: 1 }`, but taxonomy documents only have `name`,
   `description`, `sentiment[]`, `type[]`, `isActive`, `createdBy`, timestamps.
   Consequence: `GET /api/taxonomies?kind=sentiment` returns an empty list, and
   the sort is effectively a no-op. Sentiment and type labels live in the *same*
   document, not in separate `kind`s.
4. **DTO mappers are whitelists.** Add a field to a document and you must add it
   to the model's `toDTO`, otherwise services cannot see it.
5. **`Comment.insertMany` hides failures.** It catches `insertMany` errors, keeps
   whatever succeeded and returns only those. Duplicate `(datasetId, sourceId)`
   rows are silently dropped — the importer counts them as `skipped`. If you need
   to know *why* a row failed, this method will not tell you.
6. **Invalid ids do not throw.** Every `toOid` helper returns `null` and the
   method returns `null`/`0`/`{ deletedCount: 0 }`. Services turn that into a 404.
   A malformed id from a client is therefore a 404, never a 500.
7. **Models need a connected database.** `getDB()` is `null` until `connectDB()`
   resolves; calling a model before that throws a `TypeError`.
8. **`CommentVersion` version numbers are not enforced by the database.** Two
   concurrent annotations on the same comment can compute the same
   `version + 1`. The write itself is atomic (`updateById`), the history row may
   collide conceptually.
9. **`AuditLog.create` returns the raw driver result** while every other `create`
   returns `{ id }`. Harmless today (`utils/audit.js` ignores the result) but
   inconsistent.
10. **No transactions anywhere.** Cascades (dataset delete → comments → versions)
    are three separate round-trips: a crash in the middle leaves orphans.

---

## Related documents

- [`services.md`](services.md) — business logic that uses these models
- [`controllers.md`](controllers.md) — HTTP handlers
- [`api.md`](api.md) — endpoint reference
- [`database.md`](database.md) — collection schemas, indexes, recipes




