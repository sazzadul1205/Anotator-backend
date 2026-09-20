# Annotator Backend

A text-annotation API for building sentiment + language-labelled training data.
Handles file imports, per-dataset taxonomy assignment, versioned annotations,
audit trails, analytics, and ML-ready exports.

---

## Table of Contents

- [Features](#features)
- [Requirements](#requirements)
- [Setup](#setup)
- [Environment Variables](#environment-variables)
- [Scripts](#scripts)
- [Project Structure](#project-structure)
- [API Documentation](#api-documentation)
- [Database Documentation](#database-documentation)
- [First-Time Setup Flow](#first-time-setup-flow)
- [Deployment Notes](#deployment-notes)
- [License](#license)

---

## Features

- **Authentication & roles** — JWT-based auth with `admin` and `annotator` roles. Token revocation via per-user `tokenVersion`.
- **Bootstrap** — one-time admin creation guarded by an atomic system lock.
- **Dataset imports** — CSV + XLSX upload (up to 20 MB) with live progress phases (`parsing → inserting → versions → finalizing`). Duplicate handling with `skip` or `rename` strategies.
- **Dynamic taxonomies** — define custom sentiment and language/type label sets in the UI, and assign them per-dataset. Datasets without a taxonomy fall back to sensible defaults.
- **Annotation workflow** — per-row and bulk annotation with automatic status flips (`annotated` only when both sentiment and type are set).
- **Full version history** — every mutation writes an immutable snapshot. Restores append a new version; nothing is ever lost.
- **Audit log** — fire-and-forget action log covering auth, users, datasets, comments, and taxonomies. Filterable by actor, action, target, and date range.
- **Analytics** — per-dataset and workspace-wide dashboards with class balance metrics (Shannon entropy, Gini impurity), length histograms, activity timelines, and an ML "readiness" verdict.
- **ML-ready export** — download annotated comments as JSONL, CSV, or XLSX with a deterministic train/val/test split baked in.

---

## Requirements

- Node.js 18+
- MongoDB Atlas account (or local MongoDB 6+)

---

## Setup

1. **Clone and install dependencies:**

   ```bash
   git clone <repo-url>
   cd annotator-backend
   npm install
   ```

2. **Configure environment:**

   ```bash
   cp .env.example .env
   ```

   Fill in the values described in [Environment Variables](#environment-variables).

3. **Create MongoDB indexes** (once per database):

   ```bash
   npm run init-indexes
   ```

4. **Start the server:**

   ```bash
   npm run dev    # development, auto-reload
   npm start      # production
   ```

5. **Create the first admin** — either via the frontend bootstrap page, or directly:

   ```
   POST /api/auth/bootstrap
   { "name": "...", "email": "...", "password": "...", "confirmPassword": "..." }
   ```

   This endpoint can only be called **once**. Subsequent attempts are rejected.

---

## Environment Variables

| Variable      | Required  | Purpose                                 | Example                   |
| ------------- | --------- | --------------------------------------- | ------------------------- |
| `PORT`        | ❌        | HTTP port (default `5000`)              | `5000`                    |
| `NODE_ENV`    | ❌        | `development` or `production`           | `development`             |
| `MONGO_URI`   | ✅        | MongoDB connection string               | `mongodb+srv://...`       |
| `DB_NAME`     | ✅        | Database name                           | `annotator_db`            |
| `JWT_SECRET`  | ✅        | Signing key for JWTs. **Min 32 chars.** | 64+ random hex chars      |
| `CORS_ORIGIN` | ✅ (prod) | Comma-separated list of allowed origins | `https://app.example.com` |

> **Note:** `CORS_ORIGIN` is only required when `NODE_ENV=production`. In development, all origins are allowed.

Generate a strong JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

---

## Scripts

| Command                | Does                                          |
| ---------------------- | --------------------------------------------- |
| `npm start`            | Run the production server                     |
| `npm run dev`          | Run the dev server with nodemon (auto-reload) |
| `npm run init-indexes` | Create all MongoDB indexes (safe to re-run)   |

---

## Project Structure

```
.
├── config/
│   ├── db.js              # MongoDB client + synchronous getDB()
│   ├── env.js             # Startup env validation
│   └── indexes.js         # ensureIndexes() + cleanupStaleImports()
├── middleware/
│   └── auth.js            # verifyToken, verifyAdmin
├── routes/
│   ├── authRoute.js       # Bootstrap, login, logout, me
│   ├── userRoute.js       # User CRUD (admin)
│   ├── datasetRoute.js    # Import, preview, list, assign, duplicate, delete
│   ├── commentRoute.js    # Comment CRUD, annotation, versioning, export
│   ├── taxonomyRoute.js   # Taxonomy CRUD + assign to dataset
│   ├── auditRoute.js      # Audit log listing + distinct actions
│   └── analyticsRoute.js  # Dataset + global analytics, ML export
├── utils/
│   └── audit.js           # Fire-and-forget audit logger
├── docs/
│   ├── api.md             # Full API reference (45 endpoints)
│   └── database.md        # Collections, indexes, cascades, recipes
├── scripts/
│   └── init-indexes.js    # One-shot index creator
├── server.js              # App entrypoint: middleware, routes, graceful shutdown
└── package.json
```

---

## API Documentation

Full endpoint reference: **[`docs/api.md`](docs/api.md)**

Covers all **45 endpoints** across ten groups:

| Group             | Count |
| ----------------- | ----- |
| Bootstrap         | 2     |
| Authentication    | 3     |
| User Management   | 7     |
| Datasets & Import | 9     |
| Comments CRUD     | 5     |
| Annotation        | 3     |
| Data Versioning   | 2     |
| Taxonomies        | 9     |
| Audit Log         | 2     |
| Analytics         | 3     |

Each entry documents the method, path, required role, request body/params, and response shape.

---

## Database Documentation

Full schema reference: **[`docs/database.md`](docs/database.md)**

Covers every collection — `users`, `datasets`, `comments`, `comment_versions`,
`taxonomies`, `audit_log`, `system_locks` — with:

- Document shape (with inline comments)
- Index definitions and why they exist
- Cascade rules for deletes
- A relation map
- Storage estimates
- Quick MongoDB recipes for common queries

---

## First-Time Setup Flow

1. Start the backend with a valid `.env`.
2. On first boot, `ensureIndexes()` runs and `cleanupStaleImports()` marks any
   leftover `pending`/`processing` datasets older than 30 minutes as `failed`.
3. Open the frontend — it will detect `adminCount === 0` and route you to the
   bootstrap page.
4. Create the initial admin via `POST /api/auth/bootstrap`.
5. Log in and begin:
   - **Create a taxonomy** at `/taxonomies` (optional — defaults work out of the box).
   - **Import a dataset** at `/datasets`. You'll see a preview before committing.
   - **Assign an annotator** to the dataset.
   - **Annotate** from the dataset detail page, or bulk-apply labels.
   - **View analytics** per-dataset or globally.
   - **Export for ML** as JSONL/CSV/XLSX with a train/val/test split.

---

## Deployment Notes

### Production checklist

- [ ] Set `NODE_ENV=production`
- [ ] Set `CORS_ORIGIN` to your frontend's origin(s)
- [ ] Set a strong `JWT_SECRET` (32+ chars, ideally 64+)
- [ ] Enable MongoDB Atlas backups
- [ ] Run behind a reverse proxy (nginx, Caddy, Traefik) with TLS
- [ ] Set `PORT` to match your proxy's expectation
- [ ] Consider raising the global rate limit in `server.js` if you have many
      concurrent users (default is 300 req/min in production)

### Graceful shutdown

The server listens for `SIGINT`/`SIGTERM`, closes the HTTP listener, and forces
exit after 10 seconds if connections don't drain. Suitable for Docker/K8s.

### Health endpoint

`GET /health` — returns `{ success, message, db, uptime, timestamp }`.
Returns 503 if the database is unreachable. Wire this up to your load balancer
or uptime monitor.

### Rate limits

| Scope                  | Window | Max        |
| ---------------------- | ------ | ---------- |
| Global `/api`          | 1 min  | 300 (prod) |
| `POST /auth/login`     | 15 min | 5 / IP     |
| `POST /auth/bootstrap` | 1 hr   | 10 / IP    |

---

## License

Private / internal. Not for redistribution.
