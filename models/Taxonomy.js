// models/Taxonomy.js
// Reusable label sets attached to datasets.

const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");

const COLLECTION = "taxonomies";

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

function toDTO(doc) {
  if (!doc) return null;
  return {
    id: idStr(doc._id),
    name: doc.name,
    description: doc.description ?? "",
    sentiment: doc.sentiment || [],
    type: doc.type || [],
    isActive: doc.isActive,
    createdBy: idStr(doc.createdBy),
    updatedBy: idStr(doc.updatedBy),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

function toMongoFilter(domain = {}) {
  const f = {};
  if (domain.kind) f.kind = domain.kind;
  if (domain.isActive !== undefined) f.isActive = domain.isActive;
  return f;
}

class Taxonomy {
  static collection() {
    return getDB().collection(COLLECTION);
  }

  static async findById(id) {
    const oid = toOid(id);
    if (!oid) return null;
    const doc = await this.collection().findOne({ _id: oid });
    return toDTO(doc);
  }

  /** List taxonomies, sorted by kind -> order -> label. */
  static async findMany(domainFilter = {}) {
    const docs = await this.collection()
      .find(toMongoFilter(domainFilter))
      .sort({ kind: 1, order: 1, label: 1 })
      .toArray();
    return docs.map(toDTO);
  }

  /** Create a taxonomy. Returns { id }. */
  static async create(dto) {
    const now = new Date();
    const doc = {
      name: dto.name,
      description: dto.description || "",
      sentiment: dto.sentiment || [],
      type: dto.type || [],
      isActive: dto.isActive !== false,
      createdBy: dto.createdBy ? toOid(dto.createdBy) : null,
      updatedBy: dto.updatedBy ? toOid(dto.updatedBy) : null,
      createdAt: now,
      updatedAt: now,
    };
    const r = await this.collection().insertOne(doc);
    return { id: r.insertedId.toString() };
  }

  static async updateById(id, patch) {
    const oid = toOid(id);
    if (!oid) return { matchedCount: 0, modifiedCount: 0 };
    const set = { ...patch, updatedAt: new Date() };
    delete set.id;
    delete set._id;
    if ("updatedBy" in set) {
      set.updatedBy = set.updatedBy ? toOid(set.updatedBy) : null;
    }
    const r = await this.collection().updateOne({ _id: oid }, { $set: set });
    return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  /** Soft delete. */
  static async deactivate(id, userId) {
    const oid = toOid(id);
    if (!oid) return { matchedCount: 0 };
    return this.collection().updateOne(
      { _id: oid },
      {
        $set: {
          isActive: false,
          updatedAt: new Date(),
          updatedBy: userId ? toOid(userId) : null,
        },
      },
    );
  }

  static async deleteById(id) {
    const oid = toOid(id);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteOne({ _id: oid });
    return { deletedCount: r.deletedCount };
  }

  /** How many datasets reference this taxonomy. */
  static async countDatasetsUsing(taxonomyId) {
    const oid = toOid(taxonomyId);
    if (!oid) return 0;
    return getDB().collection("datasets").countDocuments({ taxonomyId: oid });
  }
}

module.exports = Taxonomy;
