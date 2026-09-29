// models/mongo/ids.js
// The MongoDB id adapter. This is the only file in the model layer that
// imports the driver, and it exists purely to satisfy the adapter shape that
// models/shared/ids.js defines.
//
// Loaded only when DATA_PROVIDER=mongo — the JSON provider never pulls the
// mongodb package in.

const { ObjectId } = require("mongodb");
const { idStr } = require("../shared/ids");

/** string -> ObjectId, or null when the input is not a usable id. */
function coerce(value) {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof ObjectId) return value;
  try {
    return new ObjectId(String(value));
  } catch {
    return null;
  }
}

const objectIds = {
  name: "objectid",
  coerce,
  isValid(value) {
    return coerce(value) !== null;
  },
  equal(a, b) {
    if (!a || !b) return false;
    return a.equals(b);
  },
  toString: idStr,
};

module.exports = { objectIds, ObjectId, coerce };
