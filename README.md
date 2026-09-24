# Annotator Backend

A text-annotation API for building sentiment + language-labelled training data.
Handles file imports, per-dataset taxonomy assignment, versioned annotations,
audit trails, analytics and ML-ready exports.

> ⚠️ **AI-GENERATED DOCUMENTATION — READ WITH CARE**
>
> This README and the files under [`docs/`](docs/) were written/refreshed by an
> AI coding assistant (Cline) from a static reading of the source code, last
> reviewed at commit `742c536` (2026-09-24). They are best-effort explanations,
> **not** authoritative specifications: they can drift out of date and may
> contain mistakes.
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
- [Scripts](#scripts)
- [Project structure](#project-structure)
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
- **Layered codebase** — controllers (HTTP) → services (rules) → models
  (MongoDB). Each layer is documented separately in
  [`docs/controllers.md`](docs/controllers.md),
  [`docs/services.md`](docs/services.md) and [`docs/models.md`](docs/models.md).

---

## Requirements

- **Node.js 18+** (the code uses Express 5 and the official `mongodb` driver)
- **MongoDB 6+** locally, or a MongoDB Atlas cluster
- PowerShell 5.1+ only if you want to run the API test suite
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
   `server.js` validates them on boot and exits with a clear message when
   `MONGO_URI`, `DB_NAME` or a 32+ character `JWT_SECRET` is missing.

3. **Create the MongoDB indexes** (once per database — safe to re-run):

   ```bash
   npm run init-indexes
   ```

4. **Start the server:**

   ```bash
   npm run dev    # development, nodemon auto-reload
   npm start      # production
   ```

   On boot the server connects to MongoDB, ensures indexes, marks stale imports
   as failed (`Dataset.cleanupStaleImports`, imports stuck for > 30 minutes) and
   then listens on `PORT` (default `5000`).

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
| `MONGO_URI` | ✅ | MongoDB connection string | `mongodb+srv://...` |
| `DB_NAME` | ✅ | Database name | `annotator_db` |
| `JWT_SECRET` | ✅ | JWT signing key, **min 32 chars** | 64+ random hex chars |
| `CORS_ORIGIN` | ✅ in production | Comma-separated allowed origins | `https://app.example.com` |

Concurrency / queue tuning (all optional, read by `config/concurrency.js`):

| Variable | Default | Meaning |
| --- | --- | --- |
| `MAX_CONCURRENT_IMPORTS` | `2` | Imports running at the same time |
| `MAX_CONCURRENT_EXPORTS` | `4` | Exports running at the same time |
| `MAX_QUEUE_SIZE` | `100` | Pending jobs per queue before new work is rejected with 503 |
| `JOB_TIMEOUT_MS` | `600000` | Import job timeout (10 min) |
| `EXPORT_TIMEOUT_MS` | `60000` | Export job timeout (1 min) |
| `QUEUE_LOG_INTERVAL_MS` | `60000` | Queue-depth log interval (`0` disables it) |

Generate a strong JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

> In development all origins are allowed; in production `CORS_ORIGIN` is
> mandatory and the server refuses to start without it.

---

## Scripts

| Command | Does |
| --- | --- |
| `npm start` | Run the server (`node server.js`) |
| `npm run dev` | Run with nodemon (auto-reload) |
| `npm run init-indexes` | Create all MongoDB indexes (idempotent) |
| `npm run lint` | ESLint over the project |
| `npm test` | Not implemented yet — prints an error and exits 1 |
| `./tests/api-test.ps1 -StartServer` | End-to-end API suite (PowerShell), writes reports to `tests/results/` |

---

## Project structure

```
.
├── config/
│   ├── concurrency.js     # Env-driven FIFO queues for imports/exports
│   ├── db.js              # MongoClient + getDB() (null until connected)
│   ├── env.js             # Startup env validation (exits on failure)
│   └── indexes.js         # ensureIndexes() only
├── controllers/           # HTTP layer — thin wrappers over services
│   ├── analyticsController.js
│   ├── auditController.js
│   ├── authController.js
│   ├── commentController.js
│   ├── datasetController.js
│   ├── taxonomyController.js
│   └── userController.js
├── middleware/
│   ├── auth.js            # verifyToken (JWT + tokenVersion), verifyAdmin
│   └── errorHandler.js    # notFound + errorHandler (uses err.status)
├── models/                # ONLY layer that touches MongoDB
│   ├── index.js           # barrel: require("../models")
│   ├── errors.js          # DuplicateKeyError, NotFoundError, ValidationError, ConflictError
│   ├── AuditLog.js        ├── Comment.js       ├── CommentVersion.js
│   ├── Dataset.js         ├── SystemLock.js    ├── Taxonomy.js
│   └── User.js
├── routes/                # Express routers + role guards
│   ├── analyticsRoute.js  ├── auditRoute.js    ├── authRoute.js
│   ├── commentRoute.js    ├── datasetRoute.js  ├── taxonomyRoute.js
│   └── userRoute.js
├── services/              # Business logic — validation, authz, audit, jobs
│   ├── analyticsService.js  ├── auditService.js     ├── authService.js
│   ├── commentService.js    ├── datasetService.js   ├── importService.js
│   ├── taxonomyService.js   └── userService.js
├── scripts/
│   └── init-indexes.js    # One-shot index creator
├── tests/
│   ├── api-test.ps1       # End-to-end API suite
│   └── results/           # Generated reports (git-ignored)
├── utils/
│   └── audit.js           # Fire-and-forget audit logger (never throws)
├── docs/
│   ├── api.md             # Endpoint reference
│   ├── controllers.md     # HTTP layer guide
│   ├── services.md        # Business logic guide
│   ├── models.md          # Data access guide
│   └── database.md        # Collections, indexes, cascades, recipes
├── server.js              # App entrypoint: middleware, routes, shutdown
└── package.json
```

---

## Architecture

Three layers, each with one job. The rule is enforced by review, not tooling, so
please keep it intact:

| Layer | Folder | May do | May **not** do |
| --- | --- | --- | --- |
| Controllers | `controllers/` | read `req`, call one service, set HTTP status/headers, `next(err)` | touch MongoDB, build filters, hold business rules |
| Services | `services/` | validate input, authorise, orchestrate models, write audit entries, run queued jobs, format exports | touch `req`/`res`, use `ObjectId`/`$operators`/`getDB()` |
| Models | `models/` | talk to MongoDB, map documents ↔ DTOs, translate driver errors | know about HTTP or business flows |

Request flow:

```
route (rate limit, verifyToken/verifyAdmin, multer)
  → controller        controllers/*.js     — HTTP in/out only
    → service         services/*.js        — rules, authz, audit, queues
      → model         models/*.js          — Mongo access, DTO mapping
        → MongoDB
```

Cross-cutting pieces:

- `middleware/auth.js` → `req.user = { userId, role, email, name }`
- `middleware/errorHandler.js` → turns `err.status` into the HTTP response
- `utils/audit.js` → append-only audit entries, never throws into the caller
- `config/concurrency.js` → import/export queues with timeouts and stats
- `config/db.js` → single `MongoClient`, `getDB()` returns `null` until ready

---

## Documentation

| Document | Covers |
| --- | --- |
| [`docs/controllers.md`](docs/controllers.md) | Every handler, its route, guard, service call and response |
| [`docs/services.md`](docs/services.md) | Business rules, validation, audit actions, queues, export/import algorithms |
| [`docs/models.md`](docs/models.md) | Each adapter's methods, DTOs, filters, error translation, indexes, caveats |
| [`docs/api.md`](docs/api.md) | Endpoint reference (method, path, role, body, response) |
| [`docs/database.md`](docs/database.md) | Collections, document shapes, indexes, cascade rules, query recipes |

All five files carry the AI-generated disclaimer at the top. Known gaps
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
   `connectDB()` → `ensureIndexes()` → `Dataset.cleanupStaleImports(cutoff)`
   (marks `pending`/`processing` datasets older than 30 minutes as `failed` with
   `importError: "Server restarted during import"`).
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

Returns `200` when MongoDB answers `ping`, otherwise `503`:

```json
{
  "success": true,
  "message": "Server is healthy",
  "db": "ok",
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
blocked; they come from `NODE_ENV` checks in `server.js` and
`routes/authRoute.js`. Behind a proxy, `trust proxy` is enabled automatically in
production (needed for real client IPs).

---

## Testing

There is no unit-test framework wired up yet (`npm test` exits 1 on purpose).
The practical test suite is a PowerShell script that exercises the real HTTP API:

```powershell
# server already running on :5000
.\tests\api-test.ps1

# let the script start and stop the server itself
.\tests\api-test.ps1 -StartServer

# custom target / credentials, quieter output
.\tests\api-test.ps1 -BaseUrl http://localhost:5000 -AdminEmail admin@test.local -AdminPassword password1234
```

It bootstraps an admin, walks the endpoints and writes both a text and a JSON
report into `tests/results/` (git-ignored). Note that it hits the **live**
database configured in `.env` — use a throwaway database.

---

## Deployment notes

### Production checklist

- [ ] `NODE_ENV=production`
- [ ] `CORS_ORIGIN` set to your frontend origin(s) — mandatory in production
- [ ] Strong `JWT_SECRET` (32+ chars minimum, 64+ recommended)
- [ ] MongoDB backups enabled (Atlas) or a replica set you can restore
- [ ] Run behind a reverse proxy with TLS (nginx, Caddy, Traefik)
- [ ] `PORT` matches what the proxy expects (default `5000`)
- [ ] Tune `MAX_CONCURRENT_IMPORTS` / `MAX_CONCURRENT_EXPORTS` / `MAX_QUEUE_SIZE`
      for your DB size and replica count
- [ ] Point your monitor at `/health` (it returns `503` when the DB is down
      **or** when the process has lost the Mongo handle)
- [ ] Delete stale `system_locks` rows if a bootstrap crashed mid-flight
      (`admin_bootstrap` is the only lock in use today)

### Scaling caveat

Import/export queues live **inside the Node process**. Two replicas behind the
same load balancer allow `2 × MAX_CONCURRENT_IMPORTS` imports and do not share
queue depth. For a bigger deployment, move the queue to a real worker system
(Redis/BullMQ, SQS) instead of scaling the API horizontally.

### Graceful shutdown

`SIGINT`/`SIGTERM` close the HTTP listener and let in-flight requests finish;
a 10-second timer forces `exit(1)` if connections do not drain. Queued jobs that
have not started are lost — their datasets stay `pending` and the next boot
marks them `failed` via `cleanupStaleImports`.

---

## License

Private / internal. Not for redistribution.



