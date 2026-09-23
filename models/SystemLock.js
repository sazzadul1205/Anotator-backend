// models/SystemLock.js
// Handles the "system_locks" collection — tiny distributed locks.
// Currently used ONLY for bootstrap: it guarantees that even if two
// requests try to create the first admin at the same time, only one wins.

const { getDB } = require("../config/db");

const COLLECTION = "system_locks";

class SystemLock {
  static collection() {
    return getDB().collection(COLLECTION);
  }

  // Try to claim a lock by inserting a document with a fixed _id.
  // If another request already claimed it, MongoDB's unique _id
  // constraint throws error code 11000 — that's our "lock is taken" signal.
  static async claim(id) {
    return this.collection().insertOne({
      _id: id, // e.g. "admin_bootstrap"
      claimedAt: new Date(),
    });
  }

  // Release the lock (called when the operation finishes or fails).
  static async release(id) {
    return this.collection().deleteOne({ _id: id });
  }

  // Check whether a lock is currently held.
  static async exists(id) {
    return this.collection().findOne({ _id: id });
  }
}

module.exports = SystemLock;
