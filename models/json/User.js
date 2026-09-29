// models/json/User.js
// JSON-provider implementation of the User model.
//
// Method-for-method identical to models/mongo/User.js. The only differences
// are mechanical:
//   * ids are plain strings (stringIds adapter instead of ObjectId)
//   * queries are evaluated by the in-process matcher in config/storage/jsonStore
//   * uniqueness is enforced in code from config/storage/schema.js

const storage = require("../../config/storage");
const { stringIds } = require("../shared/ids");
const { userToDTO } = require("../shared/dto");
const { userFilter, normalizeEmail } = require("../shared/filters");
const { DuplicateKeyError, ValidationError } = require("../errors");

const COLLECTION = "users";

function translateError(err) {
  if (err && err.code === 11000) {
    return new DuplicateKeyError("email");
  }
  return err;
}

class User {
  static collection() {
    return storage.getStore().collection(COLLECTION);
  }

  // --- Reads ---------------------------------------------------------------

  static async findById(id) {
    const oid = stringIds.coerce(id);
    if (!oid) return null;
    const doc = await this.collection().findOne({ _id: oid });
    return userToDTO(doc);
  }

  static async findByIdWithPassword(id) {
    const oid = stringIds.coerce(id);
    if (!oid) return null;
    const doc = await this.collection().findOne({ _id: oid });
    return userToDTO(doc, { includePassword: true });
  }

  static async findByEmail(email) {
    const doc = await this.collection().findOne({ email: normalizeEmail(email) });
    return userToDTO(doc, { includePassword: true });
  }

  static async findOne(domainFilter) {
    const doc = await this.collection().findOne(userFilter(domainFilter, stringIds));
    return userToDTO(doc);
  }

  static async findMany(domainFilter = {}) {
    const docs = await this.collection().find(userFilter(domainFilter, stringIds), {
      sort: { createdAt: -1 },
    });
    return docs.map((d) => userToDTO(d));
  }

  static async findAll() {
    return this.findMany({});
  }

  // --- Writes --------------------------------------------------------------

  static async create(dto) {
    if (!dto.email || !dto.password) {
      throw new ValidationError("email and password are required");
    }
    const now = new Date();
    const doc = {
      email: normalizeEmail(dto.email),
      name: dto.name ? String(dto.name).trim() : "",
      password: dto.password,
      role: dto.role,
      isActive: true,
      tokenVersion: 0,
      createdAt: now,
      updatedAt: now,
    };
    try {
      const r = await this.collection().insertOne(doc);
      return { id: r.insertedId };
    } catch (err) {
      throw translateError(err);
    }
  }

  static async updateById(id, patch) {
    const oid = stringIds.coerce(id);
    if (!oid) return { matchedCount: 0, modifiedCount: 0 };

    const set = { ...patch, updatedAt: new Date() };
    delete set.id;
    delete set._id;
    if (set.email) set.email = normalizeEmail(set.email);

    try {
      const r = await this.collection().updateOne({ _id: oid }, { $set: set });
      return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
    } catch (err) {
      throw translateError(err);
    }
  }

  static async updateStatus(id, isActive) {
    const oid = stringIds.coerce(id);
    if (!oid) return { matchedCount: 0 };
    const update = { $set: { isActive, updatedAt: new Date() } };
    if (!isActive) update.$inc = { tokenVersion: 1 };
    return this.collection().updateOne({ _id: oid }, update);
  }

  static async updatePassword(id, hashedPassword) {
    const oid = stringIds.coerce(id);
    if (!oid) return { matchedCount: 0 };
    return this.collection().updateOne(
      { _id: oid },
      {
        $set: { password: hashedPassword, updatedAt: new Date() },
        $inc: { tokenVersion: 1 },
      },
    );
  }

  static async bumpTokenVersion(id) {
    const oid = stringIds.coerce(id);
    if (!oid) return { matchedCount: 0 };
    return this.collection().updateOne(
      { _id: oid },
      { $inc: { tokenVersion: 1 }, $set: { updatedAt: new Date() } },
    );
  }

  static async deleteById(id) {
    const oid = stringIds.coerce(id);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteOne({ _id: oid });
    return { deletedCount: r.deletedCount };
  }

  // --- Counts --------------------------------------------------------------

  static async countAdmins() {
    return this.collection().countDocuments({ role: "admin" });
  }

  static async countActiveAnnotators() {
    return this.collection().countDocuments({ role: "annotator", isActive: true });
  }

  static async countAll() {
    return this.collection().countDocuments({});
  }

  static async countActive() {
    return this.collection().countDocuments({ isActive: true });
  }
}

module.exports = User;
