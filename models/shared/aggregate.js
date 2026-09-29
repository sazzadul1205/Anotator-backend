// models/shared/aggregate.js
// Aggregation primitives for the JSON provider.
//
// MongoDB answers these questions with pipelines ($group, $bucket, $lookup,
// $dateToString). The JSON provider has no query engine, so it computes the
// same answers in plain JavaScript — but returns byte-identical results, which
// is what models/contract.js and tests/storage-parity.js verify.

/** "YYYY-MM-DD" in UTC — the equivalent of $dateToString { format: "%Y-%m-%d" }. */
function dateKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Equivalent of `{ $group: { _id: <expr>, count: { $sum: 1 } } }`.
 * `keyFn` returns the group key; keys are compared by identity.
 */
function countBy(rows, keyFn) {
  const buckets = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    buckets.set(key, (buckets.get(key) || 0) + 1);
  }
  return buckets;
}

/**
 * Equivalent of the `$bucket` stage used by Comment.lengthHistogram.
 * Only non-empty buckets are emitted, in ascending boundary order, and
 * everything at or beyond the last boundary lands in the overflow bucket.
 *
 * @param {Array} rows
 * @param {(row:any)=>number} lengthFn  produces the length for a row
 * @param {number[]} boundaries         ascending, e.g. [0, 50, 100, 200]
 */
function bucketByBoundaries(rows, lengthFn, boundaries) {
  const counts = countBy(rows, (row) =>
    lengthBucketKey(lengthFn(row), boundaries),
  );
  const out = [];

  boundaries.forEach((start, idx) => {
    if (boundaries[idx + 1] === undefined) return; // last boundary starts overflow
    const count = counts.get(start) || 0;
    if (count > 0) out.push({ label: `${start}–${boundaries[idx + 1] - 1}`, count });
  });

  const overflow = counts.get("overflow") || 0;
  if (overflow > 0) {
    out.push({ label: `${boundaries[boundaries.length - 1]}+`, count: overflow });
  }
  return out;
}

/** Assigns a length to a bucket key, mirroring $bucket's groupBy. */
function lengthBucketKey(length, boundaries) {
  for (let i = 0; i < boundaries.length - 1; i += 1) {
    if (length >= boundaries[i] && length < boundaries[i + 1]) {
      return boundaries[i];
    }
  }
  return "overflow";
}

/** Counts how many rows satisfy each status, as used by the summary helpers. */
function statusSummary(rows) {
  return rows.reduce(
    (acc, row) => {
      acc.total += 1;
      if (row.status === "annotated") acc.annotated += 1;
      if (row.status === "pending") acc.pending += 1;
      return acc;
    },
    { total: 0, annotated: 0, pending: 0 },
  );
}

module.exports = { dateKey, countBy, bucketByBoundaries, lengthBucketKey, statusSummary };
