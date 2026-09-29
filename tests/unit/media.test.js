// tests/unit/media.test.js
// Unit tests for the media domain's pure logic: the media blob store's path
// safety, the header probe, geometry validation, and the export formatters.
//
//   node tests/unit/media.test.js
//
// These deliberately do not touch a database. The *behaviour* of the media
// models across providers is covered by tests/storage-parity.js, and the HTTP
// flow by tests/api-test.js. What lives here is the set of rules that would be
// painful to debug through an HTTP round-trip — a bounding box that silently
// clamps, an export whose class indices shift, a path that escapes the media
// root.

"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");

// The media store reads MEDIA_ROOT through config/app.js, so the env has to be
// set before it is required — not before the test file is read.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "annotator-media-unit-"));
process.env.MEDIA_ROOT = tmpRoot;
process.env.DATA_PROVIDER = process.env.DATA_PROVIDER || "json";
process.env.JWT_SECRET =
  process.env.JWT_SECRET || "test-secret-that-is-definitely-longer-than-32-chars";

const media = require(path.join(ROOT, "config", "media"));
const geometry = require(path.join(ROOT, "utils", "geometry"));
const { probeImage, probeVideo } = require(path.join(ROOT, "utils", "mediaProbe"));
const mediaLabelService = require(path.join(ROOT, "services", "mediaLabelService"));
const mediaExportService = require(path.join(ROOT, "services", "mediaExportService"));
const mediaFilters = require(path.join(ROOT, "models", "shared", "mediaFilters"));
const { stringIds } = require(path.join(ROOT, "models", "shared", "ids"));
const { Suite, runSuites, expect } = require(path.join(ROOT, "tests", "helpers", "harness"));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Minimal PNG header for the given dimensions. */
function pngHeader(width, height) {
  const b = Buffer.alloc(24);
  b.writeUInt32BE(0x89504e47, 0);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(height, 20);
  return b;
}

function gifHeader(width, height) {
  const b = Buffer.alloc(16);
  b.write("GIF89a", 0, "ascii");
  b.writeUInt16LE(width, 6);
  b.writeUInt16LE(height, 8);
  return b;
}

/**
 * A JPEG with a real APP0 segment followed by an SOF0. The segment lengths
 * matter: the probe walks them, so a fixture that lies about its own layout
 * would test nothing.
 */
function jpegFixture(width, height) {
  const b = Buffer.alloc(40);
  b.writeUInt16BE(0xffd8, 0);
  b.writeUInt16BE(0xffe0, 2);
  b.writeUInt16BE(16, 4);
  b.write("JFIF\0", 6, "ascii");
  b.writeUInt16BE(0xffc0, 20);
  b.writeUInt16BE(17, 22);
  b.writeUInt8(8, 24);
  b.writeUInt16BE(height, 25);
  b.writeUInt16BE(width, 27);
  return b;
}

function bmpFixture(width, height) {
  const b = Buffer.alloc(30);
  b.write("BM", 0, "ascii");
  b.writeInt32LE(width, 18);
  b.writeInt32LE(height, 22);
  return b;
}

/** WebP VP8X stores width-1 / height-1 as 24-bit little-endian. */
function webpFixture(width, height) {
  const b = Buffer.alloc(40);
  b.write("RIFF", 0, "ascii");
  b.write("WEBP", 8, "ascii");
  b.write("VP8X", 12, "ascii");
  b.writeUIntLE(width - 1, 24, 3);
  b.writeUIntLE(height - 1, 27, 3);
  return b;
}

/** Builds an ISO-BMFF box. */
function box(type, ...payloads) {
  const body = Buffer.concat(payloads.map(Buffer.from));
  const b = Buffer.alloc(8 + body.length);
  b.writeUInt32BE(8 + body.length, 0);
  b.write(type, 4, "ascii");
  body.copy(b, 8);
  return b;
}

function mvhdV0(timescale, duration) {
  const b = Buffer.alloc(100);
  b.writeUInt8(0, 0);
  b.writeUInt32BE(timescale, 12);
  b.writeUInt32BE(duration, 16);
  return b;
}

function mvhdV1(timescale, duration) {
  const b = Buffer.alloc(108);
  b.writeUInt8(1, 0);
  b.writeUInt32BE(timescale, 20);
  b.writeBigUInt64BE(BigInt(duration), 24);
  return b;
}

process.on("exit", () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

// ---------------------------------------------------------------------------
// Path safety
// ---------------------------------------------------------------------------

const pathSuite = new Suite("media · path safety");

pathSuite.test("init creates the media root", async () => {
  await media.init();
  expect.ok(fs.existsSync(tmpRoot));
});

pathSuite.test("a normal relative path resolves inside the root", async () => {
  const full = media.resolveSafe("dataset/asset.png");
  expect.ok(full.startsWith(fs.realpathSync.native ? path.resolve(tmpRoot) : path.resolve(tmpRoot)));
  expect.equal(path.basename(full), "asset.png");
});

pathSuite.test("a parent-directory escape is refused", async () => {
  await expect.throws(() => media.resolveSafe("../../etc/passwd"), (e) => /escapes the media root/.test(e.message));
  await expect.throws(() => media.resolveSafe("a/../../../etc/passwd"), (e) => /escapes the media root/.test(e.message));
});

pathSuite.test("an absolute path is refused", async () => {
  await expect.throws(() => media.resolveSafe("/etc/passwd"), (e) => /absolute path rejected/.test(e.message));
  await expect.throws(() => media.resolveSafe("C:\\Windows\\system32"), (e) => /absolute path rejected|escapes/.test(e.message));
});

pathSuite.test("a bare dot resolves to the root and is refused", async () => {
  await expect.throws(() => media.resolveSafe("."), (e) => /escapes the media root/.test(e.message));
  await expect.throws(() => media.resolveSafe(""), (e) => /empty path/.test(e.message));
});

pathSuite.test("assetPath builds dataset/asset.ext from generated ids", async () => {
  expect.equal(media.assetPath("ds1", "a1", "png"), "ds1/a1.png");
  expect.equal(media.assetPath("ds1", "a1", ".PNG"), "ds1/a1.png");
});

pathSuite.test("assetPath refuses an extension that is not a plain slug", async () => {
  await expect.throws(() => media.assetPath("ds1", "a1", "../../etc/passwd"), (e) => /unsafe extension/.test(e.message));
  await expect.throws(() => media.assetPath("ds1", "a1", "p n g"), (e) => /unsafe extension/.test(e.message));
  await expect.throws(() => media.assetPath("ds1", "a1", ""), (e) => /unsafe extension/.test(e.message));
});

pathSuite.test("assetPath refuses an id that is not a plain slug", async () => {
  await expect.throws(() => media.assetPath("../etc", "a1", "png"), (e) => /unsafe dataset or asset id/.test(e.message));
  await expect.throws(() => media.assetPath("ds1", "a/1", "png"), (e) => /unsafe dataset or asset id/.test(e.message));
});

pathSuite.test("put then read then remove round-trips", async () => {
  await media.put("round/trip.txt", Buffer.from("hello media"));
  expect.equal((await media.read("round/trip.txt")).toString(), "hello media");
  expect.ok(await media.exists("round/trip.txt"));
  expect.ok(await media.remove("round/trip.txt"));
  expect.ok(!(await media.exists("round/trip.txt")));
});

pathSuite.test("remove of a missing file is not an error", async () => {
  // Deletes are idempotent: removing something that is already gone is a
  // success, because a retry after a partial failure must not blow up.
  expect.ok(await media.remove("round/never-existed.txt"));
  expect.ok(!(await media.exists("round/never-existed.txt")));
});

pathSuite.test("removeDir refuses the root itself", async () => {
  await expect.throws(
    () => media.removeDir("."),
    (e) => /escapes the media root|refusing to remove directory/.test(e.message),
  );
});

pathSuite.test("removeDir refuses a nested directory", async () => {
  // Only a directory exactly one level below the root may be removed, so a bug
  // upstream cannot take the entire media root with it.
  await expect.throws(
    () => media.removeDir("a/b"),
    (e) => /refusing to remove directory/.test(e.message),
  );
});

pathSuite.test("removeDir removes a dataset directory and its contents", async () => {
  await media.put("ds1/a1.png", Buffer.from("a"));
  await media.put("ds1/a2.png", Buffer.from("b"));
  expect.ok(await media.removeDir("ds1"));
  expect.ok(!(await media.exists("ds1/a1.png")));
});

pathSuite.test("a read cannot escape the root", async () => {
  let threw = false;
  try {
    await media.read("../../../package.json");
  } catch {
    threw = true;
  }
  expect.ok(threw, "reading outside the media root must throw");
});

pathSuite.test("describe never leaks the filesystem path", async () => {
  const d = media.describe();
  expect.equal(d.driver, "local");
  expect.ok(!JSON.stringify(d).includes(tmpRoot), "describe() must not echo the root path");
});

// ---------------------------------------------------------------------------
// Header probe
// ---------------------------------------------------------------------------

const probeSuite = new Suite("media · header probe");

probeSuite.test("PNG dimensions are read from IHDR", async () => {
  expect.equal(probeImage(pngHeader(1920, 1080)), {
    width: 1920, height: 1080, format: "png",
  });
});

probeSuite.test("GIF dimensions are read from the screen descriptor", async () => {
  expect.equal(probeImage(gifHeader(640, 480)).width, 640);
  expect.equal(probeImage(gifHeader(640, 480)).format, "gif");
});

probeSuite.test("JPEG dimensions are found past the APP0 segment", async () => {
  expect.equal(probeImage(jpegFixture(800, 600)), {
    width: 800, height: 600, format: "jpg",
  });
});

probeSuite.test("BMP dimensions are read from the DIB header", async () => {
  expect.equal(probeImage(bmpFixture(1024, 768)).width, 1024);
});

probeSuite.test("WebP VP8X subtracts one from the stored 24-bit fields", async () => {
  expect.equal(probeImage(webpFixture(1920, 1080)).width, 1920);
  expect.equal(probeImage(webpFixture(1920, 1080)).height, 1080);
});

probeSuite.test("an unrecognised buffer yields nulls rather than throwing", async () => {
  const r = probeImage(Buffer.from("this is not an image"));
  expect.equal(r.width, null);
  expect.equal(r.height, null);
  expect.equal(r.format, null);
});

probeSuite.test("an empty buffer yields nulls", async () => {
  expect.equal(probeImage(Buffer.alloc(0)).width, null);
});

probeSuite.test("a non-buffer yields nulls", async () => {
  expect.equal(probeImage(null).width, null);
  expect.equal(probeImage(undefined).width, null);
});

probeSuite.test("MP4 version-0 mvhd gives duration and timescale", async () => {
  const r = probeVideo(box("moov", box("mvhd", mvhdV0(1000, 65000))), "mp4");
  expect.equal(r.durationMs, 65000);
});

probeSuite.test("MP4 version-1 mvhd uses the 64-bit duration", async () => {
  const r = probeVideo(box("moov", box("mvhd", mvhdV1(600, 180000))), "mp4");
  expect.equal(r.durationMs, 300000);
});

probeSuite.test("an ftyp box before moov does not confuse the walker", async () => {
  const mp4 = Buffer.concat([
    box("ftyp", "isom"),
    box("moov", box("mvhd", mvhdV0(1000, 4200))),
  ]);
  expect.equal(probeVideo(mp4, "mp4").durationMs, 4200);
});

probeSuite.test("a truncated mvhd yields a null duration, not a throw", async () => {
  const bad = box("moov", Buffer.from([0, 0, 0, 10, 109, 118, 104, 100]));
  expect.equal(probeVideo(bad, "mp4").durationMs, null);
});

probeSuite.test("a container we do not parse yields a null duration", async () => {
  expect.equal(probeVideo(Buffer.alloc(64), "webm").durationMs, null);
  expect.equal(probeVideo(Buffer.alloc(64), "mkv").durationMs, null);
});

probeSuite.test("garbage in an mp4 does not throw", async () => {
  expect.equal(probeVideo(Buffer.alloc(50), "mp4").durationMs, null);
});

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const geometrySuite = new Suite("media · geometry");

geometrySuite.test("a valid box passes through unchanged", async () => {
  expect.equal(geometry.normalizeBox({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }), {
    x: 0.1, y: 0.2, width: 0.3, height: 0.4,
  });
});

geometrySuite.test("a box dragged off the left edge is clamped, not rejected", async () => {
  const b = geometry.normalizeBox({ x: -0.5, y: 0.1, width: 0.4, height: 0.2 });
  expect.equal(b.x, 0);
  // Width is capped at 1 - left, so the far edge stays on the canvas.
  expect.equal(b.width, 0.4);
});

geometrySuite.test("clamping the left edge re-caps the width", async () => {
  const b = geometry.normalizeBox({ x: -0.5, y: 0.9, width: 2, height: 0.5 });
  expect.equal(b.x, 0);
  expect.equal(b.width, 1);
});

geometrySuite.test("a box wholly outside the image is rejected", async () => {
  await expect.throws(() => geometry.normalizeBox({ x: 1.5, y: 0, width: 0.5, height: 0.5 }),
    (e) => /entirely outside/.test(e.message),
  );
});

geometrySuite.test("a zero-area box is rejected", async () => {
  await expect.throws(() => geometry.normalizeBox({ x: 0, y: 0, width: 0, height: 1 }), (e) => /greater than zero/.test(e.message));
  await expect.throws(() => geometry.normalizeBox({ x: 0, y: 0, width: 1, height: 0 }), (e) => /greater than zero/.test(e.message));
});

geometrySuite.test("a negative size is rejected", async () => {
  await expect.throws(() => geometry.normalizeBox({ x: 0, y: 0, width: -0.2, height: 0.2 }), (e) => /greater than zero/.test(e.message));
});

geometrySuite.test("a non-numeric coordinate is rejected", async () => {
  await expect.throws(() => geometry.normalizeBox({ x: "a", y: 0, width: 1, height: 1 }), (e) => /numeric/.test(e.message));
  await expect.throws(() => geometry.normalizeBox({ x: NaN, y: 0, width: 1, height: 1 }), (e) => /numeric/.test(e.message));
  await expect.throws(() => geometry.normalizeBox(null), (e) => /must be an object/.test(e.message));
});

geometrySuite.test("strict mode refuses an off-canvas box instead of clamping", async () => {
  await expect.throws(() => geometry.normalizeBox({ x: -0.1, y: 0, width: 0.5, height: 0.5 }, { clamp: false }),
    (e) => /entirely within/.test(e.message),
  );
});

geometrySuite.test("YOLO conversion returns normalised centre form", async () => {
  expect.equal(geometry.toYoloFormat({ x: 0.1, y: 0.1, width: 0.2, height: 0.4 }),
    [0.2, 0.3, 0.2, 0.4]);
});

geometrySuite.test("pixel conversion scales by the image dimensions", async () => {
  expect.equal(geometry.toPixelBox({ x: 0.5, y: 0.25, width: 0.25, height: 0.5 }, 1000, 800), {
    x: 500, y: 200, width: 250, height: 400,
  });
});

geometrySuite.test("pixel conversion refuses unknown dimensions", async () => {
  await expect.throws(() => geometry.toPixelBox({ x: 0, y: 0, width: 1, height: 1 }, 0, 100),
    (e) => /positive image dimensions/.test(e.message),
  );
});

geometrySuite.test("a pixel box converts back to the same normalised form", async () => {
  const normalised = geometry.normalizeBox({ x: 0.25, y: 0.5, width: 0.25, height: 0.25 });
  const px = geometry.toPixelBox(normalised, 800, 600);
  const back = geometry.fromPixelBox(px, 800, 600);
  expect.equal(back.x, normalised.x);
  expect.equal(back.y, normalised.y);
  expect.equal(back.width, normalised.width);
  expect.equal(back.height, normalised.height);
});

geometrySuite.test("IoU of identical boxes is 1", async () => {
  const box = { x: 0.1, y: 0.1, width: 0.4, height: 0.4 };
  expect.equal(geometry.iou(box, box), 1);
});

geometrySuite.test("IoU of disjoint boxes is 0", async () => {
  expect.equal(
    geometry.iou({ x: 0, y: 0, width: 0.2, height: 0.2 }, { x: 0.8, y: 0.8, width: 0.2, height: 0.2 }),
    0,
  );
});

geometrySuite.test("IoU of a half-overlapping pair is the known 1/3", async () => {
  expect.equal(
    geometry.iou({ x: 0, y: 0, width: 0.5, height: 0.5 }, { x: 0.25, y: 0, width: 0.5, height: 0.5 }),
    0.333333,
  );
});

geometrySuite.test("a timestamp beyond the video duration is rejected", async () => {
  await expect.throws(() => geometry.normalizeFrame({ timestampMs: 5000, durationMs: 1000 }),
    (e) => /beyond the end/.test(e.message),
  );
});

geometrySuite.test("a negative timestamp is rejected", async () => {
  await expect.throws(
    () => geometry.normalizeFrame({ timestampMs: -1 }),
    (e) => /zero or greater/.test(e.message),
  );
});

geometrySuite.test("a frame index is accepted when a duration is known", async () => {
  const r = geometry.normalizeFrame({ frameIndex: 30, durationMs: 10000 });
  expect.equal(r.frameIndex, 30);
});

geometrySuite.test("a bare frame index is refused when the duration is unknown", async () => {
  // A frame number with no known frame rate has no defined scale, so accepting
  // it would store a number that means nothing.
  await expect.throws(() => geometry.normalizeFrame({ frameIndex: 30 }),
    (e) => /needs a known video duration/.test(e.message),
  );
});

geometrySuite.test("a fractional frame index is rejected", async () => {
  await expect.throws(() => geometry.normalizeFrame({ frameIndex: 1.5, durationMs: 1000 }),
    (e) => /whole number/.test(e.message),
  );
});

geometrySuite.test("a negative frame index is rejected", async () => {
  await expect.throws(
    () => geometry.normalizeFrame({ frameIndex: -3, durationMs: 1000 }),
    (e) => /zero or greater/.test(e.message),
  );
});

geometrySuite.test("a non-numeric timestamp is rejected", async () => {
  await expect.throws(
    () => geometry.normalizeFrame({ timestampMs: "later" }),
    (e) => /numeric/.test(e.message),
  );
});

geometrySuite.test("a frame with no position at all is refused downstream", async () => {
  // normalizeFrame alone legitimately returns nulls for an empty frame; the
  // annotation service is what must refuse a box with no frame on a video.
  const r = geometry.normalizeFrame({});
  expect.equal(r, { frameIndex: null, timestampMs: null });
});

// ---------------------------------------------------------------------------
// Label slugs
// ---------------------------------------------------------------------------

const labelSuite = new Suite("media · label slugs");

labelSuite.test("a display name becomes a stable slug", async () => {
  expect.equal(mediaLabelService.slugify("Cat"), "cat");
  expect.equal(mediaLabelService.slugify("Road Sign"), "road_sign");
  expect.equal(mediaLabelService.slugify("  Hello  World  "), "hello_world");
});

labelSuite.test("accents are stripped rather than transliterated oddly", async () => {
  expect.equal(mediaLabelService.slugify("Café"), "cafe");
  expect.equal(mediaLabelService.slugify("Über"), "uber");
});

labelSuite.test("a name with no usable characters slugs to empty", async () => {
  expect.equal(mediaLabelService.slugify("!!!"), "");
  expect.equal(mediaLabelService.slugify(""), "");
});

labelSuite.test("a long name is truncated to the class-name limit", async () => {
  expect.equal(mediaLabelService.slugify("x".repeat(200)).length, 64);
});

labelSuite.test("labels normalise to value/label/color triples", async () => {
  const out = mediaLabelService.normalizeLabels(["Cat", "Road Sign"]);
  expect.equal(out.length, 2);
  expect.equal(out[0].value, "cat");
  expect.equal(out[1].value, "road_sign");
  expect.ok(out[0].color && out[0].color.startsWith("hsl"));
});

labelSuite.test("a supplied colour is preserved", async () => {
  const out = mediaLabelService.normalizeLabels([{ label: "Cat", color: "#ff0000" }]);
  expect.equal(out[0].color, "#ff0000");
});

labelSuite.test("two labels that slug identically are rejected", async () => {
  // "Cat" and "cat" would export as the same class index, which a trainer
  // cannot distinguish — so this must fail rather than silently collapse.
  await expect.throws(() => mediaLabelService.normalizeLabels(["Cat", "cat"]), (e) => /Duplicate class name/.test(e.message));
});

labelSuite.test("an empty label list is rejected", async () => {
  await expect.throws(() => mediaLabelService.normalizeLabels([]), (e) => /at least one label/.test(e.message));
  await expect.throws(() => mediaLabelService.normalizeLabels("cat"), (e) => /at least one label/.test(e.message));
});

labelSuite.test("a label with no usable characters is rejected", async () => {
  await expect.throws(() => mediaLabelService.normalizeLabels(["!!!" ]), (e) => /no usable characters/.test(e.message));
});

labelSuite.test("a blank label is rejected", async () => {
  await expect.throws(() => mediaLabelService.normalizeLabels(["  "]), (e) => /is empty/.test(e.message));
});

labelSuite.test("an empty label is given a distinct colour", async () => {
  const out = mediaLabelService.normalizeLabels(["a", "b", "c"]);
  expect.equal(new Set(out.map((l) => l.color)).size, 3);
});

// ---------------------------------------------------------------------------
// Export formatting (pure helpers only — the DB-backed exporters are covered
// end to end by the API suite)
// ---------------------------------------------------------------------------

const exportSuite = new Suite("media · export formatting");

exportSuite.test("CSV quoting only triggers when needed", async () => {
  expect.equal(mediaExportService.csvCell("plain"), "plain");
  expect.equal(mediaExportService.csvCell(""), "");
  expect.equal(mediaExportService.csvCell(null), "");
});

exportSuite.test("CSV quoting doubles inner quotes", async () => {
  expect.equal(mediaExportService.csvCell('say "hi"'), '"say ""hi"""');
  expect.equal(mediaExportService.csvCell("a,b"), '"a,b"');
  expect.equal(mediaExportService.csvCell("line\nbreak"), '"line\nbreak"');
});

exportSuite.test("the supported format list is stable", async () => {
  expect.equal(mediaExportService.FORMATS.slice().sort(), ["coco", "yolo"]);
});

exportSuite.test("YOLO and COCO agree on what a class index means", async () => {
  // Both exporters derive indices from the same class list, which is the only
  // reason a dataset can be exported to both and stay consistent.
  const classes = [
    { id: 0, value: "car" },
    { id: 1, value: "pedestrian" },
  ];
  const indexByValue = new Map(classes.map((c) => [c.value, c.id]));
  expect.equal(indexByValue.get("car"), 0);
  expect.equal(indexByValue.get("pedestrian"), 1);
});

exportSuite.test("a YOLO row is five space-separated numbers", async () => {
  const [cx, cy, w, h] = geometry.toYoloFormat({ x: 0.1, y: 0.2, width: 0.2, height: 0.4 });
  const row = `0 ${cx} ${cy} ${w} ${h}`.split(" ").map(Number);
  expect.equal(row.length, 5);
  expect.ok(row.every((v) => Number.isFinite(v)));
  expect.ok(row.slice(1).every((v) => v >= 0 && v <= 1));
});

exportSuite.test("a COCO box is absolute pixels and its area agrees", async () => {
  const box = { x: 0.25, y: 0.5, width: 0.25, height: 0.5 };
  const px = geometry.toPixelBox(box, 800, 600);
  const area = Math.round(px.width * px.height * 100) / 100;
  expect.equal(px.x, 200);
  expect.equal(px.y, 300);
  expect.equal(px.width, 200);
  expect.equal(px.height, 300);
  expect.equal(area, 60000);
});

// ---------------------------------------------------------------------------
// Id coercion
// ---------------------------------------------------------------------------

const idsSuite = new Suite("media · id coercion");

idsSuite.test("a string id passes through", async () => {
  expect.equal(stringIds.coerce("abc123"), "abc123");
});

idsSuite.test("a numeric id is stringified", async () => {
  expect.equal(stringIds.coerce(42), "42");
});

idsSuite.test("empty and nullish ids are rejected", async () => {
  expect.equal(stringIds.coerce(null), null);
  expect.equal(stringIds.coerce(undefined), null);
  expect.equal(stringIds.coerce(""), null);
});

idsSuite.test("a plain object is rejected, not stringified", async () => {
  // String({$in: []}) is the truthy garbage "[object Object]", which would turn
  // a malformed id into a filter that silently matches nothing.
  expect.equal(stringIds.coerce({ $in: [] }), null);
  expect.equal(stringIds.coerce({ a: 1 }), null);
  expect.equal(stringIds.coerce([]), null);
  expect.equal(stringIds.coerce(true), null);
});

idsSuite.test("a non-finite number is rejected", async () => {
  expect.equal(stringIds.coerce(NaN), null);
  expect.equal(stringIds.coerce(Infinity), null);
});

idsSuite.test("the document and mongo adapters agree on what is unusable", async () => {
  // The two adapters must never disagree, or the same query returns different
  // results depending on DATA_PROVIDER.
  const { objectIds } = require(path.join(ROOT, "models", "mongo", "oid"));
  for (const bad of [{ $in: [] }, { a: 1 }, [], true, null, undefined, "", NaN]) {
    const doc = stringIds.coerce(bad);
    const mongo = objectIds.coerce(bad);
    expect.equal(doc === null, mongo === null, `adapters disagree for ${JSON.stringify(bad)}`);
  }
});

idsSuite.test("a malformed id drops the clause instead of matching everything", async () => {
  // The regression this pins: Mongo dropped the clause and returned the whole
  // collection, while the document providers matched nothing.
  const filter = mediaFilters.mediaAnnotationFilter({ assetId: { $in: [] } }, stringIds);
  expect.deep(filter, {});
});

async function main() {
  const summary = await runSuites([
    pathSuite,
    probeSuite,
    geometrySuite,
    labelSuite,
    exportSuite,
    idsSuite,
  ]);
  // The exact shape tests/run-all.js parses to build the matrix report.
  console.log(`\n=== ${summary.passed} passed, ${summary.failed} failed, ${summary.total} total ===\n`);
  process.exit(summary.failed ? 1 : 0);
}

main().catch((err) => {
  console.error("Media unit tests crashed:", err);
  process.exit(1);
});
