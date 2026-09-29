// models/shared/ids.js
// Identity helpers that are identical for every provider.
//
// Rule: ids are opaque strings on the outside of `models/`. Nothing above
// this folder ever sees an ObjectId, a document id, or a driver value. Each
// provider supplies its own "id adapter" so the shared query/patch builders
// can be written once.

const crypto = require("crypto");

/** Normalises any stored id-ish value to a string, or null. */
function idStr(value) {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : value.toString();
}

/** Escapes user input before it is embedded in a regular expression. */
function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Id adapter for stores that keep ids as plain strings (the JSON provider).
 * The Mongo provider ships an equivalent adapter backed by ObjectId.
 */
const stringIds = {
  name: "string",
  /**
   * string -> storage representation, or null when the input is unusable.
   *
   * Only id-shaped primitives are accepted. A plain object or array is
   * rejected rather than stringified: `String({ $in: [] })` is the truthy
   * garbage `"[object Object]"`, which turns a malformed id into a filter that
   * silently matches nothing. The Mongo adapter already rejects these (it
   * cannot build an ObjectId from them), and the two strategies must agree —
   * otherwise the same query returns everything on one provider and nothing on
   * another.
   */
  coerce(value) {
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "string") return value;
    if (typeof value === "number") {
      return Number.isFinite(value) ? String(value) : null;
    }
    if (typeof value === "bigint") return value.toString();
    return null;
  },
  /** Is this input a well-formed id for this provider? */
  isValid(value) {
    return this.coerce(value) !== null;
  },
  equal(a, b) {
    return a === b;
  },
  /** storage value -> outward-facing string. */
  toString: idStr,
};

/** Generates a 24-char hex id, shaped like an ObjectId hex string. */
function newId() {
  return crypto.randomBytes(12).toString("hex");
}

module.exports = { idStr, escapeRegex, stringIds, newId };
