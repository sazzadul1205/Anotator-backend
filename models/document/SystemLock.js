// models/document/SystemLock.js
// Document-store implementation of SystemLock.
//
// Mutual exclusion is guaranteed by the single-threaded event loop: the
// check-and-insert below cannot interleave with another request, so two
// concurrent bootstraps can never both succeed. (The Mongo version relies on
// the unique `_id` index instead; the observable behaviour is identical.)

const storage = require("../../config/storage");
const { DuplicateKeyError } = require("../errors");

const COLLECTION = "system_locks";

class SystemLock {
  static collection() {
    return storage.getStore().collection(COLLECTION);
  }

  /**
   * Try to claim a lock by inserting a doc with a fixed _id.
   * Throws DuplicateKeyError if the lock is already held.
   */
  static async claim(id) {
    if (await this.exists(id)) {
      throw new DuplicateKeyError("lock", id);
    }
    try {
      await this.collection().insertOne({ _id: id, claimedAt: new Date() });
      return { claimed: true };
    } catch (err) {
      if (err && err.code === 11000) {
        throw new DuplicateKeyError("lock", id);
      }
      throw err;
    }
  }

  /** Release a lock. Idempotent. */
  static async release(id) {
    const r = await this.collection().deleteOne({ _id: id });
    return { released: r.deletedCount > 0 };
  }

  /** Check whether a lock is currently held. */
  static async exists(id) {
    const doc = await this.collection().findOne({ _id: id });
    return !!doc;
  }
}

module.exports = SystemLock;
