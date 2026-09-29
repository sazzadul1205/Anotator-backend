// models/mongo/MediaLabelSet.js
// MongoDB implementation of the media label set model.
//
// Method-for-method identical to models/document/MediaLabelSet.js.

const storage = require("../../config/storage");
const { objectIds } = require("./oid");
const { mediaLabelSetToDTO } = require("../shared/dto");
const { DuplicateKeyError, ValidationError, NotFoundError } = require("../errors");

const COLLECTION = "media_label_sets";

function translateError(err) {
  if (err && err.code === 11000) {
    return new DuplicateKeyError("label set name");
  }
  return err;
}

class MediaLabelSet {
  static collection() {
    return storage.getStore().collection(COLLECTION);
  }

  // --- Reads ---------------------------------------------------------------

  static async findById(id) {
    const oid = objectIds.coerce(id);
    if (!oid) return null;
    return mediaLabelSetToDTO(await this.collection().findOne({ _id: oid }));
  }

  static async findOne(domain) {
    const filter = {};
    if (domain && domain.name) filter.name = domain.name;
    return mediaLabelSetToDTO(await this.collection().findOne(filter));
  }

  static async findMany({ includeInactive = false } = {}) {
    const filter = includeInactive ? {} : { isActive: true };
    const docs = await this.collection().find(filter).sort({ name: 1 }).toArray();
    return docs.map(mediaLabelSetToDTO);
  }

  static async findAll() {
    const docs = await this.collection().find({}).sort({ name: 1 }).toArray();
    return docs.map(mediaLabelSetToDTO);
  }

  static async findAllById(id) {
    const oid = objectIds.coerce(id);
    if (!oid) return [];
    return this.collection().find({ _id: oid }).toArray();
  }

  static async assertExists(id) {
    const found = await this.findById(id);
    if (!found) throw new NotFoundError("Label set not found");
    return found;
  }

  // --- Writes --------------------------------------------------------------

  static async create(dto) {
    if (!dto.name || !String(dto.name).trim()) {
      throw new ValidationError("Label set name is required");
    }
    if (!Array.isArray(dto.labels) || dto.labels.length === 0) {
      throw new ValidationError("A label set needs at least one label");
    }
    const now = new Date();
    const doc = {
      name: String(dto.name).trim(),
      description: dto.description || "",
      labels: dto.labels,
      isActive: dto.isActive !== false,
      createdBy: objectIds.coerce(dto.createdBy),
      updatedBy: objectIds.coerce(dto.updatedBy || dto.createdBy),
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

  static async updateById(id, patch) {
    const oid = objectIds.coerce(id);
    if (!oid) return { matchedCount: 0, modifiedCount: 0 };
    const set = { updatedAt: new Date() };
    if (patch && Object.prototype.hasOwnProperty.call(patch, "name")) {
      set.name = String(patch.name).trim();
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, "description")) {
      set.description = patch.description || "";
    }
    if (patch && Array.isArray(patch.labels)) {
      set.labels = patch.labels;
    }
    if (patch && Object.prototype.hasOwnProperty.call(patch, "isActive")) {
      set.isActive = Boolean(patch.isActive);
    }
    const r = await this.collection().updateOne({ _id: oid }, { $set: set });
    return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  static async deleteById(id) {
    const oid = objectIds.coerce(id);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteOne({ _id: oid });
    return { deletedCount: r.deletedCount };
  }
}

module.exports = MediaLabelSet;
