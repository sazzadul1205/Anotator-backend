# Annotator Backend

A text-annotation API for building sentiment + language-labelled training data.
Handles file imports, per-dataset taxonomy assignment, versioned annotations,
audit trails, analytics and ML-ready exports.

> ⚠️ **AI-GENERATED DOCUMENTATION — READ WITH CARE**
>
> This README and the files under [`docs/`](docs/) were written/refreshed by an
> AI coding assistant from a static reading of the source code, last reviewed at
> commit `742c536` (2026-09-24), plus later passes covering the storage-provider
> refactor and the addition of the SQLite and MySQL providers. They are
> best-effort explanations, **not** authoritative specifications: they can drift
> out of date and may contain mistakes.
>
> **The code is the source of truth.** When a document and the code disagree,
> trust the code (`routes/` for paths and guards, `models/` for storage
> behaviour). Verify anything security- or data-critical against the source.

---

## Table of contents

- [Features](#features)
- [Requirements](#requirements)
- [Setup](#setup)
- [Environment variables](#environment-variables)
- [Project structure](#project-structure) — what each part does and why
- [Architecture](#architecture)
- [Documentation](#documentation)
- [API overview](#api-overview)
- [First-time setup flow](#first-time-setup-flow)
- [Health, queues & rate limits](#health-queues--rate-limits)
- [Testing](#testing)
- [Deployment notes](#deployment-notes)
- [License](#license)

---

## Features

- **Authentication & roles** — JWT auth with `admin` and `annotator` roles.
  Tokens carry a `tokenVersion`; bumping it revokes every token a user holds
  (logout, password reset, deactivation).
- **Bootstrap** — one-time admin creation guarded by an atomic system lock
  (`system_locks`), so concurrent requests cannot create two admins.
- **Dataset imports** — CSV + XLSX upload (20 MB) with a dry-run preview,
  `skip` or `rename` duplicate strategies, live progress phases
  (`queued → parsing → inserting → versions → finalizing → completed`) and a
  `503` answer while the import queue is full.
- **Bounded concurrency** — imports and exports run through in-process FIFO
  queues (`config/concurrency.js`) with tunable limits, timeouts and stats
  exposed on `/health`.
- **Dynamic taxonomies** — custom sentiment and language/type label sets,
  assigned per dataset, with per-dataset validation of every annotation.
- **Annotation workflow** — per-comment and bulk annotation (up to 200 rows per
  call) with automatic status flips: a comment is `annotated` only when both a
  sentiment and a type are set.
- **Full version history** — every create/import/update/annotate/restore writes
  an immutable snapshot; restoring appends a new version instead of rewriting
  history.
- **Audit log** — filterable action trail for auth, users, datasets, taxonomies
  and bulk comment operations (see the catalogue in
  [`docs/services.md`](docs/services.md#5-audit-action-catalogue)).
- **Analytics** — per-dataset and workspace dashboards: class balance (Shannon
  entropy, Gini impurity), length histograms, activity timelines, duplicate
  detection and an ML "readiness" score with warnings.
- **ML-ready export** — annotated comments as JSONL, CSV or XLSX with a
  deterministic train/val/test split.
- **Pluggable storage** — the data provider is a configuration value, not a
  code path. **MongoDB, SQLite, MySQL/MariaDB and an in-app JSON store** all
  implement the same model contract, and the business logic cannot tell which
  one is running. Every provider is covered by the same parity and end-to-end
  suites, so the switch is a tested claim rather than a best effort. See
  [`docs/storage.md`](docs/storage.md).
- **Layered codebase** — controllers (HTTP) → services (rules) → models
  (storage) → provider. Each layer is documented separately in
  [`docs/controllers.md`](docs/controllers.md),
  [`docs/services.md`](docs/services.md), [`docs/models.md`](docs/models.md)
  and [`docs/storage.md`](docs/storage.md).

---

## Requirements

- **Node.js 18+** (the code uses Express 5 and the official `mongodb` driver).
  The **SQLite** provider additionally requires **Node 22.5+**, because it uses
  the built-in `node:sqlite` module rather than a native dependency.
- A database is **optional**. `DATA_PROVIDER=sqlite` needs no server, no
  credentials and no `npm install` beyond this repo; `DATA_PROVIDER=json`
  likewise needs only a directory. Choose `mongo` (the default) or `mysql` if
  you want a real server.
- MongoDB 6+ locally, or a MongoDB Atlas cluster — only for
  `DATA_PROVIDER=mongo`.
- MySQL 8.0+ or MariaDB 10.6+ — only for `DATA_PROVIDER=mysql`.
- PowerShell 5.1+ only if you want the legacy PowerShell API test script
  (`tests/api-test.ps1`)

---

## Setup

1. **Clone and install dependencies:**

   ```bash
   git clone <repo-url>
   cd Anotator-backend
   npm install
   ```

2. **Configure the environment:**

   ```bash
   cp .env.example .env   # if you keep an example file, otherwise create .env
   ```

   Fill in the values from [Environment variables](#environment-variables).
   `server.js` validates them on boot and exits with a clear message when a
   required variable is missing. By default it wants `MONGO_URI`, `DB_NAME` and
   a 32+ character `JWT_SECRET`; setting `DATA_PROVIDER=sqlite` or
   `DATA_PROVIDER=json` removes the MongoDB requirement entirely.

3. **Apply the storage schema** (safe to re-run):

   ```bash
   npm run init-indexes
   ```

   Creates the tables, indexes and unique constraints for the active provider.
   On `mongo` that means real indexes; on `sqlite`/`mysql` it means
   `CREATE TABLE` + `CREATE INDEX`; on `json` it is a no-op, because a JSON
   file has no index engine and its unique constraints are checked in code on
   every write.

4. **Start the server:**

   ```bash
   npm run dev    # development, nodemon auto-reload
   npm start      # production
   ```

   On boot the server connects to the configured storage provider, applies its
   schema, marks stale imports as failed (`Dataset.cleanupStaleImports`, imports
   stuck for > 30 minutes) and then listens on `PORT` (default `5000`).

   Confirm which provider actually came up:

   ```bash
   curl http://localhost:5000/health | jq .storage
   # { "provider": "sqlite", "ready": true, "detail": { "file": ".../annotator.sqlite" } }
   ```

5. **Create the first admin** — via the frontend bootstrap page or directly:

   ```http
   POST /api/auth/bootstrap
   { "name": "...", "email": "...", "password": "...", "confirmPassword": "..." }
   ```

   This only works while no admin exists; later attempts return `400`.

---

## Environment variables

| Variable | Required | Purpose | Example |
| --- | --- | --- | --- |
| `PORT` | ❌ | HTTP port (default `5000`) | `5000` |
| `NODE_ENV` | ❌ | `development` or `production` (default `development`) | `development` |
| `DATA_PROVIDER` | ❌ | **`mongo` (default), `sqlite`, `mysql` or `json`** | `sqlite` |
| `MONGO_URI` | ✅ when `DATA_PROVIDER=mongo` | MongoDB connection string | `mongodb+srv://...` |
| `DB_NAME` | ✅ when `DATA_PROVIDER=mongo` | Database name | `annotator_db` |
| `DNS_SERVERS` | ❌ | Comma-separated DNS servers for the MongoDB driver | `8.8.8.8,1.1.1.1` |
| `SQLITE_FILE` | ❌ | SQLite database file (default `storage/annotator.sqlite`) | `storage/annotator.sqlite` |
| `MYSQL_URL` | ❌ | Full MySQL connection URL; **wins** over the `MYSQL_*` parts below | `mysql://user:pw@127.0.0.1:3306/db` |
| `MYSQL_HOST` | ❌ | MySQL host (default `127.0.0.1`) | `127.0.0.1` |
| `MYSQL_PORT` | ❌ | MySQL port (default `3306`) | `3306` |
| `MYSQL_USER` | ❌ | MySQL user (default `root`) | `annotator` |
| `MYSQL_PASSWORD` | ❌ | MySQL password | `hunter2` |
| `MYSQL_DATABASE` | ❌ | MySQL database, created if missing (default `annotator_db`) | `annotator_db` |
| `MYSQL_POOL_SIZE` | ❌ | Pooled connections (default `10`); keep below the server's `max_connections` | `10` |
| `JSON_DATA_DIR` | ❌ | Directory for the JSON store (default `data/json`) | `data/json` |
| `JSON_WRITE_THROUGH` | ❌ | `true` (default) flushes every write; `false` batches | `true` |
| `JWT_SECRET` | ✅ | JWT signing key, **min 32 chars** | 64+ random hex chars |
| `CORS_ORIGIN` | ✅ in production | Comma-separated allowed origins | `https://app.example.com` |

### Switching storage providers

Set `DATA_PROVIDER` and restart. Nothing else changes — the model layer is
provider-agnostic, and the business logic never learns which one is running:

```ini
DATA_PROVIDER=sqlite  # a real database in one file; no server, no credentials
DATA_PROVIDER=mysql   # MySQL / MariaDB
DATA_PROVIDER=mongo   # back to MongoDB
DATA_PROVIDER=json    # in-app JSON files (no indexes; fine for small data)
```

All four providers' settings can stay in `.env` at the same time, so the switch
(and the rollback) is a one-line change.

| | `mongo` | `sqlite` | `mysql` | `json` |
| --- | --- | --- | --- | --- |
| Setup | Server or Atlas | One file | Server + credentials | One directory |
| Dependency | `mongodb` | none (built-in) | `mysql2` | none |
| Node | 18+ | 22.5+ | 18+ | 18+ |
| Multi-process | ✅ | ⚠️ file locks | ✅ | ❌ |
| Large datasets | ✅ indexed | ✅ indexed | ✅ indexed | ⚠️ linear scans |
| Best for | Production | Dev/CI, single instance | Production, SQL shops | Demos, tiny data |

Two things worth knowing before you pick:

- **SQLite has no `npm install` step.** It uses Node's built-in `node:sqlite`,
  so there is no native module to compile and nothing extra to audit.
- **Switching provider does not migrate data.** Each store is independent;
  `DATA_PROVIDER` picks where new writes go. Moving existing data between
  providers is a separate, deliberate operation.

See [`docs/storage.md`](docs/storage.md) for the architecture, the guarantees
the model layer makes, and each provider's limits.

Concurrency / queue tuning (all optional, read by `config/concurrency.js`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_CONCURRENT_IMPORTS` | `2` | Imports running at the same time |
| `MAX_CONCURRENT_EXPORTS` | `4` | Exports running at the same time |
| `MAX_QUEUE_SIZE` | `100` | Pending jobs per queue before new work is rejected with 503 |
| `JOB_TIMEOUT_MS` | `600000` | Import job timeout (10 min) |
| `EXPORT_TIMEOUT_MS` | `60000` | Export job timeout (1 min) |
| `QUEUE_LOG_INTERVAL_MS` | `60000` | Queue-depth log interval |

Rate-limit overrides (all optional, read by `config/app.js`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `RATE_LIMIT_GLOBAL` | `300` prod / `10000` dev | Requests per minute across `/api/**` |
| `RATE_LIMIT_AUTH` | `5` prod / `1000` dev | Login attempts per 15 minutes |

Generate a strong JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

> In development all origins are allowed; in production `CORS_ORIGIN` is
> mandatory and the server refuses to start without it.

---

## Project structure

What each part does, and why it exists.

```
.
├── config/          how the process is configured and connected
│   └── storage/     the four providers + the shared schema and SQL engine
├── controllers/     HTTP in, HTTP out
├── middleware/      cross-cutting request concerns
├── routes/          URL → guard → controller wiring
├── services/        the business rules
├── models/          the bulwark: provider-agnostic data access
│   ├── mongo/       MongoDB strategy
│   └── document/    document strategy (json + sqlite + mysql)
├── utils/           small fire-and-forget helpers
├── scripts/         operational one-shots
├── tests/           the test matrix
├── docs/            the long-form guides
├── server.js        composition root
└── package.json
```

### `config/` — configuration and connection

| Path | What it does | Why it exists |
| --- | --- | --- |
| `app.js` | Reads and validates **every** environment variable, once, into a typed `config` object. Exposes `collectProblems()` (side-effect free) and `assertValid()`. | One place to look when asking "what can I configure?", and one place to change when a variable is added. Because modules import a resolved object instead of reading `process.env` themselves, a module's behaviour is a function of an injectable value — which is what lets both storage providers be exercised inside one test process. **Rule: no other module may read `process.env`.** |
| `env.js` | Thin wrapper that turns a configuration problem into a readable startup failure. | Kept as a stable require path for `server.js` and scripts, and so validation still reports *every* missing variable at once rather than one per restart. |
| `concurrency.js` | FIFO queues for imports and exports with concurrency limits, job timeouts, queue-depth stats and an optional periodic log. | A single slow import must not starve the API, and a burst of exports must not exhaust memory. The queues return `503` when full rather than queueing without bound. Stats are surfaced on `/health` so back-pressure is observable. |
| `storage/index.js` | The provider registry. Knows that four strategies exist and exposes provider-neutral verbs: `init()`, `getStore()`, `ping()`, `close()`, `status()`. | This is the only module that knows more than one provider exists. Callers ask for a store, never for "the Mongo client". Providers load **lazily**, so running on SQLite never loads the `mongodb` driver, and running on Mongo never loads `mysql2`. |
| `storage/schema.js` | The logical schema — collections, **column types** and indexes — declared once. | One declaration feeds every provider: Mongo turns each entry into a real `createIndex()`; the SQL providers turn `columns` into `CREATE TABLE` and `indexes` into `CREATE INDEX`; the JSON provider enforces the `unique: true` entries in code. This is what stops the providers drifting on what the data should look like. |
| `storage/mongo.js` | The MongoDB strategy: connect, ping, apply indexes, close. | Keeps driver specifics (connection strings, `ServerApiVersion`, DNS overrides) out of everything else. |
| `storage/sqlite.js` | The SQLite strategy: ensure the directory, open the file in WAL mode, apply the schema, close. | Lets the app run with no database server, no credentials and no `npm install` — Node ships SQLite. |
| `storage/mysql.js` | The MySQL strategy: create the database if missing, open a pool, apply the schema, close. | Loads `mysql2` lazily, so the driver is never required unless this provider is selected. Creates the database on boot because you cannot connect to a database that does not exist yet. |
| `storage/json.js` | The JSON strategy: creates the data directory, opens the collections, reports the directory in its status. | A zero-dependency option for demos and tiny datasets. Honest about its lack of indexes rather than pretending to be a database. |
| `storage/jsonStore.js` | A small document store implementing the subset of the MongoDB collection API the models use (`find`, `insertMany`, `updateOne`, `$inc`, dotted paths, unique constraints…), with atomic write-to-temp-and-rename durability. | Because it understands real Mongo query documents, the model implementations need no per-store branching. |
| `storage/sql/` | The SQL engine shared by SQLite and MySQL: `store.js` (the Mongo-shaped collection API), `translate.js` (filter/update/value translation), `dialect.js` (the SQLite-vs-MySQL differences), `ensureSchema.js`, plus the two drivers. | One implementation, two dialects, **zero** model code. This is why adding a SQL database later is a dialect file and a driver, not a fourth model strategy. |

### `routes/`, `controllers/`, `middleware/` — the HTTP edge

| Path | What it does | Why it exists |
| --- | --- | --- |
| `routes/*.js` | Maps a URL and method to a guard and a handler. Applies role gates and per-route rate limits. | Keeps the security surface readable in one place per resource. `users` and `audit` are admin-only at the router, so no individual handler can forget the check. |
| `controllers/*.js` | Parse `req`, call exactly one service, shape the response. | HTTP translation only. A controller that grew a business rule would make that rule untestable without a request object, and would risk being reimplemented inconsistently in a second entry point. |
| `middleware/auth.js` | Verifies the JWT, loads the user, and compares `tokenVersion`. | Central place where a token stops being valid: logout, password reset and deactivation all work by bumping one number rather than tracking sessions. |
| `middleware/errorHandler.js` | `404` for unknown routes; turns `err.status` into the HTTP status. | Domain errors carry their own status (`DuplicateKeyError` → 409, `ValidationError` → 400), so a model can decide "this is the client's fault" without knowing anything about HTTP. |
| `server.js` | Composition root: middleware, routes, boot sequence, graceful shutdown. | The only file that knows the whole application exists. Everything else is a module that can be required and reasoned about on its own. |

### `services/` — the business rules

| Path | What it does | Why it exists |
| --- | --- | --- |
| `authService.js` | Bootstrap, login, logout, token issuance. | Owns the `admin_bootstrap` system lock, so only one admin can ever be created even under concurrent requests. |
| `userService.js` | User CRUD, activation, password reset. | Refuses to delete a user who still has datasets assigned — a business rule that has no natural home in a model. |
| `datasetService.js` | Import orchestration, assignment, duplication, cascading delete. | Cascades are multi-step by nature (dataset → comments → versions) and deliberately live here, not in a model, so a partial failure is visible in one place. |
| `commentService.js` | Annotation, bulk operations, version history, restore, export. | Version numbers and status transitions are derived from current state, so they need both a read and a write to stay consistent. |
| `importService.js` | CSV/XLSX parsing, dedupe, chunked inserts, progress reporting. | The only long-running, failure-prone workflow; isolated so the queue can run it and report its phases. |
| `taxonomyService.js` | Label-set CRUD, slug generation, sentinel values, per-dataset binding. | Owns the invariant that `unannotated`/`unclassified` sentinels always exist, which status computation depends on. |
| `analyticsService.js` | Dashboards, class balance, histograms, duplicate detection, ML export. | Read-only composition; the only layer allowed to ask for a dataset-wide aggregate. |
| `auditService.js` | Audit listing and filters. | Kept separate from `utils/audit.js`, which *writes* fire-and-forget entries and never throws into the request. |

### `models/` — the bulwark

The only layer that touches storage, and the only place that knows more than
one provider exists. Full detail in [`docs/models.md`](docs/models.md) and
[`docs/storage.md`](docs/storage.md).

| Path | What it does | Why it exists |
| --- | --- | --- |
| `index.js` | Dispatches to a strategy by `DATA_PROVIDER`, exposes the models as lazy getters, and verifies the loaded strategy against the contract. | Callers write `require("../models")` and get a stable API. Because the strategy is resolved lazily and checked at load, an incomplete provider fails at boot with a list of gaps rather than as a `TypeError` in production. |
| `contract.js` | The machine-checkable list of methods every model must provide, plus `findGaps()` / `verifyContract()`. | A contract nobody checks is a comment. This is what catches "added the method to Mongo, forgot the document store" the moment the app starts. |
| `errors.js` | `DuplicateKeyError`, `NotFoundError`, `ValidationError`, `ConflictError`, each carrying an HTTP status. | Services catch these by name and never see a driver error code. A unique-index violation becomes a correct 409 instead of a 500 — including on SQL, where the driver reports `ER_DUP_ENTRY` or SQLite's constraint text. |
| `shared/dto.js` | Document → DTO mappers. Also attach the `_id` alias the client reads. | Ids become strings, references are normalised, optional fields get stable defaults, and no entity can ship without `_id` because it is added in one place rather than per service. |
| `shared/filters.js` | Domain filter → query, and patch sanitising, parameterised by an id adapter. | Services describe *what* they want in plain objects; this is the single translation point. Keeping it shared is why the providers cannot disagree about what a filter means — including the deliberate quirks. |
| `shared/aggregate.js` | Grouping, bucketing and date-key primitives. | The document store computes `$group`/`$bucket`/`$dateToString` equivalents in JavaScript; sharing the primitives keeps the output shape identical. |
| `shared/ids.js` | Id string rules, regex escaping, and the string-id adapter. | The half of the id contract that is not provider-specific. |
| `mongo/*.js` | The MongoDB strategy: `ObjectId`, real indexes, aggregation pipelines. | The production path, and the one every other strategy is measured against. |
| `mongo/oid.js` | The `ObjectId` id adapter. | The single place in the model layer that imports the driver, so "no ObjectId above this line" is structurally enforced rather than a convention. |
| `document/*.js` | The document strategy: string ids, in-process joins and aggregations. | Selected by **three** providers — `json`, `sqlite` and `mysql` — because all three are reached through the same store interface. Method-for-method parallel to `mongo/`, so the two can be read side by side. |

### `utils/`, `scripts/`, `tests/`, `docs/`

| Path | What it does | Why it exists |
| --- | --- | --- |
| `utils/audit.js` | Fire-and-forget audit writer. | An audit entry must never fail the request that triggered it, and must never become a bottleneck. Errors are logged, not thrown. |
| `scripts/init-indexes.js` | Applies the active provider's schema — Mongo indexes, SQL tables and indexes, or a JSON no-op. | Idempotent, so it is safe on every boot and in CI. Making it provider-aware is what lets the same command serve every store. |
| `scripts/clean-test-artifacts.js` | Drops throwaway **MongoDB and MySQL** databases and temp directories. | A test run killed mid-flight leaves state behind. It matches only a known test-prefix allow-list, so it can never touch the application database. |
| `tests/run-all.js` | Runs the whole matrix across every provider and prints a summary. | One command that proves the provider switch works, so "just set `DATA_PROVIDER`" is a tested claim rather than an aspiration. |
| `tests/helpers/harness.js` | Test runner, per-provider sandboxes, server lifecycle. | Each end-to-end run needs a private port and a private store; centralising that is what makes it safe to run tests while developing. |
| `tests/unit/*.test.js` | Store semantics, SQL translation, configuration, and the contract. | Fast, dependency-free checks for the parts that parity cannot easily reach. |
| `tests/storage-parity.js` | One scenario run on every available provider, diffed field by field. | The direct answer to "will switching providers change behaviour?" |
| `tests/api-test.js` | The 55-check HTTP suite. | Proves the whole stack, not just the model layer. |
| `docs/*.md` | Long-form guides per layer. | Keeps this README scannable while the detail stays available one click away. |

---

## Architecture

Four layers, each with one job. The rule is enforced by review rather than
tooling, so please keep it intact:

| Layer | Folder | May do | May **not** do |
| --- | --- | --- | --- |
| Controllers | `controllers/` | read `req`, call one service, set HTTP status/headers, `next(err)` | touch storage, build filters, hold business rules |
| Services | `services/` | validate input, authorise, orchestrate models, write audit entries, run queued jobs, format exports | touch `req`/`res`, use `ObjectId`/`$operators`/`storage.getStore()` |
| Models | `models/` | talk to the storage provider, map documents ↔ DTOs, translate driver errors | know about HTTP or business flows |
| Storage | `config/storage/` | connect, ping, apply schema, close | know about models or HTTP |

Why it is split this way: each boundary exists to make a specific class of
change cheap. A new endpoint touches routes and controllers only. A new business
rule touches one service. A new storage provider touches `config/storage/` and
one line of `models/index.js` — and a *SQL* provider needs no model code at all.
A new configuration variable touches `config/app.js` only.

Request flow:

```
route (rate limit, verifyToken/verifyAdmin, multer)
  → controller        controllers/*.js     — HTTP in/out only
    → service         services/*.js        — rules, authz, audit, queues
      → model         models/              — storage access, DTO mapping
        → strategy     models/mongo | models/document
          → provider  config/storage/      — connect, schema, health
            → MongoDB | SQLite | MySQL | JSON files
```

Cross-cutting pieces:

- `middleware/auth.js` → `req.user = { userId, role, email, name }`
- `middleware/errorHandler.js` → turns `err.status` into the HTTP response
- `utils/audit.js` → append-only audit entries, never throws into the caller
- `config/concurrency.js` → import/export queues with timeouts and stats
- `config/app.js` → the only module that reads `process.env`
- `config/storage/index.js` → provider registry; `getStore()` returns `null` until ready

---

## Documentation

| Document | Covers |
| --- | --- |
| [`docs/controllers.md`](docs/controllers.md) | Every handler, its route, guard, service call and response |
| [`docs/services.md`](docs/services.md) | Business rules, validation, audit actions, queues, export/import algorithms |
| [`docs/models.md`](docs/models.md) | Each adapter's methods, DTOs, filters, error translation, indexes, caveats |
| [`docs/storage.md`](docs/storage.md) | Provider strategy, the model bulwark, switching between MongoDB / SQLite / MySQL / JSON, verification |
| [`docs/api.md`](docs/api.md) | Endpoint reference (method, path, role, body, response) |
| [`docs/database.md`](docs/database.md) | Collections, document shapes, indexes, cascade rules, query recipes |

All files carry the AI-generated disclaimer at the top. Known gaps
(200-row page cap, global analytics distributions, taxonomy `kind` filter, the
un-audited single-comment mutations) are listed in `docs/models.md` §7 and
`docs/services.md` §5.

---

## API overview

All endpoints live under `/api` except `GET /` and `GET /health`. **46 API
endpoints** in total (48 routes including the two non-API ones):

| Group | Endpoints | Notes |
| --- | --- | --- |
| Auth | 5 | `bootstrap-status`, `bootstrap`, `login`, `logout`, `me` |
| Users | 7 | admin only (router-level guard) |
| Datasets | 9 | import, preview, stats, list, get, assign, duplicate, rename, delete |
| Comments | 11 | CRUD, bulk annotate/assign, export, annotation, versions, restore, delete |
| Taxonomies | 9 | CRUD, defaults, per-dataset resolution, assign/unassign |
| Audit | 2 | list + distinct actions (admin only) |
| Analytics | 3 | dataset, global (admin), ML export |

Full details: [`docs/api.md`](docs/api.md).

---

## First-time setup flow

1. Start the backend with a valid `.env`. Boot does three things before serving:
   `storage.init()` (connect + apply the provider's schema) →
   `Dataset.cleanupStaleImports(cutoff)` (marks `pending`/`processing` datasets
   older than 30 minutes as `failed` with
   `importError: "Server restarted during import"`) → `listen()`.
2. Open the frontend — it calls `GET /api/auth/bootstrap-status`, sees
   `adminCount === 0`, and routes you to the bootstrap page.
3. Create the initial admin with `POST /api/auth/bootstrap` (guarded by the
   `admin_bootstrap` system lock, so only one request can win).
4. Log in and start working:
   - create a taxonomy at `/taxonomies` (optional — defaults work out of the box);
   - import a dataset at `/datasets` (`POST /preview` first, then
     `POST /import`; poll `GET /datasets/:id` for `progress`);
   - assign an annotator to the dataset;
   - annotate single rows or use bulk actions (200 rows per bulk call);
   - review per-dataset or global analytics;
   - export for ML as JSONL/CSV/XLSX with a train/val/test split.

---

## Health, queues & rate limits

### `GET /health`

Returns `200` when the active storage provider answers a ping, otherwise `503`:

```json
{
  "success": true,
  "message": "Server is healthy",
  "db": "ok",
  "storage": {
    "provider": "sqlite",
    "ready": true,
    "detail": { "file": "/srv/annotator/storage/annotator.sqlite" }
  },
  "uptime": 123.45,
  "timestamp": "2026-09-24T06:36:58.823Z",
  "queues": {
    "imports": {
      "name": "imports", "concurrency": 2, "running": 0, "pending": 0,
      "maxQueueSize": 100, "jobTimeoutMs": 600000, "oldestWaitMs": 0,
      "stats": { "started": 4, "completed": 4, "failed": 0, "rejected": 0, "timedOut": 0 }
    },
    "exports": { "...": "same shape, concurrency 4 / timeout 60000" }
  }
}
```

The `storage` block is the quickest way to confirm which provider actually
booted after changing `DATA_PROVIDER` — it reports the provider name, whether
it is ready, and provider-specific detail: the database name for MongoDB, the
file path for SQLite, host/port/database for MySQL, or the data directory and
its collections for JSON. Credentials are never echoed back.

The endpoint is also what the frontend uses: on boot it reads
`storage.provider` from here and shows a dismissible warning banner when the
backend is on the JSON store, so nobody has to wonder why list and export
screens feel slow.

Wire this into your uptime monitor or load balancer. `pending` (plus
`oldestWaitMs`) is the signal that imports are backing up; `stats.rejected`
counts requests that received a `503` because the queue was full.

### Rate limits

| Scope | Window | Production | Development |
| --- | --- | --- | --- |
| `/api/**` (global) | 1 min | 300 / IP | 10 000 / IP |
| `POST /api/auth/login` | 15 min | 5 / IP | 1 000 / IP |
| `POST /api/auth/bootstrap`, `GET /api/auth/bootstrap-status` | 1 hour | 10 / IP | 1 000 / IP |

The development limits are intentionally loose so local test suites are not
blocked; they derive from `NODE_ENV` via `config/app.js` and can be overridden
with `RATE_LIMIT_GLOBAL` / `RATE_LIMIT_AUTH`. Behind a proxy, `trust proxy` is
enabled automatically in production (needed for real client IPs).

---

## Testing

The backend has a test matrix that runs **the same behaviour against every
storage provider**. The point is not coverage for its own sake: it is proof
that `DATA_PROVIDER` is a real switch and that the model layer keeps the
providers honest.

```bash
npm test              # everything: unit + parity + end-to-end on all four providers
```

```
────────────────────────────────────────────────────────────────────────
Test matrix
────────────────────────────────────────────────────────────────────────
Suite                     Kind          Passed   Failed
········································································
json-store                unit              42        0
sql-store                 unit              51        0
config                    unit              24        0
contract                  unit              31        0
storage-parity            parity           292        0
api:json                  end-to-end        55        0
api:sqlite                end-to-end        55        0
api:mongo                 end-to-end        55        0
api:mysql                 end-to-end        55        0
········································································
Totals: 605 passed, 0 failed, 605 checks
✅ All suites passed.
```

A provider that is not available in the current environment (no `MONGO_URI`, no
MySQL server on `:3306`) is reported as **skipped** rather than failed, so the
suite is still meaningful on a bare machine. `json` and `sqlite` always run and
need nothing.

### Commands

| Command | Does | Needs |
| --- | --- | --- |
| `npm test` | The full matrix below | nothing (providers that are up) |
| `npm run test:unit` | Unit suites only — no server, no database, no network | nothing |
| `npm run test:json` | End-to-end on the JSON provider only | nothing |
| `npm run test:sqlite` | End-to-end on SQLite only | nothing |
| `npm run test:mongo` | End-to-end on MongoDB only | `MONGO_URI` |
| `npm run test:mysql` | End-to-end on MySQL only | a MySQL server on `:3306` |
| `npm run test:parity` | Model-level parity across every available provider | nothing |
| `npm run test:api` | HTTP suite against a server **you** are already running | a running server |
| `npm run clean:test` | Remove test databases and temp directories left by a crashed run | `MONGO_URI` for the DB part |

### What each suite covers

| Suite | Kind | Covers |
| --- | --- | --- |
| `tests/unit/json-store.test.js` | unit | The JSON document store: query semantics (`$in`, `$ne`, `$regex`, dotted paths, null-matches-missing), update operators (`$set`/`$inc`/`$unset`), unique-constraint enforcement, `ordered: false` partial inserts, Date round-tripping, sorting, durability across a restart, concurrent writes |
| `tests/unit/sql-store.test.js` | unit | The SQL engine: every filter operator translated to bound parameters, LIKE wildcard escaping, Date/boolean/JSON encoding round-trips, document↔row conversion, `modifiedCount` no-op detection, dialect DDL, and real execution against a SQLite file (unique → `11000`, projection, distinct, NULL matching, persistence across reopen) |
| `tests/unit/config.test.js` | unit | Configuration and the switch itself: MongoDB is the default, each provider selects correctly, `MONGO_URI` is required *only* for MongoDB, invalid values warn and fall back, `JWT_SECRET` rules, all four providers stay configurable side by side, and loading SQLite pulls in neither `mysql2` nor `mongodb` |
| `tests/unit/contract.test.js` | unit | The bulwark: both strategies satisfy `models/contract.js`, expose identical method names, and a provider that drifts is reported by name. Plus the shared layer — one filter/DTO/aggregation implementation proven to be provider-independent |
| `tests/storage-parity.js` | parity | One ~90-step scenario run against **every** provider and diffed field by field: user lifecycle, taxonomies, datasets, comment CRUD, bulk writes, partial inserts, filters, search, pagination, every aggregation, version history, audit log, locks, cascades, stale-import cleanup |
| `tests/api-test.js` | end-to-end | The 55-check HTTP suite, run once per provider: import, annotate, bulk operations, version restore, taxonomy binding, CSV/XLSX export, analytics, ML export, audit, role scoping |

**Where a mismatch is a real difference, not a test artifact.** The parity
suite compares result *sets* rather than sequences for `$group` output and for
`$in` matches, because MongoDB specifies no order for either and no SQL engine
promises the same. Asserting an order there would be asserting an accident of
each engine's query planner.

### Isolation

Each end-to-end run gets a private port, a private store, and — for MongoDB and
MySQL — a throwaway database that is dropped afterwards. **Your configured
database, your local `data/` directory, and any server you already have running
are never touched.** That is what lets you run `npm test` while `npm run dev` is
up.

`npm test` writes a machine-readable report to `tests/results/`.

If a run is killed mid-flight it can leave a throwaway database behind;
`npm run clean:test` removes those (MongoDB *and* MySQL) and any leftover temp
directories. It refuses to touch anything outside a known test-prefix
allow-list.

### Legacy PowerShell script

`tests/api-test.ps1` predates the matrix and hits a **live** database, so it
needs a throwaway one:

```powershell
# server already running on :5000
.\tests\api-test.ps1

# let the script start and stop the server itself
.\tests\api-test.ps1 -StartServer
```

Prefer `npm test`, which is isolated and runs every available provider.

### Adding a model method

The suites will tell you if you forget half the job:

1. Add the method to `models/mongo/<Model>.js` **and**
   `models/document/<Model>.js`. The document strategy covers `json`, `sqlite`
   and `mysql` together, so there is nothing else to edit.
2. Add it to `CONTRACT` in `models/contract.js`.
3. Add a scenario step to `tests/storage-parity.js` so every provider is
   compared on it.
4. If it filters on a field the SQL providers must be able to query, declare
   that field in `config/storage/schema.js`. The SQL layer refuses to filter on
   an undeclared field rather than quietly returning the wrong rows.

Skip step 2 and `contract` fails on the next boot. Skip step 3 and the method
is untested — parity passes but nothing proves the providers agree.

### Adding a new storage provider

The provider surface is small enough that a fifth database is a short change:

1. Write `config/storage/<name>.js` exposing `name`, `connect`, `getStore`,
   `ping`, `ensureSchema`, `close`, `describe` and `requires`.
2. Its store must present the Mongo-shaped collection API the models use
   (`findOne`, `find`, `countDocuments`, `distinct`, `insertOne`, `insertMany`,
   `updateOne`, `updateMany`, `bulkWrite`, `deleteOne`, `deleteMany`) and
   return Mongo-shaped results — `insertedId`, `matchedCount`, `modifiedCount`,
   `deletedCount`, and `code: 11000` for a unique violation.
3. Register it in `PROVIDERS` (`config/storage/index.js`) and in
   `STORAGE_PROVIDERS` (`config/app.js`).
4. Add it to `ALL_PROVIDERS` in `tests/run-all.js` and to `createSandbox` in the
   test harness.

No model code and no service code changes. A SQL database in particular is a
dialect entry plus a driver — see `config/storage/sql/dialect.js` for how much
genuinely differs between engines.

---

## Deployment notes

### Production checklist

- [ ] `NODE_ENV=production`
- [ ] `CORS_ORIGIN` set to your frontend origin(s) — mandatory in production
- [ ] Strong `JWT_SECRET` (32+ chars minimum, 64+ recommended)
- [ ] `DATA_PROVIDER` chosen deliberately, and confirmed via the `storage`
      block on `/health` after boot
- [ ] Backups enabled for the chosen provider — Atlas or a replica set for
      MongoDB, `mysqldump` for MySQL, a copy of the `.sqlite` file (plus its
      `-wal` sidecar, or use `.backup`) for SQLite, or a plan for
      `JSON_DATA_DIR` on the JSON store
- [ ] Run behind a reverse proxy with TLS (nginx, Caddy, Traefik)
- [ ] `PORT` matches what the proxy expects (default `5000`)
- [ ] Tune `MAX_CONCURRENT_IMPORTS` / `MAX_CONCURRENT_EXPORTS` / `MAX_QUEUE_SIZE`
      for your DB size and replica count
- [ ] On `mysql`, `MYSQL_POOL_SIZE` stays below the server's `max_connections`
- [ ] Point your monitor at `/health` (it returns `503` when storage is down
      **or** when the process has lost its store handle)
- [ ] Delete stale `system_locks` rows if a bootstrap crashed mid-flight
      (`admin_bootstrap` is the only lock in use today)

### Choosing a provider

| | `mongo` (default) | `sqlite` | `mysql` | `json` |
| --- | --- | --- | --- | --- |
| Setup | Needs a server or Atlas cluster | One file, no setup | Needs a server + credentials | A directory on disk |
| Dependency | `mongodb` | none (built-in) | `mysql2` | none |
| Multi-process | Supported | Works read-only; concurrent writers serialise on the file | Supported | **Not supported** — one process per directory |
| Large `comments` collection | Indexed | Indexed | Indexed | Linear scans; aggregations run in memory |
| Concurrency safety | Database transactions available (unused today) | One writer at a time; WAL readers are fine | InnoDB row locking + transactions | Serialised in-process write queue |
| Best for | Production | Dev, CI, single-instance deploys | Production, existing SQL infrastructure | Demos, evaluation, tiny data |

MongoDB remains the default because it is the most battle-tested choice for the
multi-writer production case. **SQLite is the best default for development**:
it needs no server, no credentials and no `npm install`, and it is a real query
planner, so it will not hide performance problems the way the JSON store does.

The JSON store is kept because it is honest about its limits rather than
pretending to be a database. It is not a production choice.

### Scaling caveat

Import/export queues live **inside the Node process**. Two replicas behind the
same load balancer allow `2 × MAX_CONCURRENT_IMPORTS` imports and do not share
queue depth. For a bigger deployment, move the queue to a real worker system
(Redis/BullMQ, SQS) instead of scaling the API horizontally.

### Graceful shutdown

`SIGINT`/`SIGTERM` close the HTTP listener, let in-flight requests finish, and
then close the storage provider — which flushes the JSON store to disk, closes
the MySQL pool, and releases the SQLite file handle. A 10-second timer forces
`exit(1)` if connections do not drain. Queued jobs that have not started are
lost; their datasets stay `pending` and the next boot marks them `failed` via
`cleanupStaleImports`.

---

## License

Private / internal. Not for redistribution.
