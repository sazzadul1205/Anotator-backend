// models/shared/presenceFilters.js
// Domain filter -> provider query for the presence domain.
//
// Kept in `shared/` for the same reason as `filters.js` and `mediaFilters.js`:
// this is the single translation point between what the service asks for and
// what a provider executes, so the two strategies cannot disagree about what a
// filter means.
//
// Every field referenced here MUST be declared in `config/storage/schema.js`.
// On SQLite and MySQL the SQL layer refuses to filter on an undeclared field
// rather than scanning the per-row `extra` JSON blob and returning rows that do
// not match the caller's intent.

const { stringIds } = require("./ids");

/**
 * Fields a caller may filter a session by.
 *
 * `lastState` is here so a caller can ask for "sessions that claim to be
 * active" — but presenceService never filters on it alone when deciding
 * whether somebody is online. It is always combined with a `lastSeenAt` cutoff,
 * because a client-reported state is a claim, not a fact.
 */
const SESSION_FILTERABLE = ["sessionKey", "lastState"];

/**
 * Builds a presence-session filter.
 *
 * Time bounds land on `lastSeenAt`, which is the only timestamp that reliably
 * means "this session was alive during the window". `startedAt` is excluded on
 * purpose: a tab opened a week ago and still open is a session that was *seen*
 * this week, and filtering on its start would drop a genuinely live session.
 */
function presenceSessionFilter(domain = {}, ids = stringIds) {
  const f = {};

  if (domain.userId) {
    const userId = ids.coerce(domain.userId);
    if (userId) f.userId = userId;
  }

  // An array of users, for the board ("everyone seen since the cutoff").
  // An empty list must match nothing, per the parity rules, rather than
  // everything — a malformed id list must never widen a query.
  if (Array.isArray(domain.userIds)) {
    f.userId = { $in: domain.userIds.map((u) => ids.coerce(u)).filter(Boolean) };
  }

  for (const field of SESSION_FILTERABLE) {
    if (domain[field] === undefined) continue;
    f[field] = domain[field];
  }

  if (domain.seenFrom || domain.seenTo) {
    f.lastSeenAt = {};
    if (domain.seenFrom) f.lastSeenAt.$gte = domain.seenFrom;
    if (domain.seenTo) f.lastSeenAt.$lte = domain.seenTo;
  }

  return f;
}

module.exports = {
  SESSION_FILTERABLE,
  presenceSessionFilter,
};
