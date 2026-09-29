// models/mongo/Taxonomy.js
// MongoDB implementation of the Taxonomy model — reusable label sets that a
// dataset can reference.

const storage = require("../../config/storage");
const { objectIds } = require("./oid");
const { taxonomyToDTO } = require("../shared/dto");
const { taxonomyFilter } = require("../shared/filters");

const COLLECTION = "taxonomies";

class Taxonomy {
  static collection() {
    return storage.getStore().collection(COLLECTION);
  }

  static async findById(id) {
    const oid = objectIds.coerce(id);
    if (!oid) return null;
    const doc = await this.collection().findOne({ _id: oid });
    return taxonomyToDTO(doc);
  }

  static async findMany(domainFilter = {}) {
    const docs = await this.collection()
      .find(taxonomyFilter(domainFilter, objectIds))
      .sort({ kind: 1, order: 1, label: 1 })
      .toArray();
    return docs.map(taxonomyToDTO);
  }

  static async create(dto) {
    const now = new Date();
    const doc = {
      name: dto.name,
      description: dto.description || "",
      sentiment: dto.sentiment || [],
      type: dto.type || [],
      isActive: dto.isActive !== false,
      createdBy: dto.createdBy ? objectIds.coerce(dto.createdBy) : null,
      updatedBy: dto.updatedBy ? objectIds.coerce(dto.updatedBy) : null,
      createdAt: now,
      updatedAt: now,
    };
    const r = await this.collection().insertOne(doc);
    return { id: r.insertedId.toString() };
  }

  static async updateById(id, patch) {
    const oid = objectIds.coerce(id);
    if (!oid) return { matchedCount: 0, modifiedCount: 0 };
    const set = { ...patch, updatedAt: new Date() };
    delete set.id;
    delete set._id;
    if ("updatedBy" in set) {
      set.updatedBy = set.updatedBy ? objectIds.coerce(set.updatedBy) : null;
    }
    const r = await this.collection().updateOne({ _id: oid }, { $set: set });
    return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  static async deactivate(id, userId) {
    const oid = objectIds.coerce(id);
    if (!oid) return { matchedCount: 0 };
    return this.collection().updateOne(
      { _id: oid },
      {
        $set: {
          isActive: false,
          updatedAt: new Date(),
          updatedBy: userId ? objectIds.coerce(userId) : null,
        },
      },
    );
  }

  static async deleteById(id) {
    const oid = objectIds.coerce(id);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteOne({ _id: oid });
    return { deletedCount: r.deletedCount };
  }

  static async countDatasetsUsing(taxonomyId) {
    const oid = objectIds.coerce(taxonomyId);
    if (!oid) return 0;
    return storage.getStore()
      .collection("datasets")
      .countDocuments({ taxonomyId: oid });
  }
}

module.exports = Taxonomy;
