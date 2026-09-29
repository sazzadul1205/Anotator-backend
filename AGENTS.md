# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository.

This file is about **how to work here**. For *what the system does*, read
[`README.md`](README.md) and [`docs/`](docs/).

---

## 1. Read this before you change anything

The codebase is layered, and the layers are load-bearing. Most mistakes an agent
makes here come from putting logic in the wrong layer, or from adding a method
to one provider and forgetting the others.

```
route  →  controller  →  service  →  model  →  strategy  →  provider  →  database
```

| Layer | Folder | May do | May **not** do |
| --- | --- | --- | --- |
| Routes | `routes/` | map URL+method to a guard and a handler | contain logic |
| Controllers | `controllers/` | read `req`, call **one** service, shape the response | touch storage, build filters, hold business rules |
| Services | `services/` | validate, authorise, orchestrate models, write audit entries, run queued jobs | touch `req`/`res`, use `ObjectId` / `$operators` / `storage.getStore()` |
| Models | `models/` | talk to the provider, map documents ↔ DTOs, translate driver errors | know about HTTP or business flows |
| Storage | `config/storage/` | connect, ping, apply schema, close | know about models or HTTP |
| Media store | `config/media.js` | resolve/validate paths, read/write/stream blobs | know about models, datasets or HTTP |

**The rule that matters most:** a new feature should touch the *fewest possible
layers*. Adding an endpoint touches `routes/` and `controllers/`. A business
rule touches one file in `services/`. If you find yourself editing three or more
layers for one feature, you are probably leaking a concern upward.

**Where each rule lives:** `process.env` is read **only** in `config/app.js`.
The `mongodb` driver is imported **only** in `models/mongo/oid.js`. These are
conventions, not lint rules — preserve them.

---

## 2. Non-negotiable invariants

Breaking any of these breaks production, not just tests.

1. **`config/app.js` is the only module that reads `process.env`.** Everything
   else imports the resolved `config` object. This is what makes every provider
   testable inside one process.
2. **Ids are strings above `models/`.** No `ObjectId` ever escapes the model
   layer. `idStr()` in `models/shared/ids.js` is the normaliser.
3. **Every DTO carries `_id`.** The client reads `_id` everywhere. It is attached
   centrally by `withIdAlias()` in `models/shared/dto.js` — never add it ad hoc
   in a service, and never remove it.
4. **`models/contract.js` is enforced.** `models/index.js` calls
   `verifyContract()` on load, so an incomplete provider fails at boot with a
   list of gaps.
5. **Driver errors never leak.** Services catch `DuplicateKeyError`,
   `NotFoundError`, `ValidationError` by name — never a driver code. A unique
   violation must surface as `err.code === 11000` on **every** provider,
   including MySQL (`ER_DUP_ENTRY`) and SQLite (constraint text).
6. **Every mutation is versioned.** Creating, importing, updating, annotating and
   restoring a comment each append an immutable snapshot. **Restoring appends a
   new version; it never rewrites history.** Media annotations follow the same
   rule, and their version `revision` numbers must stay strictly increasing —
   reusing one leaves two rows at the same revision and "the latest change"
   stops being well defined.
7. **Status is derived, not user-set.** A comment is `annotated` only when both
   a sentiment and a type exist. Do not let a caller set `status` directly. A
   media asset is `annotated` once it has at least one annotation.
8. **Cascades are multi-step and non-transactional** (dataset → comments →
   versions). There are no transactions on any provider. A partial failure must
   be visible in `services/datasetService.js`, not swallowed.
9. **Media bytes never go in a record database.** Files live under `MEDIA_ROOT`
   via `config/media.js`; records hold only metadata and annotation geometry.
   Media is served only through the authenticated route — never `express.static`.
   `storagePath` must never appear in a DTO.

---

## 3. The four providers, and what they mean for you

`DATA_PROVIDER` selects one of `mongo`, `sqlite`, `mysql`, `json`.

**There are only two model strategies, not four:**

| Provider | Strategy | Why |
| --- | --- | --- |
| `mongo` | `models/mongo/` | the one driver with a different id type (`ObjectId`) |
| `json`, `sqlite`, `mysql` | `models/document/` | all three speak the same document API over string ids |

The difference between json/sqlite/mysql lives **entirely** in
`config/storage/`. This is why adding a SQL database required **zero** model
code.

### Semantics you must preserve

The SQL layer deliberately imitates Mongo, because the models depend on it:

- `{ field: null }` matches null **or absent**.
- `$in: []` matches **nothing** (filters rely on this to degrade safely when
  every id in a list was malformed).
- `$ne` / `$nin` also match absent fields.
- `modifiedCount` counts rows that **actually changed** — a no-op update is `0`.
  Services branch on this number, so do not "simplify" it.
- Filters support `=`, `null`, `$in`, `$nin`, `$ne`, `$lt`/`$lte`/`$gt`/`$gte`,
  `$exists`, case-insensitive `$regex`, `$and`, `$or`. **Anything else throws.**

### The one place it is stricter than Mongo

On SQLite and MySQL, a field **not declared** in `config/storage/schema.js` can
be stored (it lands in a per-row `extra` JSON column) but **not filtered on** —
the layer throws rather than scanning a blob and returning rows that do not
match the caller's intent.

**If you add a filterable field, declare it in `config/storage/schema.js` in the
same change.** This is the most common way to break the SQL providers.

---

## 4. Change recipes

These are the four edits you are most likely to make, with the full checklist.

### Adding a model method

1. Add it to `models/mongo/<Model>.js` **and** `models/document/<Model>.js`.
   The document strategy covers three providers — there is nothing else to edit.
2. Add the name to `CONTRACT` in `models/contract.js`.
   *Skip this and the `contract` suite fails on the next boot.*
3. Add a scenario step to `tests/storage-parity.js` so all providers are
   compared on it. *Skip this and nothing proves the providers agree.*
4. If it filters on a field, declare that field in `config/storage/schema.js`.

### Adding an endpoint

1. Handler in `controllers/<name>Controller.js` — HTTP in/out only, `try/catch`
   with `next(err)`.
2. The rule in `services/<name>Service.js`.
3. URL + guard in `routes/<name>Route.js`. If admin-only, mount the guard at the
   router so no handler can forget it.
4. Document it in `docs/api.md`.

If the endpoint takes a file, remember that a multer `fileFilter` has the
signature `(req, file, done)`, **not** Express's `(req, res, next)`. Passing it
as separate middleware gives it the response object as `file`, so the
extension always reads as empty.

### Adding a config variable

1. Add the parser call in `config/app.js` (`str` / `int` / `bool` / `list` /
   `oneOf` — all validate ranges and warn on bad values).
2. Add it to `.env.example` with a comment.
3. Document it in README §4.1.
4. Nothing else. If you edited a second file, you did it wrong.

### Adding a storage provider

1. `config/storage/<name>.js` exposing `name`, `connect`, `getStore`, `ping`,
   `ensureSchema`, `close`, `describe`, `requires`.
2. A store presenting the Mongo collection API (`findOne`, `find`,
   `countDocuments`, `distinct`, `insertOne`, `insertMany`, `updateOne`,
   `updateMany`, `bulkWrite`, `deleteOne`, `deleteMany`) and returning
   Mongo-shaped results.
3. Register in `PROVIDERS` (`config/storage/index.js`) **and** `STORAGE_PROVIDERS`
   (`config/app.js`).
4. Add to `ALL_PROVIDERS` in `tests/run-all.js` and `createSandbox` in
   `tests/helpers/harness.js`.

No model code. No service code.

---

## 5. Code conventions

Match the surrounding file. The house style is:

```js
// path/to/file.js
// One or two lines on what this file is for and why it exists.

const { something } = require("./wherever");

/**
 * JSDoc when the *why* is not obvious from the signature.
 * Explain reasoning and gotchas, not the obvious.
 */
async function doThing(input) {
  if (!input) return null;
  return result;
}

module.exports = { doThing };
```

- **CommonJS** (`require` / `module.exports`). `"type": "commonjs"`.
- **2-space indent**, double quotes, semicolons, trailing commas in multiline
  literals.
- **`const`** by default; `let` only when genuinely reassigned; never `var`.
- **Named exports at the bottom** via one `module.exports = { ... }`.
- **Models are classes of `static` methods**, and they are deliberately
  method-for-method parallel between `mongo/` and `document/`. Read the other
  folder before writing.
- **Section dividers** in longer files: `// --- Reads ---------` /
  `// --- Writes --------`.
- **Comments are expected and welcome here**, especially the *why*. This codebase
  is heavily commented by convention — a comment explaining a non-obvious
  decision is idiomatic, not noise. Match the density of the file you are in.
  Do not, however, narrate what the code plainly does.
- **Early returns** over nesting: `if (!x) return null;` then the happy path.

### Response and error shape

Uniform across the API — do not invent new shapes:

```js
res.status(400).json({ success: false, error: "No file uploaded" });
res.json({ success: true, data: { ... } });
```

Domain errors carry an HTTP status so `middleware/errorHandler.js` can map
them without knowing what they mean:

```js
const err = new ValidationError("Sentiment is not in this dataset's taxonomy");
err.status = 400;   // ValidationError
                     // 404 NotFoundError
                     // 409 DuplicateKeyError / ConflictError
```

Model write methods return **small summaries**, never raw documents:
`{ id }`, `{ matchedCount, modifiedCount }`, `{ deletedCount }`,
`{ entries, total }`.

---

## 6. Testing

```bash
npm test              # full matrix: unit + parity + end-to-end, all providers
npm run test:unit     # no server, no database, no network — fastest signal
npm run lint
```

Current state: **1090+ checks passing** across four providers.

| Command | Needs |
| --- | --- |
| `npm run test:unit` | nothing |
| `npm run test:json` / `test:sqlite` | nothing |
| `npm run test:mongo` | `MONGO_URI` |
| `npm run test:mysql` | MySQL on `:3306` |
| `npm run test:api` | a server **you** started |

**Rules for agents:**

- **Run `npm run lint && npm test` before you claim a change works.** Do not
  report success from having only run a subset unless you say so explicitly.
- A provider that is unreachable is reported **skipped**, not failed. If you
  see fewer suites than expected, check for skips before assuming you broke
  something.
- Tests are **isolated**: private port, private store, throwaway database. Your
  configured database and any running server are never touched — so it is safe
  to run `npm test` while `npm run dev` is up.
- `npm run clean:test` removes leftover test databases and temp dirs. It only
  touches names on a test-prefix allow-list.
- Machine-readable reports land in `tests/results/`.

### Writing a test

`tests/storage-parity.js` runs one scenario against every provider and diffs the
transcripts field by field. When you add a step:

- Ids and timestamps are normalised to placeholders. Reuse the existing helpers
  rather than inventing your own.
- If the result has **no specified order** (`$group` output, `$in` matches), it
  must be listed in `UNORDERED_RESULTS` and compared with `assertSameSet()`.
  Do not add an order-sensitive assertion there — you would be asserting an
  accident of each engine's query planner.
- If your step diverges across providers, **that is a real finding.** Fix the
  code; do not relax the assertion to make it green.

---

## 7. Things that will bite you

- **`storage.getStore()` returns `null` until the provider has connected.** Any
  model method called before boot completes will throw a confusing `null`
  dereference. This is only an issue in scripts and tests, not in the HTTP
  path, which never serves before `storage.init()` resolves.
- **A stale process serving old code is a recurring local problem.** If
  `/health` shows the wrong provider, or your change appears to have no effect,
  restart the server before debugging anything else.
- **Changing `.env` does not reliably trigger a nodemon restart.** Restart
  explicitly after changing `DATA_PROVIDER`.
- **DTOs are whitelists** (`models/shared/dto.js`). Adding a field to a stored
  document without adding it to the DTO makes it invisible to every service.
- **The `users` and `audit` routers are admin-only at the router level.** Do not
  also re-check the role in each handler; that is already handled, and a
  second check is drift waiting to happen.
- **No transactions exist on any provider.** Any new multi-document write is a
  cascade, and it can fail partway. Handle that explicitly in the service.

---

## 8. Known issues

Do not treat these as your regressions, and do not silently "fix" them as part
of an unrelated change.

- **`mongodb` is an undeclared dependency.** `models/mongo/oid.js` does
  `require("mongodb")`, but it is absent from `dependencies` and resolves only
  because npm hoists it out of `mongoose` — which is itself declared and
  **never imported anywhere in the source**. This works today but is fragile.
  The correct fix is to declare `mongodb` and drop `mongoose`.
- **No schema migrations.** `ensureSchema` creates missing tables and indexes;
  it does not alter existing ones. Schema changes are additive-only.
- **The 200-row page cap.** `findMany` hard-caps at 200 unless
  `options.internal === true`.
- **Some single-comment mutations are not audited** (see `docs/models.md` §7).
- **Sort order is only as stable as the sort key.** No provider guarantees an
  order for ties. If order matters, add a unique tiebreaker to the sort.
- **`stringIds.coerce` and `objectIds.coerce` must agree** on what counts as a
  usable id. When they disagreed, a malformed id matched nothing on json /
  sqlite / mysql and *everything* on mongo. `tests/unit/media.test.js` pins this.
- **A DTO's JSON key order is part of the response contract**, even though
  `deepStrictEqual` ignores it. BSON hands projected fields back in its own
  order, so an aggregate that is returned directly can serialise differently
  per provider. Map aggregate output into an explicit shape.

---

## 9. Before you say you are done

- [ ] `npm run lint` — clean
- [ ] `npm test` — all suites, no new failures
- [ ] Did I put the logic in the right layer?
- [ ] If I added a model method: **both** strategies **and** `CONTRACT`
- [ ] If I added a filterable field: declared in `config/storage/schema.js`
- [ ] If I added a config variable: `config/app.js` + `.env.example` + README
- [ ] If I changed a DTO: `_id` still present
- [ ] New endpoint documented in `docs/api.md`
- [ ] Did I read `README.md` / `docs/` before inventing an approach?

Report what you actually ran. If a suite was skipped or you could not run
something, say so rather than implying full verification.
