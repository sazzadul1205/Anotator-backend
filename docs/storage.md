# Storage Architecture — Provider Strategy & the Model Bulwark

**Status:** implemented
**Default provider:** `mongo` (unchanged behaviour)
**Alternative provider:** `json` (in-app JSON files)

This document explains how the application is decoupled from its data
provider, how to switch providers, and what the abstraction does and does not
guarantee.

---

## 1. Why this exists

Before this refactor, environment variables and MongoDB were woven through
the code:

- `config/db.js` read `MONGO_URI` and `DB_NAME` and built a `MongoClient` at
  require time.
- Every model called `getDB().collection(...)` and built Mongo query
  documents (`$in`, `$regex`, aggregation pipelines) inline.
- `server.js`, `middleware/auth.js`, `services/authService.js` and
  `config/concurrency.js` each reached into `process.env` on their own.
- Required-variable knowledge was scattered across four files, and it was
  impossible to boot the app without a database.

The goal was a system where **the choice of data provider is a configuration
value, and the business logic cannot tell which one is in use.**

---

## 2. The three layers

```
                 ┌──────────────────────────────────────────────┐
   HTTP layer    │ routes → controllers → services              │
                 │ knows models, never storage, never env vars   │
                 └───────────────────────┬──────────────────────┘
                                         │  require("../models")
                 ┌───────────────────────▼──────────────────────┐
   The bulwark   │ models/index.js   — dispatches by DATA_PROVIDER│
                 │ models/contract.js — machine-checked surface   │
                 ├───────────────────────┬──────────────────────┤
                 │ models/shared/        │ DTOs, filters, patches,│
                 │ provider-agnostic     │ id rules, aggregations │
                 ├───────────────────────┬──────────────────────┤
                 │ models/mongo/         │ models/json/          │  strategies
                 └───────────┬───────────┴──────────┬───────────┘
                             │                      │
                 ┌───────────▼──────────┐  ┌────────▼─────────┐
   Config layer  │ config/storage/      │  │ JSON files on    │
                 │  index.js registry   │  │ disk             │
                 │  mongo.js  json.js   │  └──────────────────┘
                 │  schema.js           │
                 │  jsonStore.js        │
                 └───────────┬──────────┘
                                 │ require("../config/app")
                 ┌───────────▼──────────┐
   Environment   │ config/app.js        │  the ONLY module that
                 │ the only process.env │  reads process.env
                 └──────────────────────┘
```

Read it bottom-up: the environment knows nothing about storage, storage knows
nothing about models, and the model layer knows nothing about HTTP.

---

## 3. Switching providers

Change one variable in `.env` and restart:

```ini
DATA_PROVIDER=mongo     # default — MongoDB
DATA_PROVIDER=json      # in-app JSON files
```

That is the entire switch. Both providers are configured side by side, so a
rollback is changing the value back:

```ini
DATA_PROVIDER=json      # try the new system
DATA_PROVIDER=mongo     # back to production, instantly
```

Configuration is namespaced per provider, so you can keep Mongo credentials in
place while testing the JSON store:

| Variable            | Used by     | Default          |
| ------------------- | ----------- | ---------------- |
| `DATA_PROVIDER`     | both        | `mongo`          |
| `MONGO_URI`         | `mongo`     | *(required)*     |
| `DB_NAME`           | `mongo`     | `annotator_db`   |
| `DNS_SERVERS`       | `mongo`     | *(unset)*        |
| `JSON_DATA_DIR`     | `json`      | `data/json`      |
| `JSON_WRITE_THROUGH`| `json`      | `true`           |

`MONGO_URI` is only required when the provider is `mongo`. `validateEnv()`
reports every problem at once rather than failing one restart at a time, and
`config/app.js` exposes `collectProblems()` for a side-effect-free check.

`GET /health` reports the active provider, so a deploy can confirm which one
actually booted:

```json
{
  "success": true,
  "db": "ok",
  "storage": {
    "provider": "json",
    "ready": true,
    "detail": { "dir": "/srv/annotator/data/json", "collections": ["users", "..."] }
  }
}
```

---

## 4. `config/app.js` — the environment boundary

Every `process.env` read in the backend now happens in this one file, through
typed helpers (`str`, `int`, `bool`, `list`, `oneOf`) that validate ranges and
warn on bad values. Modules import the resolved `config` object instead.

This is what makes the rest of the refactor possible: a module's behaviour is a
function of an injectable object rather than of ambient global state, so both
providers can be exercised in a single process during testing.

The rule for contributors: **do not read `process.env` outside
`config/app.js`.** `eslint` does not enforce it yet; it is on the list of
lint rules to add.

---

## 5. `config/storage/` — the provider strategy

### 5.1 The provider contract

A strategy is any module exposing:

| Member         | Signature             | Purpose                                    |
| -------------- | --------------------- | ------------------------------------------ |
| `name`         | `string`              | `mongo` or `json`                          |
| `connect()`    | `→ Promise<store>`    | Open the store                             |
| `getStore()`   | `→ store \| null`     | Handle, or `null` until connected          |
| `ping()`       | `→ Promise<boolean>`  | Readiness probe; must not throw            |
| `ensureSchema()`| `→ Promise<void>`     | Apply indexes / constraints                |
| `close()`      | `→ Promise<void>`     | Flush and release                          |
| `describe()`   | `→ object`            | Non-throwing status for `/health`           |

### 5.2 The registry

`config/storage/index.js` is the only module that knows both providers exist.
It exposes provider-neutral verbs — `init()`, `getStore()`, `ping()`,
`close()`, `status()` — and `server.js` uses nothing else. Providers are
required **lazily**, so running on `json` never loads the `mongodb` driver.

### 5.3 `config/storage/schema.js` — one schema, two providers

Collections and indexes are declared once. The Mongo provider turns each entry
into a real `createIndex()`; the JSON provider turns the `unique: true` entries
into in-code constraint checks and ignores the rest (a JSON file has no index
engine).

Two consequences worth knowing:

- Index names are generated the way MongoDB names them (`email_1`,
  `datasetId_1_createdAt_-1`), so applying the schema to a database whose
  indexes were created earlier is a no-op instead of an `IndexOptionsConflict`.
- `system_locks._id` is declared unique. Mongo satisfies that implicitly, so
  the provider skips creating it; the JSON provider enforces it in code.

### 5.4 The JSON store (`config/storage/jsonStore.js`)

A small document store that implements the subset of the MongoDB collection
API the models use:

| Supported                                        | Not supported |
| ------------------------------------------------ | ------------- |
| `findOne`, `find` (sort/skip/limit/projection)   | `aggregate()` |
| `countDocuments`, `distinct`                     | transactions  |
| `insertOne`, `insertMany` (incl. `ordered:false`) |               |
| `updateOne`, `updateMany` (`$set`/`$inc`/`$unset`/`$setOnInsert`, dotted paths) | |
| `bulkWrite`, `deleteOne`, `deleteMany`            | |

Design points that matter for correctness:

- **Filters are real Mongo query documents.** Because the store understands
  `$in`, `$ne`, `$regex`, `$exists`, `$lt`/… the two model implementations
  differ *only* in their aggregation methods. That is what makes the
  abstraction trustworthy rather than a coincidence.
- **Query semantics are Mongo-compatible where it matters.** In particular
  `{ field: null }` matches documents where the field is null *or absent*,
  which is what makes "unassigned" queries (`assignedTo: null`) behave the
  same on both providers.
- **Ids are 24-char hex strings**, generated identically to an ObjectId hex
  string. Ids are opaque strings above the model layer, so nothing downstream
  can tell the difference.
- **Dates survive the round trip.** They are encoded as `{ "$date": "…" }`, so
  a genuine string that looks like a timestamp is never silently converted.
- **Durability.** Every mutation is appended to a per-collection write queue
  and flushed with write-to-temp + `rename`, so a crash cannot leave a
  half-written file. `JSON_WRITE_THROUGH=false` batches writes for throughput
  at the cost of possibly losing the last few writes on a hard kill.
- **Duplicate keys throw `code: 11000`**, the same code the Mongo driver uses,
  so the models' `translateError` → `DuplicateKeyError` path is identical.

### 5.5 Known limits of the JSON provider

Stated plainly, because a strategy is only useful if its trade-offs are known:

| Limit                        | Consequence                                                        |
| ---------------------------- | ------------------------------------------------------------------ |
| **Single process only**      | Two server processes on one directory is *not* supported. Writes are serialised within a process, not across processes. |
| **No secondary indexes**     | Filtering is a linear scan. Fine for thousands of rows; slow for hundreds of thousands. |
| **Aggregations in JS**       | `$group`/`$bucket`/`$lookup` equivalents run in memory, so they scale with collection size. |
| **Whole-file rewrites**      | A mutation rewrites its collection file. Acceptable while `comment_versions` stays modest; a rewrite-heavy deployment will feel it. |
| **No transactions**          | Same as MongoDB today — cascades are already multi-step (see `docs/models.md` §7.10). |

The provider targets development, evaluation, demos, and single-instance
deployments. MongoDB remains the default for production.

---

## 6. `models/` — the bulwark

### 6.1 What it guarantees

1. **Ids are opaque strings.** No `ObjectId` ever leaves `models/`.
2. **DTOs are the only shape above the layer.** Services cannot see a raw
   document, and cannot accidentally depend on a field the mapper omits.
3. **Driver errors never leak.** Both providers translate their native
   duplicate-key error into `DuplicateKeyError` from `models/errors.js`.
4. **Write methods return small summaries** — `{ id }`,
   `{ matchedCount, modifiedCount }`, `{ deletedCount }`, `{ entries, total }`.
5. **The method surface is machine-checked.** `models/contract.js` lists
   every method each model must provide, and `models/index.js` verifies the
   loaded strategy against it at require time.

### 6.2 How much is shared

| Shared (`models/shared/`)       | Provider-specific                          |
| ------------------------------- | ------------------------------------------ |
| `dto.js` — DTO mappers          | `mongo/` — ObjectId, aggregation pipelines |
| `filters.js` — filter + patch semantics | `json/` — string ids, JS aggregations  |
| `ids.js` — id string rules      | `oid.js` (mongo only) — the id adapter     |
| `aggregate.js` — grouping/bucketing primitives | |

The two model folders are deliberately **method-for-method parallel**. When you
add a method to `models/mongo/Comment.js`, add it to `models/json/Comment.js`
and to `CONTRACT` in `models/contract.js`. Forgetting the last step makes the
next boot fail with a precise list of gaps instead of a `TypeError` in
production.

Adding a third provider is: one folder of seven model classes, one entry in
`STRATEGIES` (`models/index.js`), and one entry in `PROVIDERS`
(`config/storage/index.js`).

### 6.3 The one thing that is not shared

`Comment.groupByField` and `Comment.lengthHistogram` receive a `datasetId`.
Both providers return `[]` when it is invalid, and both match *all* comments
when it is `null`. That is pre-existing behaviour, preserved deliberately so
the two providers agree — see `docs/models.md` §7.2.

---

## 7. Verification

### 7.1 The test matrix

`npm test` runs everything below and prints a summary. Each end-to-end run is
isolated: a private port, a private store, and for MongoDB a throwaway
database that is dropped afterwards — your configured database and any server
you already have running are never touched.

| Suite                       | Kind       | Checks | Proves                                                        |
| --------------------------- | ---------- | ------ | ------------------------------------------------------------- |
| `tests/unit/json-store.test.js` | unit   | 42     | The JSON store's query/update/constraint/durability semantics |
| `tests/unit/config.test.js` | unit       | 19     | The provider switch and what each provider requires            |
| `tests/unit/contract.test.js` | unit     | 29     | The bulwark: both strategies satisfy the same contract         |
| `tests/storage-parity.js`   | parity     | 95     | Both strategies behave identically, field for field            |
| `tests/api-test.js` (json)  | end-to-end | 55     | The whole HTTP API works on the JSON provider                  |
| `tests/api-test.js` (mongo) | end-to-end | 55     | The whole HTTP API still works on MongoDB                      |

`npm run test:unit` needs no server, no database and no network. Without a
`MONGO_URI`, the MongoDB half of the parity and end-to-end suites is reported as
skipped rather than failed, so the JSON provider is fully testable on a machine
with no database at all.

### 7.2 Contract check

`models/index.js` calls `verifyContract()` when a strategy loads. A missing or
renamed method is a boot-time error naming the provider and the gap:

```
Model contract violation (provider "json"):
  - Comment.groupByField: missing
```

`tests/unit/contract.test.js` additionally asserts that the two strategies
expose *identical* method names, which is stronger than "both satisfy the list".

### 7.3 Parity test

`tests/storage-parity.js` runs one ~90-step scenario — user lifecycle,
taxonomies, datasets, comment CRUD, bulk writes, partial inserts, filters,
search, pagination, every aggregation, version history, audit log, locks,
cascades, stale-import cleanup — against **both** strategies and compares the
transcripts field by field. Ids and timestamps are normalised; the two
orderings MongoDB leaves unspecified (`$group` output order, sort ties) are
compared as sets.

It uses a throwaway database (`annotator_parity_test`) and drops it afterwards.

### 7.4 End-to-end

`tests/api-test.js` (55 checks: import, annotate, bulk operations, version
restore, taxonomy binding, CSV/XLSX export, analytics, ML export, audit,
role scoping) is run against both providers by the matrix runner.

### 7.5 Cleaning up

A run that is killed mid-flight can leave a throwaway database or a temp
directory behind. `npm run clean:test` removes both, matching only against a
known test-prefix allow-list.

### 7.6 Applying the schema

`npm run init-indexes` applies whatever schema the active provider declares. It
is a no-op on `json` (constraints are enforced on write) and creates the real
indexes on `mongo`.

---

## 8. Operational notes

**Moving data between providers.** There is no migration tool yet. The current
path is export → transform → import, or a one-off script reading through the
models. Ids are format-compatible, so documents can in principle be copied
across, but the Mongo side would need its references converted to `ObjectId`.

**Backups.** On `mongo`, use the provider's backup tooling. On `json`, copy
the `JSON_DATA_DIR` directory — but only while the process is stopped, or after
`storage.close()` has flushed, since a copy taken mid-write can catch a
partially queued flush.

**Graceful shutdown.** `SIGINT`/`SIGTERM` now closes the HTTP server *and*
calls `storage.close()`, which flushes the JSON store. Previously only the HTTP
server was closed.

**Rollback.** Set `DATA_PROVIDER=mongo` and restart. No code changes are
involved, and the Mongo credentials can stay configured the whole time.

---

## 9. Known follow-ups

| Item                                          | Why it is not done yet                    |
| --------------------------------------------- | ---------------------------------------- |
| Lint rule banning `process.env` outside `config/app.js` | The rule exists in ESLint core but needs a project-specific allowance list. |
| Provider-to-provider migration tool           | Needs a real data set to design the transform against. |
| JSON store: append-only log for a collection  | `comment_versions` is append-only and would benefit; it also grows fastest. |
| Index a JSON `comments` collection on `datasetId` | Would need a real index structure (sparse side files) rather than a full scan. |
| A lint rule binding tests to `models/contract.js` | Would catch "method added, no test" at review time; the contract check only catches the other direction at boot. |
