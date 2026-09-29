// config/media.js
// The local filesystem blob store for image and video assets.
//
// ---------------------------------------------------------------------------
// Why this is a separate seam from config/storage/
// ---------------------------------------------------------------------------
// `config/storage/` holds *records* — documents in a collection. This holds
// *bytes*. They have genuinely different failure modes and lifecycles:
//
//   * a record can be small, structured and queryable; a video cannot be
//   * a record is deleted by id; a file must be unlinked from disk
//   * a record participates in the provider contract; a file does not
//
// Keeping them apart means the record side keeps its four providers and its
// parity guarantees, and swapping this file for an S3/GCS adapter later is a
// change to this one module rather than to every service.
//
// ---------------------------------------------------------------------------
// Why files are NOT served as a static directory
// ---------------------------------------------------------------------------
// `express.static(mediaRoot)` would make every uploaded file world-readable to
// anyone who can guess or learn a URL, and annotation data is rarely public.
// Instead there is exactly one read path — `GET /api/media/assets/:id/file` —
// which authenticates the caller and checks the asset exists before streaming
// a single byte. See `services/mediaService.js#readAssetStream`.
//
// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------
// The client never chooses where a file lives. It sends a filename; we derive
// `<datasetId>/<assetId>.<ext>` from ids we generated, with the extension taken
// from a configured allow-list. Client filenames are recorded as *metadata*
// only. `resolveSafe()` is a second line of defence: it refuses any path that
// escapes the media root, even if a bug upstream produced one.

const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { config } = require("./app");

let ready = false;

/**
 * Resolve a media-relative path to an absolute one, refusing anything that
 * escapes the media root.
 *
 * The check is done on the *resolved* path rather than by rejecting ".."
 * sequences, because a path can escape the root without ever containing a
 * literal ".." (absolute paths, and symlinks both defeat naive filtering).
 */
function resolveSafe(relativePath) {
  if (typeof relativePath !== "string" || relativePath.length === 0) {
    throw new Error("media: empty path");
  }
  if (path.isAbsolute(relativePath)) {
    throw new Error(`media: absolute path rejected (${relativePath})`);
  }
  const root = path.resolve(config.media.root);
  const full = path.resolve(root, relativePath);
  const rel = path.relative(root, full);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`media: path escapes the media root (${relativePath})`);
  }
  return full;
}

/** The on-disk path for an asset. Never derived from a client filename. */
function assetPath(datasetId, assetId, extension) {
  const ext = String(extension || "").replace(/^\./, "").toLowerCase();
  if (!/^[a-z0-9]+$/.test(ext)) {
    throw new Error(`media: unsafe extension (${extension})`);
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(String(datasetId)) ||
      !/^[a-zA-Z0-9_-]+$/.test(String(assetId))) {
    throw new Error("media: unsafe dataset or asset id");
  }
  return `${datasetId}/${assetId}.${ext}`;
}

/** Creates the media root. Idempotent; safe to call on every boot. */
async function init() {
  await fsp.mkdir(config.media.root, { recursive: true });
  ready = true;
  return config.media.root;
}

function assertReady() {
  if (!ready) {
    // Deliberately not a hard crash: a read that arrives before init() simply
    // reports "not ready", which is what /health expects. The server never
    // accepts traffic before init() resolves, so this only affects scripts.
    return false;
  }
  return true;
}

async function put(relativePath, buffer) {
  if (!assertReady()) await init();
  const full = resolveSafe(relativePath);
  await fsp.mkdir(path.dirname(full), { recursive: true });
  // Write to a sibling temp file and rename, so a crash mid-write cannot leave
  // a truncated image that later looks like a corrupt annotation target.
  const tmp = `${full}.${process.pid}.${Date.now()}.part`;
  try {
    await fsp.writeFile(tmp, buffer);
    await fsp.rename(tmp, full);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
  return full;
}

async function read(relativePath) {
  if (!assertReady()) await init();
  return fsp.readFile(resolveSafe(relativePath));
}

/**
 * Opens a read stream for an asset. The caller (the controller) pipes it to the
 * response and is responsible for the Range handling, because a video served
 * without range support cannot be scrubbed in the browser.
 */
function createReadStream(relativePath, options = {}) {
  return fs.createReadStream(resolveSafe(relativePath), options);
}

async function stat(relativePath) {
  try {
    return await fsp.stat(resolveSafe(relativePath));
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

async function exists(relativePath) {
  return (await stat(relativePath)) !== null;
}

/** Removes one file. Missing files are not an error — deletes are idempotent. */
async function remove(relativePath) {
  try {
    await fsp.rm(resolveSafe(relativePath), { force: true });
    return true;
  } catch (err) {
    if (err.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * Removes a dataset's whole directory. Used by the cascade delete, which must
 * also drop the files or the dataset's disk usage is leaked forever.
 */
async function removeDir(relativeDir) {
  const full = resolveSafe(relativeDir);
  // Guard: only ever remove a directory whose resolved path is exactly one
  // level below the root, so a bug upstream cannot take the whole media root
  // with it.
  const rel = path.relative(path.resolve(config.media.root), full);
  if (!rel || rel.includes(path.sep) || rel.startsWith(".")) {
    throw new Error(`media: refusing to remove directory (${relativeDir})`);
  }
  await fsp.rm(full, { recursive: true, force: true });
  return true;
}

/** Readiness probe for /health. Must never throw. */
async function ping() {
  try {
    const s = await fsp.stat(config.media.root);
    return s.isDirectory();
  } catch {
    return false;
  }
}

/** Non-throwing status for /health. Never returns a filesystem path detail. */
function describe() {
  return {
    driver: "local",
    ready,
    maxUploadMb: Math.round(config.media.maxUploadBytes / (1024 * 1024)),
    imageTypes: config.media.imageExtensions.length,
    videoTypes: config.media.videoExtensions.length,
  };
}

/** Total bytes and file count, for the admin storage panel. */
async function usage() {
  let files = 0;
  let bytes = 0;
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files += 1;
        try {
          bytes += (await fsp.stat(full)).size;
        } catch {
          /* a file removed mid-walk is not worth failing the request over */
        }
      }
    }
  };
  await walk(path.resolve(config.media.root));
  return { files, bytes };
}

module.exports = {
  init,
  ping,
  describe,
  assetPath,
  resolveSafe,
  put,
  read,
  stat,
  exists,
  remove,
  removeDir,
  createReadStream,
  usage,
};
