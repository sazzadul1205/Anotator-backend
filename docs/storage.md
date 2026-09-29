# Storage Architecture — Provider Strategy & the Model Bulwark

**Status:** implemented
**Default provider:** `mongo` (unchanged behaviour)
**Other providers:** `sqlite`, `mysql`, `json`

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
  The bulwark    │ models/index.js   — dispatches by DATA_PROVIDER│
                 │ models/contract.js — machine-checked surface   │
                 ├───────────────────────┬──────────────────────┤
                 │ models/shared/        │ DTOs, filters, patches,│
                 │ provider-agnostic     │ id rules, aggregations │
                 ├───────────────────────┬──────────────────────┤
                 │ models/mongo/         │ models/document/     │  strategies
                 └───────────┬───────────┴──────────┬───────────┘
                             │                      │
       ┌─────────────────────▼──────────────────────▼────────────────────┐
Config │ config/storage/                                               │
 layer │   index.js    — the registry, four lazily-loaded strategies     │
       │   schema.js   — collections, column types and indexes           │
       │   mongo.js  sqlite.js  mysql.js  json.js                        │
       │   jsonStore.js          — document store (json)                │
       │   sql/  store.js translate.js dialect.js ensureSchema.js        │
       │         sqliteDriver.js  mysqlDriver.js   (sqlite + mysql)     │
       └─────────────────────────────┬──────────────────────────────────┘
                                     │ require("../config/app")
       ┌─────────────────────────────▼──────────────────────────────────┐
Env    │ config/app.js   the ONLY module that reads process.env        │
       └────────────────────────────────────────────────────────────────┘
```

Read it bottom-up: the environment knows nothing about storage, storage knows
nothing about models, and the model layer knows nothing about HTTP.

Note that there are only **two** model strategies, not four. MongoDB needs its
own because it is the one driver with a different id type (`ObjectId`); the
`json`, `sqlite` and `mysql` providers all speak the same document API over
string ids, so they share `models/document/` and differ only in
`config/storage/`.

---

## 3. Switching providers

Change one variable in `.env` and restart:

```ini
DATA_PROVIDER=sqlite    # a real database in one file; no server, no credentials
DATA_PROVIDER=mysql     # MySQL / MariaDB
DATA_PROVIDER=json      # in-app JSON files (no indexes; tiny data only)
DATA_PROVIDER=mongo     # back to production, instantly
```

That is the entire switch. All four are configured side by side, so a rollback
is changing the value back.

Configuration is namespaced per provider, so you can keep every provider's
credentials in place while you try another:

| Variable             | Used by      | Default                   |
| -------------------- | ------------ | ------------------------- |
| `DATA_PROVIDER`      | all          | `mongo`                   |
| `MONGO_URI`          | `mongo`      | *(required)*              |
| `DB_NAME`            | `mongo`      | `annotator_db`            |
| `DNS_SERVERS`        | `mongo`      | *(unset)*                 |
| `SQLITE_FILE`        | `sqlite`     | `storage/annotator.sqlite`|
| `MYSQL_URL`          | `mysql`      | *(unset; wins over parts)*|
| `MYSQL_HOST`         | `mysql`      | `127.0.0.1`               |
| `MYSQL_PORT`         | `mysql`      | `3306`                    |
| `MYSQL_USER`         | `mysql`      | `root`                    |
| `MYSQL_PASSWORD`     | `mysql`      | *(empty)*                 |
| `MYSQL_DATABASE`     | `mysql`      | `annotator_db`            |
| `MYSQL_POOL_SIZE`    | `mysql`      | `10`                      |
| `JSON_DATA_DIR`      | `json`       | `data/json`               |
| `JSON_WRITE_THROUGH` | `json`       | `true`                    |

`MONGO_URI` is only required when the provider is `mongo`. `assertValid()`
reports every problem at once rather than failing one restart at a time, and
`config/app.js` exposes `collectProblems()` for a side-effect-free check.

Switching provider does **not** migrate data. Each store is independent and
`DATA_PROVIDER` only decides where new writes go. Moving existing documents
between providers is a separate, deliberate operation.

`GET /health` reports the active provider, so a deploy can confirm which one
actually booted:

```json
{
  "success": true,
  "db": "ok",
  "storage": {
    "provider": "sqlite",
    "ready": true,
    "detail": { "file": "/srv/annotator/storage/annotator.sqlite" }
  }
}
```

`detail` is provider-specific and never contains credentials. The frontend
reads `storage.provider` from this same endpoint and shows a warning banner when
the backend is on the JSON store.

---

## 4. `config/app.js` — the environment boundary

Every `process.env` read in the backend now happens in this one file, through
typed helpers (`str`, `int`, `bool`, `list`, `oneOf`) that validate ranges and
warn on bad values. Modules import the resolved `config` object instead.

This is what makes the rest of the refactor possible: a module's behaviour is a
function of an injectable object rather than of ambient global state, so every
provider can be exercised in a single process during testing.

The rule for contributors: **do not read `process.env` outside
`config/app.js`.** `eslint` does not enforce it yet; it is on the list of
lint rules to add.

---

## 5. `config/storage/` — the provider strategy

### 5.1 The provider contract

A strategy is any module exposing:

| Member         | Signature             | Purpose                                    |
| -------------- | --------------------- | ------------------------------------------ |
| `name`         | `string`              | `mongo`, `sqlite`, `mysql` or `json`       |
| `connect()`    | `→ Promise<store>`    | Open the store                             |
| `getStore()`   | `→ store \| null`     | Handle, or `null` until connected          |
| `ping()`       | `→ Promise<boolean>`  | Readiness probe; must not throw            |
| `ensureSchema()`| `→ Promise<void>`     | Apply tables / indexes / constraints       |
| `close()`      | `→ Promise<void>`     | Flush and release                          |
| `describe()`   | `→ object`            | Non-throwing status for `/health`           |
| `requires`     | `string[]`            | npm dependencies, for documentation        |

### 5.2 The registry

`config/storage/index.js` is the only module that knows all four providers
exist. It exposes provider-neutral verbs — `init()`, `getStore()`, `ping()`,
`close()`, `status()` — and `server.js` uses nothing else. Providers are
required **lazily**, so running on `sqlite` never loads the `mongodb` driver and
never loads `mysql2`, and running on `json` loads no driver at all.

### 5.3 `config/storage/schema.js` — one schema, four providers

Collections are declared once, each with its **column types** and its indexes:

- **Mongo** turns each index entry into a real `createIndex()` and ignores the
  column types.
- **SQLite / MySQL** turn `columns` into `CREATE TABLE` and `indexes` into
  `CREATE INDEX` / `UNIQUE` constraints.
- **JSON** turns the `unique: true` entries into in-code constraint checks and
  ignores the rest (a JSON file has no index engine).

Field types are `id`, `ref`, `str`, `long`, `int`, `bool`, `date` and `json`.
Dates are stored as ISO-8601 UTC text, which sorts and compares correctly as
text and round-trips to a JavaScript `Date`. Nested objects and arrays go in
`json` columns.

A field that is not declared still **stores** — it lands in a per-row `extra`
JSON column — but it cannot be *filtered on*, because there is no column to
compare against. The SQL layer throws on such a filter rather than quietly
returning rows that do not match the caller's intent.

Two consequences worth knowing:

- Index names are generated the way MongoDB names them (`email_1`,
  `datasetId_1_createdAt_-1`), so applying the schema to a database whose
  indexes were created earlier is a no-op instead of an `IndexOptionsConflict`.
- `system_locks._id` is declared unique. Mongo satisfies that implicitly, so
  the provider skips creating it; the SQL providers map `_id` onto the `id`
  primary key; the JSON provider enforces it in code.

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
  same on every provider.
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

### 5.5 The SQL engine (`config/storage/sql/`)

SQLite and MySQL share one implementation, because the models — not the
database — decide the semantics. `config/storage/sql/` presents the same
Mongo-shaped collection API the models were written against, so **no model code
knows it is talking to SQL.**

| File | Role |
| ---- | ---- |
| `store.js` | The `Db` handle and the collection API: `findOne`, `find`, `countDocuments`, `distinct`, `insertOne`, `insertMany`, `updateOne`, `updateMany`, `bulkWrite`, `deleteOne`, `deleteMany`. |
| `translate.js` | Document ↔ row conversion, filter → `WHERE`, update operators, and value encoding. Pure functions, unit-tested without a database. |
| `dialect.js` | The SQLite-vs-MySQL differences: identifier quoting, column types, DDL, the `LIKE … ESCAPE` spelling, and how a unique violation is recognised. |
| `ensureSchema.js` | Creates the tables and indexes from `schema.js`. Idempotent. |
| `sqliteDriver.js` | `node:sqlite` wrapped in the async interface the store expects. |
| `mysqlDriver.js` | `mysql2` pooled connections in the same interface. |

One document is one row. `_id` is the `id` primary key, each declared field
becomes a typed column, and anything the schema does not declare is kept in a
per-row `extra` JSON column.

Semantics that are deliberately Mongo-shaped, because models depend on them:

- `{ field: null }` matches `NULL` — and, as in Mongo, an absent field.
- `$in: []` matches **nothing**. The shared filters rely on this: a filter whose
  every id was malformed must degrade to "match nothing".
- `$ne` / `$nin` also match rows where the field is absent.
- A `NULL` column reads as an **absent field**, not as `null`, so a row looks
  like a Mongo document to the DTO layer.
- `modifiedCount` counts rows whose value **actually changed**, so a no-op
  update reports `0`. SQLite and MySQL disagree on this natively, so the change
  is detected in JavaScript rather than trusted from the driver — services
  branch on that number.
- A unique-constraint violation surfaces as `err.code === 11000`, the same code
  the Mongo driver uses, so `translateError` → `DuplicateKeyError` is identical
  across all four providers.

Two details worth recording because they are easy to get wrong:

- **`$regex` becomes `LIKE`.** The pattern is already escaped for a regex by
  the caller; LIKE additionally needs `%` and `_` escaped, and the escape
  character must be spelled differently per engine — MySQL honours backslash
  escapes inside string literals, so the same clause is `ESCAPE '\'` on SQLite
  and `ESCAPE '\\'` on MySQL. Without that, searching for `50%` would match
  every row.
- **`deleteOne` cannot use `DELETE … LIMIT`.** That is a MySQL extension and
  SQLite rejects it, so the single-delete path selects the id first and deletes
  by primary key.

`INSERT`, `UPDATE` and `SELECT` all use **bound parameters**; a filter value is
never interpolated into SQL.

### 5.6 Known limits of the JSON provider

Stated plainly, because a strategy is only useful if its trade-offs are known:

| Limit                        | Consequence                                                        |
| ---------------------------- | ------------------------------------------------------------------ |
| **Single process only**      | Two server processes on one directory is *not* supported. Writes are serialised within a process, not across processes. |
| **No secondary indexes**     | Filtering is a linear scan. Fine for thousands of rows; slow for hundreds of thousands. |
| **Aggregations in JS**       | `$group`/`$bucket`/`$lookup` equivalents run in memory, so they scale with collection size. |
| **Whole-file rewrites**      | A mutation rewrites its collection file. Acceptable while `comment_versions` stays modest; a rewrite-heavy deployment will feel it. |
| **No transactions**          | Same as MongoDB today — cascades are already multi-step (see `docs/models.md` §7.10). |

The provider targets development, evaluation, demos, and single-instance
deployments. If you want a real query planner with no server to run, use
`sqlite` instead. MongoDB remains the default for production.

### 5.7 Known limits of the SQL providers

| Limit                          | Consequence |
| ------------------------------ | ----------- |
| **Filterable fields must be declared in `schema.js`** | Filtering on an undeclared field throws rather than silently returning the wrong rows. This is the one place the abstraction is stricter than Mongo, where any stored field is queryable. |
| **`deleteOne` is select-then-delete** | Two statements instead of one, so it is not atomic against a concurrent writer. Nothing in the app depends on that. |
| **Updates are read-modify-write** | Needed to make `modifiedCount` mean the same thing everywhere. Costs one `SELECT` per updated row. |
| **SQLite: one writer at a time** | Concurrent writers serialise on the database file. Fine for the single-process deployment it is meant for; use `mysql` or `mongo` for several. |
| **SQLite: `node:sqlite` is synchronous** | Contained behind an async interface and the file is local, so it does not block meaningfully. |
| **No migrations** | `ensureSchema` creates missing tables/indexes; it does not alter existing ones. Schema changes are additive-only today. |

---

## 6. `models/` — the bulwark

### 6.1 What it guarantees

1. **Ids are opaque strings.** No `ObjectId` ever leaves `models/`.
2. **DTOs are the only shape above the layer.** Services cannot see a raw
   document, and cannot accidentally depend on a field the mapper omits.
3. **Driver errors never leak.** Every provider translates its native
   duplicate-key error into `DuplicateKeyError` from `models/errors.js` —
   including MySQL's `ER_DUP_ENTRY` and SQLite's constraint message.
4. **Write methods return small summaries** — `{ id }`,
   `{ matchedCount, modifiedCount }`, `{ deletedCount }`, `{ entries, total }`.
5. **The method surface is machine-checked.** `models/contract.js` lists
   every method each model must provide, and `models/index.js` verifies the
   loaded strategy against it at require time.

### 6.2 How much is shared

| Shared (`models/shared/`)       | Provider-specific                          |
| ------------------------------- | ------------------------------------------ |
| `dto.js` — DTO mappers + the `_id` alias | `mongo/` — ObjectId, aggregation pipelines |
| `filters.js` — filter + patch semantics | `document/` — string ids, JS aggregations (used by `json`, `sqlite` and `mysql`) |
| `ids.js` — id string rules      | `oid.js` (mongo only) — the id adapter     |
| `aggregate.js` — grouping/bucketing primitives | |

There are only **two** model folders, not four. `models/document/` is selected
by three providers, because the differences between `json`, `sqlite` and
`mysql` live entirely in `config/storage/` — not in the models.

The two model folders are deliberately **method-for-method parallel**. When you
add a method to `models/mongo/Comment.js`, add it to `models/document/Comment.js`
and to `CONTRACT` in `models/contract.js`. Forgetting the last step makes the
next boot fail with a precise list of gaps instead of a `TypeError` in
production.

Adding a third provider is: one folder of seven model classes, one entry in
`STRATEGIES` (`models/index.js`), and one entry in `PROVIDERS`
(`config/storage/index.js`).

### 6.3 The one thing that is not shared

`Comment.groupByField` and `Comment.lengthHistogram` receive a `datasetId`.
All four providers return `[]` when it is invalid, and all match *all* comments
when it is `null`. That is pre-existing behaviour, preserved deliberately so
the providers agree — see `docs/models.md` §7.2.

---

## 7. Verification

### 7.1 The test matrix

`npm test` runs everything below and prints a summary. Each end-to-end run is
isolated: a private port, a private store, and for MongoDB and MySQL a
throwaway database that is dropped afterwards — your configured database and any
server you already have running are never touched.

| Suite                       | Kind       | Checks | Proves                                                        |
| --------------------------- | ---------- | ------ | ------------------------------------------------------------- |
| `tests/unit/json-store.test.js` | unit   | 42     | The JSON store's query/update/constraint/durability semantics |
| `tests/unit/sql-store.test.js` | unit   | 51     | Filter translation, encoding, DDL and real SQLite execution    |
| `tests/unit/config.test.js` | unit       | 24     | The provider switch and what each provider requires            |
| `tests/unit/contract.test.js` | unit     | 31     | The bulwark: both strategies satisfy the same contract         |
| `tests/storage-parity.js`   | parity     | 292    | Every provider behaves identically, field for field           |
| `tests/api-test.js` (json)  | end-to-end | 55     | The whole HTTP API works on the JSON provider                  |
| `tests/api-test.js` (sqlite)| end-to-end | 55     | …and on SQLite                                                |
| `tests/api-test.js` (mongo) | end-to-end | 55     | …and MongoDB is unchanged                                     |
| `tests/api-test.js` (mysql) | end-to-end | 55     | …and on MySQL                                                 |

**660 checks in total**, all passing — with MongoDB and MySQL both reachable
in that run, so no suite was skipped.

`npm run test:unit` needs no server, no database and no network. A provider that
is unavailable — no `MONGO_URI`, or no MySQL server on `:3306` — is reported as
**skipped** rather than failed, so `json` and `sqlite` are fully testable on a
machine with no database at all.

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
cascades, stale-import cleanup — against **every available provider** and
compares the transcripts field by field. Ids and timestamps are normalised.

Results whose *order* is not part of the contract are compared as sets:
`$group` output, `topByCommentCount`, `datasetCountByStatus`, and
`findManyByIds` (an `$in` match). MongoDB specifies no ordering for any of
these and no SQL engine promises the same, so asserting a sequence would be
asserting an accident of each engine's query planner rather than a guarantee
the application relies on.

It uses throwaway databases (`annotator_parity_test`) and drops them afterwards.

### 7.4 End-to-end

`tests/api-test.js` (55 checks: import, annotate, bulk operations, version
restore, taxonomy binding, CSV/XLSX export, analytics, ML export, audit,
role scoping) is run against **all four providers** by the matrix runner.

### 7.5 Cleaning up

A run that is killed mid-flight can leave a throwaway database (MongoDB *or*
MySQL) or a temp directory behind. `npm run clean:test` removes all of them,
matching only against a known test-prefix allow-list.

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
