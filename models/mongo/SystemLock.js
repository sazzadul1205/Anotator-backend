// models/mongo/SystemLock.js
// MongoDB implementation of SystemLock — named mutexes used by the bootstrap
// route so only one admin is ever created, even under concurrent requests.

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
    try {
      await this.collection().insertOne({
        _id: id,
        claimedAt: new Date(),
      });
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
