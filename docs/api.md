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
- [Media · Label Sets](#media--label-sets)
- [Media · Datasets](#media--datasets)
- [Media · Assets & Files](#media--assets--files)
- [Media · Annotations](#media--annotations)
- [Media · Export](#media--export)
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

## Media · Label Sets

The class vocabulary for the image/video domain. A label set's **slug**
(`value`) is what appears in every export, so changing a `label` text does not
break an existing training set.

### `GET /media/label-sets`

Returns the active label sets, sorted by name.

**Returns:** `200`
```json
{ "success": true, "data": [
  { "_id": "...", "id": "...", "name": "Road Signs",
    "labels": [ { "value": "stop_sign", "label": "Stop Sign", "color": "hsl(0, 65%, 55%)" } ],
    "isActive": true }
] }
```

**Query params:** `includeInactive=true` also returns deactivated sets.

### `POST /media/label-sets` — admin only

**Body:**
```json
{ "name": "Road Signs",
  "description": "signs and markings",
  "labels": [ { "label": "Stop Sign" }, { "label": "Traffic Light", "color": "#ff0000" } ] }
```

A label may be given as a plain string or as `{ label, color }`. `value` is
derived by slugifying `label` (`"Stop Sign"` → `stop_sign`), which is what makes
the class name stable across renames.

**Returns:** `201` with the created set.

**Errors:**
- `400` — no labels, a blank label, or a label with no sluggable characters
- `400` — two labels that slug identically (`"Cat"` and `"cat"`), which would
  export as one indistinguishable class
- `409` — duplicate name

### `PATCH /media/label-sets/:id` — admin only

**Body:** any of `name`, `description`, `labels`, `isActive`.

**Errors:** `400` if `labels` is supplied and the new set has no labels, or
duplicates slugs. `404` if unknown.

### `DELETE /media/label-sets/:id` — admin only

**Errors:** `409` if any dataset is still bound to this set — unbind them first.

---

## Media · Datasets

### `GET /media/datasets`

**Query params:** `page` (default `1`), `limit` (default `50`, max `200`).

**Returns:** `200` with `{ datasets, total, page, limit, totalPages }`. Each
dataset carries denormalised counters (`totalAssets`, `annotatedAssets`,
`totalAnnotations`, `totalBytes`, `annotatedRatio`) so the list view is one
query rather than an aggregate per row.

### `POST /media/datasets` — admin only

**Body:**
```json
{ "name": "Cityscapes subset", "mediaKind": "image", "labelSetId": "...", "description": "" }
```

`mediaKind` is `image` | `video` | `mixed`. `mixed` allows both in one dataset
but blocks per-dataset format assumptions.

**Returns:** `201` with the dataset plus a `stats` block.

**Errors:** `400` blank name or bad `mediaKind`; `404` unknown `labelSetId`.

Dataset names are **not** unique, matching the text domain.

### `GET /media/datasets/:id`

**Returns:** `200` `{ ...dataset, stats }`. `404` if unknown.

### `PATCH /media/datasets/:id` — admin only

**Body:** `name`, `description`, `mediaKind`, `labelSetId`.

**Errors:** `400` if `labelSetId` is changed **after annotations exist** — the
existing boxes would carry class names that no longer exist. Delete the
annotations first.

### `GET /media/datasets/:id/stats`

**Returns:** `200`
```json
{ "byStatus": { "pending": 1, "annotated": 1 },
  "byKind": { "image": 2, "video": 0 },
  "labelHistogram": [ { "label": "traffic_light", "count": 12 } ],
  "totalBoxes": 12,
  "classBalance": 0.94 }
```

`labelHistogram` counts **boxes only** — classifications are not per-class box
counts. `classBalance` is normalised Shannon entropy of the box distribution:
`0` means every box has the same class (useless for training), `1` means
perfectly balanced.

### `DELETE /media/datasets/:id` — admin only

Cascades: annotation versions → annotations → assets → **the dataset's
directory on disk** → the dataset row.

Records go first, files second. If the process dies partway the worst outcome is
an orphaned file (wasted disk, invisible to the app) rather than a record
pointing at a file that is gone.

**Returns:** `200` `{ deletedCount, assets, annotations }` — the last two are
the cascaded counts, not deletions of the same rows.

---

## Media · Assets & Files

### `GET /media/datasets/:id/assets`

**Query params:** `page`, `limit` (default `50`, max `500`), `sortBy`,
`sortDir` (`asc`|`desc`), `status`, `kind`, `excludeAnnotated=true`.

**Returns:** `200` `{ assets, total, page, limit, totalPages }`.

### `POST /media/datasets/:id/assets` — admin only

`multipart/form-data`, field name **`files`** (repeatable).

**Returns:**
- `201` — every file stored
- `207` — **partial success.** Some files were rejected; the body names them.
  A folder upload is a batch, so one bad file must not be reported as a clean
  import.
- `400` — a file's extension is not on the allow-list, or a limit was exceeded

**Returns body:**
```json
{ "success": true,
  "data": { "stored": [ { "id": "...", "originalFileName": "a.png", "width": 640, ... } ],
            "failed": [ { "name": "b.exe", "error": "Unsupported file type \".exe\"..." } ] } }
```

**Errors and limits:**
- `400` — extension not allowed, `MEDIA_MAX_FILES` files, `MEDIA_MAX_UPLOAD_MB`
  per file, or dimensions over `MEDIA_MAX_PIXELS` (decompression-bomb guard)
- `409` is **not** used: a duplicate checksum becomes a `failed` entry instead,
  so a folder upload reports it as one rejected file of many

**The extension is the authority on file type, not the browser-supplied MIME
type**, which is attacker-controlled. Uploads are buffered in memory before
being written, so `MEDIA_MAX_UPLOAD_MB` is a memory cap too.

### `GET /media/assets/:id`

Returns the asset DTO. It includes `width`, `height`, `durationMs`,
`annotationCount`, derived `status`, and a ready-made `fileUrl`. It does
**not** include `storagePath` — the client never learns where a file lives.

### `GET /media/assets/:id/file`

Streams the bytes. **Requires a valid token** — media is never served as a
static directory.

**Headers:** supports `Range`, answering `206 Partial Content` with
`Content-Range`. An unsatisfiable range answers `416`.

**Returns:** `200` the file, `206` a byte range, `410 Gone` if the row exists
but its bytes are no longer on disk, `404` if the asset is unknown.

### `PATCH /media/assets/:id`

**Body:** `{ "assignedTo": "<userId>" }` or `{ "assignedTo": null }` to unassign.

### `DELETE /media/assets/:id` — admin only

Removes the annotation versions, the annotations, the record, and the file.

---

## Media · Annotations

Two kinds: **`bbox`** (a rectangle) and **`classification`** (a whole-image
label). Geometry is stored normalised to `0..1` so a box means the same thing
on any image size.

### `POST /media/assets/:id/annotations`

**Body — bounding box:**
```json
{ "kind": "bbox", "label": "traffic_light",
  "box": { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 },
  "note": "optional" }
```

Set `"pixelSpace": true` to send `box` in pixels against the asset's own
dimensions instead — this is what a drawing canvas naturally produces, and it
removes a class of client-side rounding bug. It requires known dimensions, and
that requirement is enforced rather than assumed.

**Body — video frame:**
```json
{ "kind": "bbox", "label": "car",
  "box": { "x": 0, "y": 0, "width": 1, "height": 1 },
  "frameIndex": 30, "timestampMs": 1000 }
```

Send `timestampMs`, `frameIndex`, or both. A frame index alone is only accepted
when the duration is known — a frame number with no known frame rate has no
defined scale.

**Body — classification:**
```json
{ "kind": "classification", "label": "daytime" }
```

**Returns:** `201` with the annotation, including **both** box forms:

```json
{ "_id": "...", "id": "...", "kind": "bbox", "label": "traffic_light",
  "box":       { "x": 0.1, "y": 0.2, "width": 0.3, "height": 0.4 },
  "boxPixels": { "x": 64,  "y": 96,  "width": 192, "height": 192 },
  "frameIndex": null, "timestampMs": null, "revision": 1 }
```

`boxPixels` is present only when the asset's dimensions are known, because COCO
export and most drawing APIs want pixels.

**Errors:**
- `400` — a `label` not in the dataset's bound label set; zero-area or negative
  box; a box entirely off-canvas; a non-numeric coordinate
- `400` — a `timestampMs` beyond the video's duration

A box dragged partly off-canvas is **clamped**, not rejected: the left edge
moves to `0` and the width is re-capped to `1 - left`.

### `GET /media/assets/:id/annotations`

**Returns:** `200` with an array of annotation DTOs.

### `GET /media/datasets/:id/annotations`

**Query params:** `page`, `limit`, `sortBy`, `sortDir`, plus the filters
`label`, `kind`, `frameIndex`, `timestampMsFrom`, `timestampMsTo`.

**Returns:** `200` `{ annotations, total, page, limit, totalPages }`.

### `PATCH /media/annotations/:id`

**Body:** any of `label`, `box`, `note`, `frameIndex`, `timestampMs`.

Each change **appends** a version and bumps `revision`. A no-op update is not
recorded.

**Returns:** `200` with the updated annotation.

### `DELETE /media/annotations/:id`

Appends a `delete` version — the record that the annotation existed, what it
contained, and who removed it — then removes the row.

### `GET /media/annotations/:id/history`

**Returns:** `200` with the version list, newest first. Each entry has
`revision`, `snapshot`, `changeType` (`create` | `update` | `delete` |
`restore`), `changedFields`, `changedBy` and `createdAt`.

Works for a **deleted** annotation too, because the delete leaves its version
rows behind precisely so the history stays readable. An id with neither a live
row nor any history is a `404`.

### `POST /media/annotations/:id/restore`

Restores a **deleted** annotation. Creates a *new* annotation at `revision` 1
that links back via `restoredFrom`; it does not resurrect the old row. That
keeps history append-only — the delete and the restore are both visible, and
neither rewrites the other.

**Returns:** `201` with the new annotation.

**Errors:** `400` if the annotation still exists (use `PATCH` to revert a live
one), `404` if it has no history.

---

## Media · Export

### `GET /media/datasets/:id/export`

**Query params:**

| Param | Default | Notes |
| --- | --- | --- |
| `format` | `coco` | `coco` \| `yolo` \| `csv` |
| `includeUnannotated` | `false` | Include assets with no annotations |
| `kind` | — | Restrict to `bbox` or `classification` |
| `path` | `../` | Path written into YOLO's `data.yaml` |

**`format=coco`** → `application/json`, the bare COCO object (not wrapped):
```json
{ "info": { ... }, "licenses": [],
  "images":  [ { "id": 1, "file_name": "a.png", "width": 640, "height": 480 } ],
  "annotations": [ { "id": 1, "image_id": 1, "category_id": 2,
                     "bbox": [64, 96, 192, 192], "area": 36864,
                     "iscrowd": 0, "segmentation": [] } ],
  "categories": [ { "id": 1, "name": "stop_sign" } ] }
```

COCO wants **absolute pixels**, so `bbox` is `[x, y, width, height]` in pixel
space and `area` is `width × height`. Category ids are stable and derived from
the label set.

**`format=yolo`** → JSON map of `filename → contents`, because YOLO is a
directory rather than a single file and a real zip would need a dependency:
```json
{ "classes.txt": "stop_sign\ntraffic_light\n",
  "data.yaml": "path: ../\nnc: 2\nnames: [stop_sign, traffic_light]\n",
  "labels/a.txt": "1 0.25 0.4 0.3 0.4\n" }
```

Each label line is `<classIndex> <cx> <cy> <w> <h>`, all **normalised 0..1**,
which is what YOLO expects. Classes and indices come from the same label set as
COCO, so a dataset exported to both stays consistent.

**`format=csv`** → `text/csv` download, one row per annotation, with proper
quoting.

**Errors:** `400` unknown format, `404` unknown dataset.

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

## Presence & Annotator Activity

The `presence` domain tracks who is working *right now*, how long they have
been working, and how much they have finished. It is deliberately lightweight:
a heartbeat is the only thing that keeps a session alive, status is derived at
read time from `lastSeenAt` (never stored), and no keystrokes or per-event logs
are recorded.

### `POST /presence/heartbeat`

The single endpoint any authenticated user calls. The server defines the
interval and returns it, so the client never hard-codes the cadence.

**Headers:** `Authorization: Bearer <token>`

**Body:**
```json
{
  "sessionKey": "string (8-64 chars, A-Za-z0-9_-)",
  "state": "active | idle | away",
  "action": "optional short label",
  "targetType": "optional",
  "targetId": "optional"
}
```

**Returns:**
```json
{
  "success": true,
  "sessionId": "string",
  "sessionKey": "string",
  "status": "active | idle | away | offline",
  "serverTime": "ISO-8601",
  "heartbeatIntervalMs": 15000,
  "idleAfterMs": 60000,
  "offlineAfterMs": 180000
}
```

**How active time is counted:** the delta between this heartbeat and the
previous one is credited to whichever state the *previous* heartbeat claimed
(`lastState`). The delta is capped at `2 * heartbeatIntervalMs` so a laptop
that was asleep does not accrue phantom hours.

### `GET /presence/me`

The caller's own presence (used for their header indicator).

**Returns:** `{ success, status, sessions[], activeMsToday }`

### `GET /presence/board` (Admin)

Live team board — one row per user, online first.

**Query:** none  
**Returns:**
```json
{
  "success": true,
  "serverTime": "ISO-8601",
  "today": "YYYY-MM-DD",
  "totals": { "users": 12, "active": 5, "idle": 3, "away": 1, "offline": 3, "activeMsToday": 123456789, "outputToday": 47 },
  "thresholds": { "heartbeatIntervalMs": 15000, "idleAfterMs": 60000, "offlineAfterMs": 180000 },
  "rows": [
    {
      "userId": "...",
      "name": "Asha",
      "email": "asha@example.com",
      "role": "annotator",
      "isActive": true,
      "status": "active",
      "sessionCount": 1,
      "activeMsToday": 10800000,
      "annotationsToday": 3,
      "commentsToday": 2,
      "outputToday": 5,
      "lastActiveAt": "ISO-8601",
      "lastAction": "annotating asset 7f3a",
      "lastActionAt": "ISO-8601",
      "lastTargetId": "..."
    }
  ]
}
```

### `GET /presence/users/:userId` (Admin)

One annotator's history — per-day series + recent annotations.

**Query:** `?days=14` (1..90, default 14)  
**Returns:** `{ user, status, totalActiveMs, sessionCount, days, series[], sessions[], recentAnnotations[] }`

### `POST /presence/sweep` (Admin)

Manual cleanup of sessions older than `PRESENCE_RETENTION_DAYS` (also runs at boot).

**Returns:** `{ success, deletedCount, cutoff }`

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
| Media · Label Sets | 4      |
| Media · Datasets  | 6      |
| Media · Assets    | 6      |
| Media · Annotations | 7    |
| Media · Export    | 1      |
| Audit Log         | 2      |
| Analytics         | 3      |
| Presence          | 5      |
| **Total**         | **74** |
