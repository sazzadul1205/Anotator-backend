# Annotator Backend — API Reference

Base URL: `http://localhost:5000/api`  
Auth: Bearer JWT in `Authorization` header → `Authorization: Bearer <token>`

**Roles:** `admin` | `annotator`  
Deactivated users cannot log in.

---

## Table of Contents

- [Bootstrap (first-time setup)](#bootstrap-first-time-setup)
- [Authentication](#authentication)
- [User Management (Admin only)](#user-management-admin-only)
- [Datasets & Import](#datasets--import)
- [Comments CRUD](#comments-crud)
- [Annotation](#annotation)
- [Data Versioning](#data-versioning)
- [Taxonomies (Admin only)](#taxonomies-admin-only)
- [Audit Log (Admin only)](#audit-log-admin-only)
- [Analytics](#analytics)
- [Endpoint Summary](#endpoint-summary)

---

## Bootstrap (first-time setup)

### `GET /auth/bootstrap-status`

Check if any admin account exists. Frontend uses this to show the bootstrap page when `adminCount = 0`.

**Returns:** `{ success, adminCount }`

---

### `POST /auth/bootstrap`

Create the **first** admin account. Fails if an admin already exists, if `password !== confirmPassword`, or if password is shorter than 6 chars.

**Body:**

```json
{
  "name": "string",
  "email": "string",
  "password": "string",
  "confirmPassword": "string"
}
```

**Returns:** `{ success, message, userId }`

---

## Authentication

### `POST /auth/login`

Login with email + password. Rate-limited: **5 attempts / 15 min per IP**.

**Body:**

```json
{ "email": "string", "password": "string" }
```

**Returns:**

```json
{
  "success": true,
  "user": { "_id", "email", "name", "role", "isActive", "createdAt", "updatedAt" },
  "token": "jwt"
}
```

---

### `POST /auth/logout`

Stateless logout. Increments the user's `tokenVersion`, which invalidates all existing tokens for that user.

**Returns:** `{ success }`

---

### `GET /auth/me`

Returns the current session user (loaded fresh from DB, no password fields).

**Returns:** `{ success, user: { userId, role, email, name } }`

---

## User Management (Admin only)

### `GET /users`

List all users. Password fields excluded.

**Returns:** `{ success, users: [...] }`

---

### `POST /users`

Create a new user (admin or annotator).

**Body:**

```json
{ "name": "string", "email": "string", "password": "string", "role": "admin" | "annotator" }
```

- Validates role.
- Rejects duplicate email.
- Password min length: 6.

**Returns:** `{ success, message, userId }`

---

### `GET /users/:id`

Get a single user by ID. Password fields excluded.

**Returns:** `{ success, user }`

---

### `PATCH /users/:id`

Update name and/or email.

**Body:** `{ "name"?: "string", "email"?: "string" }`

Rejects if email is already taken by another user.

**Returns:** `{ success, message, user }`

---

### `PATCH /users/:id/status`

Toggle a user's active status (flips `isActive`). Admin cannot toggle their own status. Deactivating bumps `tokenVersion` to force logout.

**Returns:** `{ success, message, isActive }`

---

### `POST /users/:id/reset-password`

Reset a user's password.

**Body:**

```json
{ "newPassword": "string", "confirmPassword": "string" }
```

Bumps `tokenVersion` (forces re-login).

**Returns:** `{ success, message }`

---

### `DELETE /users/:id`

Hard delete a user. Admin cannot delete themselves. Blocked if the user still has datasets assigned.

**Returns:** `{ success, message }`

---

## Datasets & Import

### `POST /datasets/import`

**Admin only. Multipart form-data.**

**Fields:**
| Field | Required | Notes |
|---|---|---|
| `file` | ✅ | `.csv` or `.xlsx`, max 20 MB |
| `name` | ❌ | Dataset name (defaults to filename) |
| `dedupeStrategy` | ❌ | `skip` (default) or `rename` |
| `taxonomyId` | ❌ | Attach a taxonomy at import time |

**Flow:**

1. Validates + creates dataset with `status: "pending"`.
2. Responds immediately with 202 + `datasetId`.
3. Background worker parses the file, inserts comments, writes versions, updates status.

**Returns:**

```json
{
  "success": true,
  "message": "Import started. Poll the dataset to track progress.",
  "datasetId": "ObjectId",
  "status": "pending",
  "name": "string",
  "taxonomyId": "ObjectId | null",
  "taxonomyName": "string | null"
}
```

Poll `GET /datasets/:id` until `status` is `completed` or `failed`. The document's `progress` field is updated live:

```json
{
  "progress": {
    "phase": "parsing | inserting | versions | finalizing | completed | failed",
    "processed": 0,
    "total": 0,
    "startedAt": "Date",
    "updatedAt": "Date"
  }
}
```

---

### `POST /datasets/preview`

**Admin only. Multipart form-data.** Same file as `/import` but returns a preview without persisting anything.

**Returns:**

```json
{
  "success": true,
  "preview": {
    "totalRows": 0,
    "validRows": 0,
    "missingIdOrText": 0,
    "duplicates": 0,
    "uniqueDuplicateCount": 0,
    "duplicateIds": [],
    "fileName": "string",
    "suggestedName": "string",
    "checksum": "sha256",
    "sample": [ { "sourceId", "commentText", "sentiment", "type" } ],
    "errors": []
  }
}
```

---

### `GET /datasets/stats`

**Admin only.** Workspace-wide counts for the dashboard.

**Returns:**

```json
{
  "success": true,
  "stats": {
    "totalDatasets": 0,
    "totalComments": 0,
    "annotatedComments": 0,
    "pendingComments": 0,
    "activeAnnotators": 0,
    "percentAnnotated": 0,
    "datasetsByStatus": {
      "pending": 0,
      "processing": 0,
      "completed": 0,
      "failed": 0
    },
    "activityLast7Days": [{ "date": "YYYY-MM-DD", "count": 0 }]
  }
}
```

---

### `GET /datasets`

List datasets (newest first).

**Query params:**
| Param | Notes |
|---|---|
| `status` | `pending \| processing \| completed \| failed` |
| `uploadedBy` | User ObjectId |
| `includeCounts` | `true` → adds `summary { total, annotated, pending }` |

Non-admin callers only see datasets assigned to them.

**Returns:** `{ success, datasets: [...] }`

---

### `GET /datasets/:id`

Get one dataset. When `status === "completed"`, also returns `summary`.

**Returns:** `{ success, dataset, summary }`

> **Note:** `dataset.status` tracks the **import job only**. `"completed"` means the file finished importing — not that every comment is annotated. Use `summary.annotated / summary.total` for annotation progress.

---

### `PATCH /datasets/:id/assign`

**Admin only.** Assign or unassign an annotator.

**Body:** `{ "assignedTo": "userId | null" }`

**Returns:** `{ success, message }`

---

### `PATCH /datasets/:id`

**Admin only.** Rename.

**Body:** `{ "name": "string" }`

**Returns:** `{ success, message }`

---

### `POST /datasets/:id/duplicate`

**Admin only.** Deep-copy a dataset with all its comments + versions.

**Body:** `{ "name"?: "string" }` (defaults to `"<original> (copy)"`)

**Returns:** `{ success, message, datasetId, copiedComments }`

---

### `DELETE /datasets/:id`

**Admin only.** Cascade delete: dataset → all comments → all versions.

**Returns:** `{ success, message, deletedComments }`

---

## Comments CRUD

### `GET /comments`

List comments with filters + pagination.

**Query params:**
| Param | Notes |
|---|---|
| `datasetId` | ObjectId |
| `sentiment` | Any taxonomy value |
| `type` | Any taxonomy value |
| `status` | `pending \| annotated` |
| `assignedTo` | User ObjectId |
| `hideAnnotated` | `true` → only pending |
| `search` | Case-insensitive substring on `commentText` |
| `page` | Default 1 |
| `limit` | Default 50, max 200 |

**Returns:** `{ success, page, limit, total, totalPages, comments }`

---

### `POST /comments`

Manually create a single comment. Rejects duplicate `sourceId` within the same dataset.

**Body:**

```json
{ "datasetId", "sourceId", "commentText", "sentiment"?, "type"? }
```

Values are validated against the dataset's taxonomy. Creates version v1 with `changeType: "create"`.

**Returns:** `{ success, message, commentId }`

---

### `GET /comments/export`

Export filtered comments as CSV or XLSX.

**Query params:**
| Param | Notes |
|---|---|
| `format` | `csv \| xlsx` (default `csv`) |
| + all filters | Same as `GET /comments` |

CSV is UTF-8 BOM encoded for Excel compatibility with Bangla.

**Columns:** `id, comment_text, sentiment, type, status, version, annotatedAt`

**Response:** File download.

---

### `GET /comments/:id`

Get a single comment.

**Returns:** `{ success, comment }`

---

### `PATCH /comments/:id`

Update `commentText` only. Creates a new version with `changeType: "update"`.

**Body:** `{ "commentText": "string" }`

**Returns:** `{ success, message, version }`

---

### `DELETE /comments/:id`

**Admin only.** Delete a comment and all its versions.

**Returns:** `{ success, message }`

---

## Annotation

### `PATCH /comments/:id/annotation`

Set sentiment and/or type on a comment. Validated against the dataset's effective taxonomy.

**Body:**

```json
{ "sentiment"?: "string", "type"?: "string", "annotationNote"?: "string" }
```

**Status auto-flips:**

- `annotated` when **both** sentiment and type are set to non-sentinel values.
- `pending` otherwise.

Creates a new version with `changeType: "annotation"`.

**Returns:** `{ success, message, version }`

---

### `POST /comments/bulk-annotate`

Apply one patch to many comments in a single call.

**Body:**

```json
{ "ids": ["ObjectId", ...], "sentiment"?: "string", "type"?: "string", "annotationNote"?: "string" }
```

- Max **200** ids per call.
- At least one field must be provided.
- Values are validated per-dataset — if the request spans multiple datasets with different taxonomies, each is checked independently.
- Status auto-flips per comment.
- Writes one version per changed comment with `changeType: "bulk_annotation"`.

**Returns:** `{ success, message, requested, updated, skipped }`

---

### `POST /comments/bulk-assign`

**Admin only.** Assign or unassign many comments at once.

**Body:** `{ "ids": ["ObjectId"], "assignedTo": "userId | null" }`

Max **500** ids per call.

**Returns:** `{ success, message, updated }`

---

## Data Versioning

### `GET /comments/:id/versions`

List all versions of a comment, newest first.

**Query params:** `page` (default 1), `limit` (default 20, max 100)

**Each version contains:**

- `version`
- `snapshot` (full state at that version)
- `changedFields[]`
- `changeType` (`create | import | update | annotation | bulk_annotation | restore`)
- `restoredFrom` (only for restores)
- `changedBy`
- `createdAt`

**Returns:** `{ success, page, limit, total, totalPages, versions }`

---

### `POST /comments/:id/restore/:version`

Restore a comment to a previous version's snapshot. Creates a **new** version with `changeType: "restore"`. History is preserved — nothing is deleted.

**Returns:** `{ success, message, newVersion, restoredFrom }`

---

## Taxonomies (Admin only)

A taxonomy is a reusable set of sentiment + type options that can be assigned to any dataset.

### `GET /taxonomies`

List taxonomies. Admins see all; annotators see only active ones.

**Query params:**
| Param | Notes |
|---|---|
| `kind` | `sentiment \| type` (legacy filter, optional) |
| `isActive` | `true \| false` (admins only) |

**Returns:** `{ success, taxonomies: [...] }`

---

### `GET /taxonomies/defaults`

Built-in fallback values used when a dataset has no taxonomy assigned.

**Returns:**

```json
{
  "success": true,
  "defaults": {
    "sentiment": ["positive", "negative", "neutral", "unannotated"],
    "type": ["bangla", "english", "banglish", "unclassified"]
  }
}
```

---

### `GET /taxonomies/for-dataset/:datasetId`

Effective taxonomy for a dataset. If the dataset has no taxonomy, returns defaults. Annotators must be assigned to the dataset.

**Returns:**

```json
{
  "success": true,
  "datasetId": "ObjectId",
  "taxonomyId": "ObjectId | null",
  "taxonomyName": "string",
  "sentiment": [ { "value", "label", "order" } ],
  "type": [ { "value", "label", "order" } ]
}
```

---

### `POST /taxonomies`

**Admin only.**

**Body:**

```json
{
  "name": "string",
  "description"?: "string",
  "sentiment": [ { "value"?, "label": "string", "order"?: 0 } ],
  "type": [ { "value"?, "label": "string", "order"?: 0 } ]
}
```

- Each list must have at least one item, max 50.
- `value` is auto-slugified from `label` if omitted.
- Duplicate `value`s within a list are rejected.
- Sentinels `unannotated` / `unclassified` are auto-added so status logic keeps working.

**Returns:** `{ success, message, taxonomyId }`

---

### `GET /taxonomies/:id`

Get one taxonomy. Annotators can only view active ones.

**Returns:** `{ success, taxonomy }`

---

### `PATCH /taxonomies/:id`

**Admin only.** Partial update — name, description, `isActive`, and/or the option lists.

**Returns:** `{ success, message }`

---

### `DELETE /taxonomies/:id`

**Admin only.**

- Default: **soft-delete** (sets `isActive: false`).
- With `?hard=true`: hard-delete, but **blocked** if any dataset still references it.

**Returns:** `{ success, message }`

---

### `PATCH /taxonomies/:id/assign/:datasetId`

**Admin only.** Assign a taxonomy to a dataset.

**Returns:** `{ success, message }`

---

### `DELETE /taxonomies/:id/assign/:datasetId`

**Admin only.** Unassign a taxonomy from a dataset — the dataset falls back to defaults.

**Returns:** `{ success, message }`

---

## Audit Log (Admin only)

### `GET /audit`

List audit entries with filters + pagination.

**Query params:**
| Param | Notes |
|---|---|
| `page` | Default 1 |
| `limit` | Default 50, max 200 |
| `action` | Filter by action name (e.g. `dataset.import_started`) |
| `actorId` | Filter by user ObjectId |
| `targetType` | `user \| dataset \| comment \| taxonomy` |
| `targetId` | Filter by target ObjectId |
| `from` | ISO date, inclusive lower bound on `at` |
| `to` | ISO date, inclusive upper bound on `at` |

**Returns:** `{ success, page, limit, total, totalPages, entries }`

---

### `GET /audit/actions`

Distinct action names ever recorded — for filter dropdowns.

**Returns:** `{ success, actions: ["auth.login", "dataset.import_started", ...] }`

---

## Analytics

All analytics endpoints require authentication. Dataset-scoped endpoints allow admins + the assigned annotator; global endpoints are admin-only.

### `GET /analytics/dataset/:id`

Full analytics for one dataset.

**Returns:**

```json
{
  "success": true,
  "dataset": { "_id", "name", "status", "taxonomyId", "taxonomyName" },
  "overview": {
    "totalComments", "annotatedComments", "pendingComments",
    "percentAnnotated", "duplicateCount"
  },
  "statusBreakdown": { "pending": 0, "annotated": 0 },
  "sentiment": {
    "total", "classes",
    "distribution": [ { "label", "count", "percent" } ],
    "max", "min", "imbalanceRatio",
    "entropy", "maxEntropy", "balanceScore", "gini"
  },
  "type": { ...same shape... },
  "lengthHistogram": [ { "label": "0–19", "count": 0 } ],
  "activity": [ { "date": "YYYY-MM-DD", "count": 0 } ],
  "readiness": { "level": "ready|close|needs_work|not_ready|empty", "score": 0, "reasons": [] },
  "warnings": [ { "kind", "severity": "high|medium|low", "message" } ]
}
```

---

### `GET /analytics/global`

**Admin only.** Top-level stats + charts for the admin dashboard.

**Returns:**

```json
{
  "success": true,
  "overview": {
    "totalComments", "annotatedComments", "pendingComments",
    "totalDatasets", "totalUsers", "activeUsers", "percentAnnotated"
  },
  "sentiment": { ...same shape as dataset summary... },
  "type": { ...same shape... },
  "activityLast14Days": [ { "date": "YYYY-MM-DD", "count": 0 } ],
  "datasetsByStatus": { "pending": 0, ... },
  "topDatasets": [ { "_id", "name", "status", "total", "annotated", "percent" } ]
}
```

---

### `GET /analytics/dataset/:id/export-ml`

Export annotated comments as a train/val/test split, ready for ML training.

**Query params:**
| Param | Default | Notes |
|---|---|---|
| `format` | `jsonl` | `jsonl \| csv \| xlsx` |
| `split` | `0.8,0.1,0.1` | Three numbers summing to 1 |

**Returns:** File download containing all annotated comments with columns/fields:
`id, text, sentiment, type, split, dataset, taxonomy`

---

## Endpoint Summary

| Group             | Count  |
| ----------------- | ------ |
| Bootstrap         | 2      |
| Authentication    | 3      |
| User Management   | 7      |
| Datasets & Import | 9      |
| Comments CRUD     | 5      |
| Annotation        | 3      |
| Data Versioning   | 2      |
| Taxonomies        | 9      |
| Audit Log         | 2      |
| Analytics         | 3      |
| **Total**         | **45** |
