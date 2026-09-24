// models/User.js
// Everything related to the "users" collection.

const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");
const { DuplicateKeyError, ValidationError } = require("./errors");

const COLLECTION = "users";

function toOid(id) {
  if (!id) return null;
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

function idStr(v) {
  if (v === null) return null;
  return typeof v === "string" ? v : v.toString();
}

/**
 * Convert a Mongo user doc to DTO.
 * Pass { includePassword: true } to include the bcrypt hash
 * (only for auth flows; never send this to the client).
 */
function toDTO(doc, { includePassword = false } = {}) {
  if (!doc) return null;
  const dto = {
    id: idStr(doc._id),
    email: doc.email,
    name: doc.name,
    role: doc.role,
    isActive: doc.isActive,
    tokenVersion: doc.tokenVersion ?? 0,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
  if (includePassword) dto.password = doc.password;
  return dto;
}

function toMongoFilter(domain = {}) {
  const f = {};
  if (domain.role) f.role = domain.role;
  if (domain.isActive !== undefined) f.isActive = domain.isActive;
  if (domain.email) f.email = String(domain.email).toLowerCase().trim();
  return f;
}

function translateError(err) {
  if (err && err.code === 11000) {
    return new DuplicateKeyError("email");
  }
  return err;
}

class User {
  static collection() {
    return getDB().collection(COLLECTION);
  }

  // --- Reads ---------------------------------------------------------------

  /** Find by id. Returns DTO (no password) or null. */
  static async findById(id) {
    const oid = toOid(id);
    if (!oid) return null;
    const doc = await this.collection().findOne({ _id: oid });
    return toDTO(doc);
  }

  /**
   * Find by id and INCLUDE the password hash.
   * Use only for internal auth flows.
   */
  static async findByIdWithPassword(id) {
    const oid = toOid(id);
    if (!oid) return null;
    const doc = await this.collection().findOne({ _id: oid });
    return toDTO(doc, { includePassword: true });
  }

  /**
   * Find by email. Returns DTO WITH password hash (needed by login).
   * If you need to check existence, use findOne({ email }) instead.
   */
  static async findByEmail(email) {
    const doc = await this.collection().findOne({
      email: String(email).toLowerCase().trim(),
    });
    return toDTO(doc, { includePassword: true });
  }

  /** Find one user matching a domain filter (no password). */
  static async findOne(domainFilter) {
    const doc = await this.collection().findOne(toMongoFilter(domainFilter));
    return toDTO(doc);
  }

  /** List all users without passwords, newest first. */
  static async findMany(domainFilter = {}) {
    const docs = await this.collection()
      .find(toMongoFilter(domainFilter))
      .sort({ createdAt: -1 })
      .toArray();
    return docs.map((d) => toDTO(d));
  }

  /** Convenience: list every user. */
  static async findAll() {
    return this.findMany({});
  }

  // --- Writes --------------------------------------------------------------

  /**
   * Insert a new user. Defaults: isActive true, tokenVersion 0, timestamps.
   * Returns { id }.
   * Throws DuplicateKeyError if email is taken.
   */
  static async create(dto) {
    if (!dto.email || !dto.password) {
      throw new ValidationError("email and password are required");
    }
    const now = new Date();
    const doc = {
      email: String(dto.email).toLowerCase().trim(),
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
      return { id: r.insertedId.toString() };
    } catch (err) {
      throw translateError(err);
    }
  }

  /** Update user fields. Auto-bumps updatedAt. */
  static async updateById(id, patch) {
    const oid = toOid(id);
    if (!oid) return { matchedCount: 0, modifiedCount: 0 };

    const set = { ...patch, updatedAt: new Date() };
    delete set.id;
    delete set._id;
    if (set.email) set.email = String(set.email).toLowerCase().trim();

    try {
      const r = await this.collection().updateOne({ _id: oid }, { $set: set });
      return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
    } catch (err) {
      throw translateError(err);
    }
  }

  /**
   * Set isActive. When deactivating, bumps tokenVersion to invalidate
   * any JWTs the user currently holds.
   */
  static async updateStatus(id, isActive) {
    const oid = toOid(id);
    if (!oid) return { matchedCount: 0 };
    const update = { $set: { isActive, updatedAt: new Date() } };
    if (!isActive) update.$inc = { tokenVersion: 1 };
    return this.collection().updateOne({ _id: oid }, update);
  }

  /**
   * Replace password. Bumps tokenVersion (forces logout on all devices).
   */
  static async updatePassword(id, hashedPassword) {
    const oid = toOid(id);
    if (!oid) return { matchedCount: 0 };
    return this.collection().updateOne(
      { _id: oid },
      {
        $set: { password: hashedPassword, updatedAt: new Date() },
        $inc: { tokenVersion: 1 },
      },
    );
  }

  /**
   * Bump tokenVersion only. Used by logout.
   */
  static async bumpTokenVersion(id) {
    const oid = toOid(id);
    if (!oid) return { matchedCount: 0 };
    return this.collection().updateOne(
      { _id: oid },
      { $inc: { tokenVersion: 1 }, $set: { updatedAt: new Date() } },
    );
  }

  static async deleteById(id) {
    const oid = toOid(id);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteOne({ _id: oid });
    return { deletedCount: r.deletedCount };
  }

  // --- Counts --------------------------------------------------------------

  static async countAdmins() {
    return this.collection().countDocuments({ role: "admin" });
  }

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
