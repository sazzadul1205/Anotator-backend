# Annotator Backend — Database Reference

**Engine:** MongoDB (Atlas or local 6+)  
**Database name:** configurable via `DB_NAME` (default `annotator_db`)

Every document uses Mongo's native `_id: ObjectId` unless noted.

---

## Collections Overview

| Collection         | Purpose                             | Approx. size growth                  |
| ------------------ | ----------------------------------- | ------------------------------------ |
| `users`            | Accounts (admins + annotators)      | Tiny                                 |
| `datasets`         | Imported files + their metadata     | Medium                               |
| `comments`         | Individual text rows to annotate    | Large (dominant)                     |
| `comment_versions` | Immutable history for every comment | Very large (multiples of `comments`) |
| `taxonomies`       | Reusable sentiment/type label sets  | Tiny                                 |
| `audit_log`        | Fire-and-forget action log          | Medium                               |
| `system_locks`     | Distributed locks (bootstrap)       | Tiny                                 |

---

## `users`

Annotator and admin accounts. **Password is bcrypt-hashed.**

### Document shape

```js
{
  _id: ObjectId,
  email: "admin@example.com",       // lowercase, trimmed, unique
  name: "Root Admin",
  password: "$2a$10$...",            // bcrypt hash
  role: "admin" | "annotator",
  isActive: true,
  tokenVersion: 0,                   // bumped to invalidate all JWTs
  createdAt: Date,
  updatedAt: Date
}
```

### Indexes

| Index          | Unique | Purpose                            |
| -------------- | ------ | ---------------------------------- |
| `{ email: 1 }` | ✅     | Login lookup, duplicate prevention |
| `{ role: 1 }`  | ❌     | Filter by role                     |

### Notes

- `tokenVersion` is embedded in JWTs. When it changes, all outstanding tokens are invalidated. Used by logout, password reset, and user deactivation.
- Password is **never** returned by any API — every read uses `projection: { password: 0 }`.
- Deleting a user requires them to have no datasets assigned (`datasets.assignedTo`).

---

## `datasets`

One document per imported file. Tracks import status _and_ (optionally) an assigned taxonomy.

### Document shape

```js
{
  _id: ObjectId,
  name: "Bank Reviews Q1",
  originalFileName: "bank-reviews.xlsx",
  fileType: "csv" | "xlsx",
  sheetName: "cmt" | null,            // xlsx sheet used
  checksum: "sha256hex",              // fingerprint (dedupe hint, not enforced)
  totalRows: 1200,
  importedRows: 1180,
  skippedRows: 20,
  renamedRows: 0,

  dedupeStrategy: "skip" | "rename",

  status: "pending" | "processing" | "completed" | "failed",
  importError: null,
  importErrors: [],                   // last 20 error strings

  progress: {
    phase: "queued|parsing|inserting|versions|finalizing|completed|failed",
    processed: 0,
    total: 0,
    startedAt: Date,
    updatedAt: Date
  },

  // Taxonomy (optional)
  taxonomyId: ObjectId | null,
  taxonomyName: "Product Review Labels" | null,
  taxonomyAssignedAt: Date | null,

  // Ownership / assignment
  uploadedBy: ObjectId,               // users._id
  assignedTo: ObjectId | null,        // annotator user
  assignedAt: Date | null,

  // Copy lineage
  duplicatedFrom: ObjectId | null,    // datasets._id

  createdAt: Date,
  updatedAt: Date
}
```

### Indexes

| Index               | Unique | Purpose                        |
| ------------------- | ------ | ------------------------------ |
| `{ assignedTo: 1 }` | ❌     | Annotator's dataset list       |
| `{ createdAt: -1 }` | ❌     | Newest-first listing           |
| `{ status: 1 }`     | ❌     | Filter by import status        |
| `{ taxonomyId: 1 }` | ❌     | Find datasets using a taxonomy |

### Notes

- `status` tracks **the import job only**. `completed` means the file finished importing — annotation progress is derived by counting `comments`.
- When `status !== "completed"`, the backend's startup routine marks records stuck in `pending`/`processing` for over 30 minutes as `failed`.
- `checksum` is stored for reference but does **not** prevent re-imports.

---

## `comments`

The actual text to annotate. Dominant collection.

### Document shape

```js
{
  _id: ObjectId,
  datasetId: ObjectId,                // datasets._id
  sourceId: "row-123",                // original file row ID
  commentText: "যতটা ভালো ভেবেছিলাম...",

  sentiment: "positive",              // value from the dataset's taxonomy
  type: "bangla",                     // value from the dataset's taxonomy

  status: "pending" | "annotated",

  // Assignment
  assignedTo: ObjectId | null,
  assignedAt: Date | null,
  assignedBy: ObjectId | null,

  // Annotation metadata
  annotatedBy: ObjectId | null,
  annotatedAt: Date | null,
  annotationNote: null | "string",

  version: 1,                         // incremented on every mutation

  // Provenance
  createdBy: ObjectId,
  updatedBy: ObjectId,
  createdAt: Date,
  updatedAt: Date
}
```

### Indexes

| Index                                       | Unique | Purpose                                               |
| ------------------------------------------- | ------ | ----------------------------------------------------- |
| `{ datasetId: 1, sourceId: 1 }`             | ✅     | Prevent duplicate source IDs per dataset; fast lookup |
| `{ datasetId: 1, status: 1 }`               | ❌     | "Show pending" filter                                 |
| `{ datasetId: 1, createdAt: -1 }`           | ❌     | Paginated listing                                     |
| `{ assignedTo: 1 }`                         | ❌     | Comments assigned to a user                           |
| `{ status: 1 }`                             | ❌     | Global status counting                                |
| `{ datasetId: 1, sentiment: 1 }`            | ❌     | Analytics distribution                                |
| `{ datasetId: 1, type: 1 }`                 | ❌     | Analytics distribution                                |
| `{ datasetId: 1, status: 1, sentiment: 1 }` | ❌     | Compound analytics                                    |

### Status logic

- `pending` — either `sentiment === "unannotated"` OR `type === "unclassified"` OR both.
- `annotated` — both sentiment and type are set to a real (non-sentinel) value.

### Notes

- `sentiment` and `type` are stored as **strings**, not ObjectId references. This means changing a taxonomy never corrupts existing comments.
- Validation happens on write: a value must exist in the dataset's effective taxonomy (or the built-in defaults if none is assigned).

---

## `comment_versions`

Immutable history. Every mutation of a `comment` appends one row here.

### Document shape

```js
{
  _id: ObjectId,
  commentId: ObjectId,                // comments._id
  version: 3,                         // matches comments.version at write time

  snapshot: {
    commentText: "string",
    sentiment: "positive",
    type: "bangla",
    status: "annotated",
    assignedTo: ObjectId | null,
    annotatedBy: ObjectId | null,
    annotatedAt: Date | null,
    annotationNote: null | "string"
  },

  changedFields: ["sentiment", "status"],   // array of field names
  changeType: "create" | "import" | "update" | "annotation"
             | "bulk_annotation" | "restore",

  restoredFrom: 2,                    // only set when changeType = "restore"

  changedBy: ObjectId,                // users._id
  createdAt: Date
}
```

### Indexes

| Index                           | Unique | Purpose                                  |
| ------------------------------- | ------ | ---------------------------------------- |
| `{ commentId: 1, version: -1 }` | ❌     | List versions of a comment, newest first |
| `{ createdAt: -1 }`             | ❌     | Activity timeline queries                |

### Notes

- **Never updated, never partially deleted** except when the parent comment is deleted (cascade).
- Restores do **not** delete anything — they append a new version tagged `restore`.
- `snapshot` is a full copy of the comment state at that version, so you can restore without joining anything.

---

## `taxonomies`

Reusable label sets that a dataset can reference.

### Document shape

```js
{
  _id: ObjectId,
  name: "Product Review Labels",
  description: "Labels for e-commerce reviews",
  isActive: true,

  sentiment: [
    { value: "positive",   label: "Positive",   order: 0 },
    { value: "negative",   label: "Negative",   order: 1 },
    { value: "neutral",    label: "Neutral",    order: 2 },
    { value: "unannotated",label: "Unannotated",order: 999 }   // sentinel (auto-added)
  ],

  type: [
    { value: "bangla",       label: "Bangla",       order: 0 },
    { value: "english",      label: "English",      order: 1 },
    { value: "banglish",     label: "Banglish",     order: 2 },
    { value: "unclassified", label: "Unclassified", order: 999 }  // sentinel (auto-added)
  ],

  createdBy: ObjectId,
  updatedBy: ObjectId,
  createdAt: Date,
  updatedAt: Date
}
```

### Indexes

| Index             | Unique | Purpose                |
| ----------------- | ------ | ---------------------- |
| `{ isActive: 1 }` | ❌     | List active taxonomies |
| `{ name: 1 }`     | ❌     | Sorting / lookup       |

### Notes

- `value` fields are **unique within each list** and are slugs (lowercase, `_`-separated, max 60 chars). Auto-derived from `label` if omitted.
- The sentinels `unannotated` and `unclassified` are **always appended** to `sentiment` and `type` respectively, even if the admin doesn't include them. They're required for status computation.
- **Soft-delete default.** `DELETE` sets `isActive: false`. Passing `?hard=true` performs a real delete, but is blocked if any dataset references the taxonomy.

---

## `audit_log`

Append-only log of notable actions. Written fire-and-forget by `utils/audit.js` — never blocks the request that triggered it.

### Document shape

```js
{
  _id: ObjectId,
  action: "dataset.import_started",   // dotted namespace
  actorId: "userId" | null,           // string, not ObjectId
  actorEmail: "admin@example.com" | null,
  actorRole: "admin" | "annotator" | null,
  targetType: "user" | "dataset" | "comment" | "taxonomy" | null,
  targetId: "ObjectId string" | null,
  metadata: { /* arbitrary structured payload */ },
  at: Date
}
```

### Indexes

| Index                            | Unique | Purpose                   |
| -------------------------------- | ------ | ------------------------- |
| `{ at: -1 }`                     | ❌     | Newest-first listing      |
| `{ actorId: 1, at: -1 }`         | ❌     | Filter by actor           |
| `{ action: 1, at: -1 }`          | ❌     | Filter by action          |
| `{ targetType: 1, targetId: 1 }` | ❌     | Trace an entity's history |

### Known action names

| Namespace    | Actions                                                                                                                                        |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `auth.*`     | `auth.bootstrap`, `auth.login`, `auth.logout`                                                                                                  |
| `user.*`     | `user.create`, `user.update`, `user.activate`, `user.deactivate`, `user.password_reset`, `user.delete`                                         |
| `dataset.*`  | `dataset.import_started`, `dataset.assign`, `dataset.unassign`, `dataset.rename`, `dataset.duplicate`, `dataset.delete`                        |
| `comment.*`  | `comment.bulk_annotate`, `comment.bulk_assign`, `comment.bulk_unassign`, `comment.delete`                                                      |
| `taxonomy.*` | `taxonomy.create`, `taxonomy.update`, `taxonomy.deactivate`, `taxonomy.delete`, `taxonomy.assign_to_dataset`, `taxonomy.unassign_from_dataset` |

### Notes

- `actorId`, `targetId` are stored as **strings**, not ObjectIds, because the log is immutable and shouldn't hold live references.
- `metadata` is arbitrary — the audit page renders it as a collapsible JSON blob.
- No TTL index. If you want auto-pruning, add `{ at: 1 }` with `expireAfterSeconds`.

---

## `system_locks`

Tiny collection used for atomic singleton operations. Only one row currently.

### Document shape

```js
{
  _id: "admin_bootstrap",   // string, not ObjectId — deliberate
  claimedAt: Date
}
```

### Indexes

| Index              | Unique | Purpose                                 |
| ------------------ | ------ | --------------------------------------- |
| `{ claimedAt: 1 }` | ❌     | Reasonable default; not strictly needed |

### Notes

- Used by `POST /auth/bootstrap` to guarantee only one admin can ever be created, even under concurrent requests.
- The row is deleted if the transaction is rolled back (bootstrap fails after the lock is claimed).

---

## Relation Map

```
users ──┬─ (uploadedBy) ──► datasets
        ├─ (assignedTo) ──► datasets
        ├─ (assignedTo) ──► comments
        ├─ (annotatedBy) ─► comments
        ├─ (changedBy) ───► comment_versions
        └─ (createdBy) ───► taxonomies

datasets ─┬─ (taxonomyId) ──► taxonomies
          ├─ (_id) ◄────────── comments.datasetId
          └─ (duplicatedFrom)─► datasets (self)

comments ─┬─ (_id) ◄────────── comment_versions.commentId
          └─ (datasetId) ────► datasets

taxonomies ─── (_id) ◄────────── datasets.taxonomyId

audit_log  ── (actorId, targetId)  [string refs, denormalized]
```

---

## Cascade Rules

| Deleting            | Cascades to                                                                 |
| ------------------- | --------------------------------------------------------------------------- |
| `users`             | **Blocked** if they have `datasets.assignedTo = them`                       |
| `datasets`          | All `comments` for that dataset → all `comment_versions` for those comments |
| `comments`          | All `comment_versions` for that comment                                     |
| `taxonomies` (soft) | Nothing. Datasets keep referencing it; it just becomes `isActive: false`.   |
| `taxonomies` (hard) | **Blocked** if any dataset still references it                              |

---

## Rough Storage Estimates

For a workspace with **100k comments**:

| Collection         | Doc count | Avg size | Total       |
| ------------------ | --------- | -------- | ----------- |
| `comments`         | 100,000   | ~400 B   | ~40 MB      |
| `comment_versions` | ~250,000  | ~500 B   | ~125 MB     |
| `datasets`         | ~50       | ~1 KB    | <1 MB       |
| `taxonomies`       | ~10       | ~2 KB    | <1 MB       |
| `users`            | ~20       | ~500 B   | <1 MB       |
| `audit_log`        | ~50,000   | ~500 B   | ~25 MB      |
| **Total**          |           |          | **~190 MB** |

MongoDB's free Atlas tier (512 MB) is plenty for prototyping. Enable backups in production.

---

## Quick Recipes

### Count comments by sentiment for a dataset

```js
db.comments.aggregate([
  { $match: { datasetId: ObjectId("...") } },
  { $group: { _id: "$sentiment", count: { $sum: 1 } } },
]);
```

### Find comments not yet annotated

```js
db.comments.find({ datasetId: ObjectId("..."), status: "pending" });
```

### Get the full version history of a comment

```js
db.comment_versions.find({ commentId: ObjectId("...") }).sort({ version: -1 });
```

### Find all datasets using a specific taxonomy

```js
db.datasets.find({ taxonomyId: ObjectId("...") });
```

### Trace an entity's audit history

```js
db.audit_log
  .find({ targetType: "dataset", targetId: "ObjectId-string" })
  .sort({ at: -1 });
```

### Active annotators

```js
db.users.find({ role: "annotator", isActive: true });
```

### Recently completed imports

```js
db.datasets.find({ status: "completed" }).sort({ updatedAt: -1 }).limit(10);
```
