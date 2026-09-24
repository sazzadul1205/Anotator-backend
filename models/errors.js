// models/errors.js
// Domain error classes every model adapter throws.
// Services catch these by name — they never see raw driver error codes.

/**
 * Thrown when a unique constraint (or unique index) is violated.
 * Each adapter translates its native error into this one:
 *   Mongo  : err.code === 11000
 *   Postgres: err.code === '23505'
 *   MySQL  : err.code === 'ER_DUP_ENTRY'
 *   SQLite : err.code === 'SQLITE_CONSTRAINT_UNIQUE'
 *   JSON   : adapter checks in code
 */
class DuplicateKeyError extends Error {
  constructor(field = "unknown", value = undefined) {
    super(
      `Duplicate value for ${field}${value !== undefined ? `: ${value}` : ""}`,
    );
    this.name = "DuplicateKeyError";
    this.status = 409;
    this.field = field;
    this.value = value;
  }
}

/** Thrown when a requested record does not exist. */
class NotFoundError extends Error {
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFoundError";
    this.status = 404;
  }
}

/** Thrown for invalid inputs the model refuses to accept. */
class ValidationError extends Error {
  constructor(message = "Invalid input") {
    super(message);
    this.name = "ValidationError";
    this.status = 400;
  }
}

/** Thrown when a write would violate a business rule. */
class ConflictError extends Error {
  constructor(message = "Conflict") {
    super(message);
    this.name = "ConflictError";
    this.status = 409;
  }
}

module.exports = {
  DuplicateKeyError,
  NotFoundError,
  ValidationError,
  ConflictError,
};
