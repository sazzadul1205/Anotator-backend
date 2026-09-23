// models/Taxonomy.js
// Handles the "taxonomies" collection — reusable label sets.
// A taxonomy is a named group of sentiment options + type options
// (e.g. positive/negative/neutral + bangla/english/banglish).
// Any dataset can reference a taxonomy.

const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");

const COLLECTION = "taxonomies";

class Taxonomy {
  static collection() {
    return getDB().collection(COLLECTION);
  }

  // Find a taxonomy by _id.
  static async findById(id) {
    return this.collection().findOne({ _id: new ObjectId(id) });
  }

  // List taxonomies with optional filter.
  // Sorted by kind → order → label for a stable UI display.
  static async find(filter = {}, options = {}) {
    let cursor = this.collection().find(filter);
    cursor = cursor.sort({ kind: 1, order: 1, label: 1 });
    if (options.projection) cursor = cursor.project(options.projection);
    return cursor.toArray();
  }

  // Create a taxonomy. Auto-stamps timestamps.
  static async create(doc) {
    const now = new Date();
    const result = await this.collection().insertOne({
      ...doc,
      createdAt: now,
      updatedAt: now,
    });
    return result.insertedId;
  }

  // Update any fields; auto-bumps updatedAt.
  static async updateById(id, updates) {
    return this.collection().updateOne(
      { _id: new ObjectId(id) },
      { $set: { ...updates, updatedAt: new Date() } },
    );
  }

  // Soft delete: just mark inactive.
  // Datasets referencing it keep working — they just can't be
  // newly assigned this taxonomy.
  static async deactivate(id, userId) {
    return this.collection().updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          isActive: false,
          updatedAt: new Date(),
          updatedBy: new ObjectId(userId),
        },
      },
    );
  }

  // Hard delete (only allowed if no datasets reference it).
  static async deleteById(id) {
    return this.collection().deleteOne({ _id: new ObjectId(id) });
  }

  // Safety check for hard-delete: how many datasets use this taxonomy?
  static async countDatasetsUsing(taxonomyId) {
    const db = getDB();
    return db.collection("datasets").countDocuments({
      taxonomyId: new ObjectId(taxonomyId),
    });
  }
}

module.exports = Taxonomy;
