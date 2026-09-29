// models/document/MediaLabelSet.js
// Document-store implementation of the media label set model.
//
// A label set is the detection class vocabulary for a dataset: the flat
// equivalent of a taxonomy. Each entry is `{ value, label, color }`:
//
//   value  a stable slug — what COCO's `category_name` and the YOLO class row
//          are keyed on. Never rename one: a rename silently relabels an
//          entire trained dataset.
//   label  the human-readable text shown in the annotator UI.
//   color  an annotator affordance only; no export format reads it.
//
// The `value` is what an annotation stores, so a label set can be renamed or
// re-coloured without touching a single annotation.

const storage = require("../../config/storage");
const { stringIds } = require("../shared/ids");
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
    const oid = stringIds.coerce(id);
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
    const docs = await this.collection().find(filter, { sort: { name: 1 } });
    return docs.map(mediaLabelSetToDTO);
  }

  static async findAll() {
    const docs = await this.collection().find({}, { sort: { name: 1 } });
    return docs.map(mediaLabelSetToDTO);
  }

  /**
   * Datasets currently bound to this label set. Used to block deletion of a
   * label set that is still in use — removing the vocabulary out from under a
   * dataset would make every existing annotation unexportable.
   */
  static async findAllById(id) {
    const oid = stringIds.coerce(id);
    if (!oid) return [];
    return this.collection().find({ _id: oid });
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
      createdBy: stringIds.coerce(dto.createdBy),
      updatedBy: stringIds.coerce(dto.updatedBy || dto.createdBy),
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
    const oid = stringIds.coerce(id);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteOne({ _id: oid });
    return { deletedCount: r.deletedCount };
  }
}

module.exports = MediaLabelSet;
