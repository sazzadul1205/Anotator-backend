// utils/geometry.js
// Bounding-box validation and normalisation.
//
// ---------------------------------------------------------------------------
// Why normalised coordinates are the stored form
// ---------------------------------------------------------------------------
// A box is stored as fractions of the image size (0..1), never as pixels. Two
// reasons, in order of importance:
//
//   1. Annotations stay correct when the image is served at a different size.
//      A pixel box drawn against a 1920-wide thumbnail is wrong on the original,
//      and the browser is what decides which size the annotator drew on. Normal
//      coordinates are resolution-independent, so the value is true regardless
//      of how it was captured.
//   2. COCO and YOLO both want different units (COCO absolute pixels, YOLO
//      normalised centre-form), so exporting from one canonical form means one
//      conversion in one place rather than two conversions in two exporters.
//
// The one thing that cannot be normalised away is the *aspect ratio*: a box
// normalised against a wrongly-probed width is subtly wrong forever. That is why
// `services/annotationService.js` refuses to accept a box for an image whose
// dimensions could not be verified, unless the caller explicitly asserts them.

const ANNOTATION_KINDS = ["bbox", "classification"];

class GeometryError extends Error {
  constructor(message) {
    super(message);
    this.name = "GeometryError";
  }
}

function isFiniteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

/** Rounds to a fixed number of decimals, avoiding float noise in the database. */
function round(value, decimals = 6) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Validates and normalises a box given in normalised top-left form:
 * `{ x, y, width, height }` with all four in 0..1.
 *
 * `clamp` decides what happens to a box that runs off the edge. Clamping is the
 * right default for an interactive canvas, where dragging past the edge is a
 * normal gesture and the intent is unambiguous — the object is at the border.
 * Refusing would mean the user cannot select an object touching the edge, which
 * is a real and common case.
 *
 * A box of zero area is always rejected: it cannot be exported to COCO (whose
 * `area` would be 0 and which most trainers silently drop) and it is
 * meaningless as a region.
 */
function normalizeBox(input, { clamp = true } = {}) {
  if (!input || typeof input !== "object") {
    throw new GeometryError("Box must be an object");
  }
  const { x, y, width, height } = input;
  if (!isFiniteNumber(x) || !isFiniteNumber(y) ||
      !isFiniteNumber(width) || !isFiniteNumber(height)) {
    throw new GeometryError("Box requires numeric x, y, width and height");
  }
  if (width <= 0 || height <= 0) {
    throw new GeometryError("Box width and height must be greater than zero");
  }

  let left = x;
  let top = y;
  let w = width;
  let h = height;

  if (clamp) {
    left = Math.min(Math.max(left, 0), 1);
    top = Math.min(Math.max(top, 0), 1);
    // Clamp the far edge, then recompute the size: clamping the size alone
    // would let a box that starts off-canvas keep its full extent.
    w = Math.min(w, 1 - left);
    h = Math.min(h, 1 - top);
  } else if (left < 0 || top < 0 || left + w > 1 || top + h > 1) {
    throw new GeometryError("Box must lie entirely within the 0..1 range");
  }

  if (w <= 0 || h <= 0) {
    throw new GeometryError("Box lies entirely outside the image");
  }

  return {
    x: round(left),
    y: round(top),
    width: round(w),
    height: round(h),
  };
}

/**
 * Converts a box to YOLO's centre form: `[cx, cy, w, h]`, all normalised.
 * YOLO's convention differs from COCO's in both origin and anchor point, and
 * getting this wrong produces a model that trains to garbage — so it lives in
 * one tested function rather than inline in the exporter.
 */
function toYoloFormat(box) {
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return [round(cx), round(cy), round(box.width), round(box.height)];
}

/** Converts a normalised box to absolute pixels, for COCO export. */
function toPixelBox(box, width, height) {
  if (!isFiniteNumber(width) || !isFiniteNumber(height) || width <= 0 || height <= 0) {
    throw new GeometryError("Pixel conversion requires positive image dimensions");
  }
  return {
    x: round(box.x * width, 2),
    y: round(box.y * height, 2),
    width: round(box.width * width, 2),
    height: round(box.height * height, 2),
  };
}

/** Area as a fraction of the image, which is what COCO's `area` field means. */
function normalizedArea(box) {
  return round(box.width * box.height);
}

/**
 * Converts a pixel-space box (as drawn on a canvas of `imageWidth` ×
 * `imageHeight`) into the stored normalised form. This is the boundary where
 * client coordinates become trusted data, so it is the right place to reject
 * nonsense rather than letting it reach the database.
 */
function fromPixelBox(input, imageWidth, imageHeight) {
  if (!isFiniteNumber(imageWidth) || imageWidth <= 0 ||
      !isFiniteNumber(imageHeight) || imageHeight <= 0) {
    throw new GeometryError("Pixel conversion requires positive image dimensions");
  }
  return normalizeBox({
    x: input.x / imageWidth,
    y: input.y / imageHeight,
    width: input.width / imageWidth,
    height: input.height / imageHeight,
  });
}

/** Intersection-over-union of two normalised boxes, in 0..1. */
function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.width, b.x + b.width);
  const y2 = Math.min(a.y + a.height, b.y + b.height);
  if (x2 <= x1 || y2 <= y1) return 0;
  const intersection = (x2 - x1) * (y2 - y1);
  const union = normalizedArea(a) + normalizedArea(b) - intersection;
  return union > 0 ? round(intersection / union) : 0;
}

/**
 * Frame index / timestamp for a video annotation.
 *
 * The client may send either, or both. A frame index is only meaningful when a
 * frame rate is known, so when the server could not probe the duration (WebM,
 * MKV) a timestamp is the authoritative form and a frame index alone is not
 * accepted — it would be a number with no defined scale.
 */
function normalizeFrame({ frameIndex, timestampMs, durationMs }) {
  const out = { frameIndex: null, timestampMs: null };

  // A negative value is malformed input, not an absent one: silently dropping
  // it would produce a frame record with no position at all and no error.
  if (timestampMs !== undefined && timestampMs !== null) {
    if (!isFiniteNumber(timestampMs)) {
      throw new GeometryError("timestampMs must be a numeric value in milliseconds");
    }
    if (timestampMs < 0) {
      throw new GeometryError("timestampMs must be zero or greater");
    }
    if (isFiniteNumber(durationMs) && durationMs > 0 && timestampMs > durationMs) {
      throw new GeometryError("Frame timestamp is beyond the end of the video");
    }
    out.timestampMs = Math.round(timestampMs);
  }

  if (frameIndex !== undefined && frameIndex !== null) {
    if (!isFiniteNumber(frameIndex)) {
      throw new GeometryError("frameIndex must be a numeric value");
    }
    if (frameIndex < 0) {
      throw new GeometryError("frameIndex must be zero or greater");
    }
    if (!Number.isInteger(frameIndex)) {
      throw new GeometryError("frameIndex must be a whole number");
    }
    if (out.timestampMs === null && !isFiniteNumber(durationMs)) {
      throw new GeometryError(
        "frameIndex needs a known video duration; send timestampMs instead",
      );
    }
    out.frameIndex = frameIndex;
  }

  return out;
}

module.exports = {
  ANNOTATION_KINDS,
  GeometryError,
  normalizeBox,
  normalizeFrame,
  toYoloFormat,
  toPixelBox,
  fromPixelBox,
  normalizedArea,
  iou,
  round,
};
