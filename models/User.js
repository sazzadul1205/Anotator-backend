// models/User.js
// This model handles everything related to the "users" collection in MongoDB.
// It's a "static class" — we never create instances with `new User()`.
// We just call User.findById(), User.create(), etc.

const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");

// The MongoDB collection name this model talks to
const COLLECTION = "users";

class User {
  // Helper: returns the raw MongoDB collection so we don't repeat getDB() everywhere
  static collection() {
    return getDB().collection(COLLECTION);
  }

  // Find one user by their _id.
  // IMPORTANT: we strip out password fields so they never leak to the API.
  static async findById(id) {
    return this.collection().findOne(
      { _id: new ObjectId(id) },
      { projection: { password: 0, passwordHash: 0 } },
    );
  }

  // Same as findById, but KEEPS the password.
  // Only used internally (e.g. login check) — never send this to the client.
  static async findByIdWithPassword(id) {
    return this.collection().findOne({ _id: new ObjectId(id) });
  }

  // Find a user by email. We lowercase + trim so lookups are case-insensitive.
  static async findByEmail(email) {
    return this.collection().findOne({ email: email.toLowerCase().trim() });
  }

  // Return every user, without passwords.
  static async findAll() {
    return this.collection()
      .find({}, { projection: { password: 0, passwordHash: 0 } })
      .toArray();
  }

  // Insert a new user.
  // We auto-set defaults (isActive, tokenVersion, timestamps) so callers
  // only need to pass name/email/password/role.
  static async create(doc) {
    const now = new Date();
    const result = await this.collection().insertOne({
      ...doc,
      isActive: true, // new users are active by default
      tokenVersion: 0, // used to invalidate JWTs
      createdAt: now,
      updatedAt: now,
    });
    return result.insertedId; // return the new user's _id
  }

  // Update a user's fields. Always bumps updatedAt.
  static async updateById(id, updates) {
    return this.collection().updateOne(
      { _id: new ObjectId(id) },
      { $set: { ...updates, updatedAt: new Date() } },
    );
  }

  // Activate or deactivate a user.
  // When deactivating, we ALSO bump tokenVersion — this instantly
  // invalidates any JWT the user currently holds (forces logout).
  static async updateStatus(id, isActive) {
    const update = {
      $set: { isActive, updatedAt: new Date() },
    };
    if (!isActive) update.$inc = { tokenVersion: 1 };
    return this.collection().updateOne({ _id: new ObjectId(id) }, update);
  }

  // Change password + bump tokenVersion (forces re-login on all devices).
  static async updatePassword(id, hashedPassword) {
    return this.collection().updateOne(
      { _id: new ObjectId(id) },
      {
        $set: { password: hashedPassword, updatedAt: new Date() },
        $inc: { tokenVersion: 1 },
      },
    );
  }

  // Hard delete a user.
  static async deleteById(id) {
    return this.collection().deleteOne({ _id: new ObjectId(id) });
  }

  // --- Count helpers (used by dashboards and safety checks) ---

  // Used by bootstrap to check if an admin already exists.
  static async countAdmins() {
    return this.collection().countDocuments({ role: "admin" });
  }

  // Used by dashboard stats.
  static async countActiveAnnotators() {
    return this.collection().countDocuments({
      role: "annotator",
      isActive: true,
    });
  }

  static async countAll() {
    return this.collection().countDocuments({});
  }

  static async countActive() {
    return this.collection().countDocuments({ isActive: true });
  }
}

module.exports = User;
