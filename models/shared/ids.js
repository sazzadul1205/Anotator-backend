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
  /** string -> storage representation, or null when the input is unusable. */
  coerce(value) {
    if (value === null || value === undefined || value === "") return null;
    return typeof value === "string" ? value : String(value);
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
