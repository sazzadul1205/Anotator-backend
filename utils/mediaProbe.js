// utils/mediaProbe.js
// Extract dimensions and duration from an uploaded image or video buffer.
//
// ---------------------------------------------------------------------------
// Why this is hand-rolled instead of a dependency
// ---------------------------------------------------------------------------
// The only two facts the rest of the system needs are:
//   * an image's pixel width and height, to validate and export bounding boxes
//     in real pixel coordinates (COCO requires this), and
//   * a video's duration, to validate a frame timestamp.
//
// Both are encoded in a few header bytes. Every mainstream image format is
// parsed in a handful of lines, and adding one would add a native-compiling
// dependency to a project that currently has none. For a first pass this is
// cheaper to own than to audit.
//
// If a format is not recognised, the probe returns nulls — it never throws and
// never guesses. An asset with unknown dimensions is still storable and
// annotatable; it is simply exported with the dimensions the client reports,
// and `services/annotationService.js` records that the geometry could not be
// independently verified.
//
// ---------------------------------------------------------------------------
// Video frame extraction is deliberately NOT done here
// ---------------------------------------------------------------------------
// Server-side video decoding would mean shipping ffmpeg and a frame-extraction
// pipeline. Instead a video asset carries a duration, and annotations target a
// frame index or timestamp. The *browser* decodes and scrubs, so frame accuracy
// never depends on the server being able to decode a codec. See
// docs/media.md.

const fs = require("fs");

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

/** PNG: IHDR is always the first chunk; width/height are big-endian uint32. */
function probePng(buf) {
  if (buf.length < 24) return null;
  // 8-byte signature, then the 4-byte length and 4-byte type of the first chunk.
  if (buf.readUInt32BE(0) !== 0x89504e47) return null;
  if (buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * JPEG: dimensions live in an SOFn marker inside the segment stream. The
 * marker is not at a fixed offset, so we walk the segments. SOF0-SOF15
 * excluding DHT (c4), JPG (c8) and DAC (cc) carry the frame header.
 */
function probeJpeg(buf) {
  if (buf.length < 4 || buf.readUInt16BE(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 9 < buf.length) {
    if (buf[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buf[offset + 1];
    // Standalone markers carry no length field.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) break; // EOI or start of scan
    const length = buf.readUInt16BE(offset + 2);
    const isSof =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (offset + 9 > buf.length) return null;
      return {
        height: buf.readUInt16BE(offset + 5),
        width: buf.readUInt16BE(offset + 7),
      };
    }
    offset += 2 + length;
  }
  return null;
}

/** GIF: the logical screen descriptor is a fixed 10-byte header. */
function probeGif(buf) {
  if (buf.length < 10) return null;
  const sig = buf.toString("ascii", 0, 6);
  if (sig !== "GIF87a" && sig !== "GIF89a") return null;
  return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
}

/** BMP: DIB header, 40 bytes (BITMAPINFOHEADER) at a fixed offset. */
function probeBmp(buf) {
  if (buf.length < 26) return null;
  if (buf.toString("ascii", 0, 2) !== "BM") return null;
  return { width: Math.abs(buf.readInt32LE(18)), height: Math.abs(buf.readInt32LE(22)) };
}

/**
 * WebP: a RIFF container whose payload is a VP8 / VP8L / VP8X chunk, each with
 * its own way of encoding the dimensions.
 */
function probeWebp(buf) {
  if (buf.length < 30) return null;
  if (buf.toString("ascii", 0, 4) !== "RIFF") return null;
  if (buf.toString("ascii", 8, 12) !== "WEBP") return null;
  const chunk = buf.toString("ascii", 12, 16);
  if (chunk === "VP8 ") {
    // Lossy: a 3-byte start code, then 16-bit dimensions.
    return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === "VP8L") {
    // Lossless: 14 bits each, packed after a signature byte.
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    // Extended: 24-bit little-endian width-1 and height-1.
    return {
      width: (buf.readUIntLE(24, 3) >>> 0) + 1,
      height: (buf.readUIntLE(27, 3) >>> 0) + 1,
    };
  }
  return null;
}

/**
 * TIFF: two variants, chosen by the byte order mark. Big-endian is rare but
 * must not be misread, because a misread width would corrupt every exported
 * bounding box.
 */
function probeTiff(buf) {
  if (buf.length < 8) return null;
  const bom = buf.toString("ascii", 0, 2);
  const le = bom === "II";
  const be = bom === "MM";
  if (!le && !be) return null;
  const u16 = (o) => (le ? buf.readUInt16LE(o) : buf.readUInt16BE(o));
  const u32 = (o) => (le ? buf.readUInt32LE(o) : buf.readUInt32BE(o));
  const readTag = (base) => {
    const tag = u16(base);
    const type = u16(base + 2);
    // 3 = SHORT, 4 = LONG. Anything else is not a dimension tag we understand.
    if (type !== 3 && type !== 4) return null;
    const value = type === 3 ? u16(base + 8) : u32(base + 8);
    return tag === 256 ? { width: value } : { height: value };
  };
  const ifd = u32(4);
  if (ifd + 2 > buf.length) return null;
  const count = u16(ifd);
  const out = {};
  for (let i = 0; i < count; i += 1) {
    const base = ifd + 2 + i * 12;
    if (base + 12 > buf.length) break;
    const entry = readTag(base);
    if (entry) Object.assign(out, entry);
  }
  if (!out.width || !out.height) return null;
  return out;
}

const IMAGE_PROBES = [
  ["png", probePng],
  ["jpg", probeJpeg],
  ["jpeg", probeJpeg],
  ["gif", probeGif],
  ["webp", probeWebp],
  ["bmp", probeBmp],
  ["tif", probeTiff],
  ["tiff", probeTiff],
];

/**
 * Probes an image buffer. Returns `{ width, height }`, or nulls when the format
 * is unrecognised — never throws, because an unknown image is still a valid
 * upload, it is just one whose geometry cannot be verified server-side.
 */
function probeImage(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    return { width: null, height: null, format: null };
  }
  for (const [format, probe] of IMAGE_PROBES) {
    const size = probe(buffer);
    if (size && size.width > 0 && size.height > 0) {
      return { width: size.width, height: size.height, format };
    }
  }
  return { width: null, height: null, format: null };
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

/**
 * Reads an MP4/MOV `mvhd` box for duration and timescale.
 *
 * MP4 is a box tree: a 32-bit size, a 4-byte type, then children. `moov` holds
 * `mvhd`, whose version 0 stores a 32-bit timescale and duration and whose
 * version 1 uses 64-bit fields. Both are handled because a 64-bit duration is
 * exactly what a long video produces.
 *
 * Returns null for containers that are not ISO-BMFF (WebM, Matroska), which is
 * why duration is optional everywhere downstream rather than required.
 */
function probeMp4(buf) {
  if (buf.length < 8) return null;
  if (buf.toString("ascii", 4, 8) !== "ftyp") {
    // `ftyp` is not required to be first, but in practice it is. Fall back to
    // scanning for `moov`, which is what the box walker below needs anyway.
  }

  const walk = (start, end, depth) => {
    if (depth > 6) return null;
    let offset = start;
    while (offset + 8 <= end) {
      let size = buf.readUInt32BE(offset);
      const type = buf.toString("ascii", offset + 4, offset + 8);
      let headerSize = 8;
      if (size === 1) {
        // 64-bit extended size follows the type.
        if (offset + 16 > end) return null;
        size = Number(buf.readBigUInt64BE(offset + 8));
        headerSize = 16;
      } else if (size === 0) {
        // A size of 0 means "runs to the end of the file".
        size = end - offset;
      }
      if (size < headerSize || offset + size > end) {
        // A malformed or truncated box: stop rather than looping forever.
        if (type === "moov" || type === "mvhd") return null;
        offset += 1;
        continue;
      }
      if (type === "moov" || type === "trak" || type === "mdia") {
        const found = walk(offset + headerSize, offset + size, depth + 1);
        if (found) return found;
      }
      if (type === "mvhd") {
        const body = offset + headerSize;
        if (body + 4 > end) return null;
        const version = buf[body];
        if (version === 1) {
          if (body + 28 > end) return null;
          const timescale = buf.readUInt32BE(body + 20);
          const duration = Number(buf.readBigUInt64BE(body + 24));
          if (!timescale) return null;
          return { durationMs: Math.round((duration / timescale) * 1000), container: "mp4" };
        }
        if (body + 20 > end) return null;
        const timescale = buf.readUInt32BE(body + 12);
        const duration = buf.readUInt32BE(body + 16);
        if (!timescale) return null;
        return { durationMs: Math.round((duration / timescale) * 1000), container: "mp4" };
      }
      offset += size;
    }
    return null;
  };

  return walk(0, buf.length, 0);
}

/** Probes a video buffer. Duration is null for formats we do not parse. */
function probeVideo(buffer, extension) {
  const empty = { durationMs: null, container: null };
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) return empty;
  const ext = String(extension || "").toLowerCase();
  if (["mp4", "m4v", "mov"].includes(ext)) {
    return probeMp4(buffer) || empty;
  }
  return empty;
}

// ---------------------------------------------------------------------------
// Files on disk
// ---------------------------------------------------------------------------

/**
 * Probes a file by reading only its first bytes. Video duration needs the
 * `moov` atom, which can sit at the end of a file (common for web-optimised
 * MP4s), so videos fall back to reading a larger prefix.
 */
function probeFile(filePath, extension) {
  const isVideo = ["mp4", "m4v", "mov", "webm", "mkv", "avi"].includes(
    String(extension || "").toLowerCase(),
  );
  const bytes = isVideo ? 1024 * 1024 : 64 * 1024;
  let fd;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(bytes);
    const read = fs.readSync(fd, buf, 0, bytes, 0);
    const slice = buf.subarray(0, read);
    return isVideo ? probeVideo(slice, extension) : probeImage(slice);
  } catch {
    return isVideo ? { durationMs: null, container: null } : { width: null, height: null, format: null };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
    }
  }
}

module.exports = { probeImage, probeVideo, probeFile, probeMp4 };
