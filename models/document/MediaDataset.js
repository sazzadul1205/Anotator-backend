// models/document/MediaDataset.js
// Document-store implementation of the media dataset model.
//
// A media dataset is a named collection of image/video assets bound to one
// detection label set. It is a sibling of `Dataset`, not an extension of it:
// the text dataset's `sentiment`/`type` axis has no meaning for a bounding box,
// so the two are kept in separate collections rather than sharing one with a
// discriminator column.

const storage = require("../../config/storage");
const { stringIds } = require("../shared/ids");
const { mediaDatasetToDTO } = require("../shared/dto");
const { DuplicateKeyError, ValidationError, NotFoundError } = require("../errors");

const COLLECTION = "media_datasets";

function translateError(err) {
  if (err && err.code === 11000) {
    return new DuplicateKeyError("media dataset name");
  }
  return err;
}

const MEDIA_KINDS = ["image", "video", "mixed"];

class MediaDataset {
  static collection() {
    return storage.getStore().collection(COLLECTION);
  }

  // --- Reads ---------------------------------------------------------------

  static async findById(id) {
    const oid = stringIds.coerce(id);
    if (!oid) return null;
    return mediaDatasetToDTO(await this.collection().findOne({ _id: oid }));
  }

  static async findOne(domain) {
    const filter = {};
    if (domain && domain.name) filter.name = domain.name;
    return mediaDatasetToDTO(await this.collection().findOne(filter));
  }

  static async findMany({ page = 1, limit = 50, sortBy = "createdAt", sortDir = -1 } = {}) {
    const safePage = Math.max(1, page);
    // The same 200-row cap the comment models use, so a client cannot ask for
    // an unbounded page of datasets and exhaust memory.
    const safeLimit = Math.min(200, Math.max(1, limit));
    const skip = (safePage - 1) * safeLimit;
    const [total, docs] = await Promise.all([
      this.collection().countDocuments({}),
      this.collection().find(
        {},
        { sort: { [sortBy]: sortDir }, skip, limit: safeLimit },
      ),
    ]);
    return {
      datasets: docs.map(mediaDatasetToDTO),
      total,
      page: safePage,
      limit: safeLimit,
      totalPages: Math.ceil(total / safeLimit),
    };
  }

  static async countAll() {
    return this.collection().countDocuments({});
  }

  /**
   * Distinct label values used across a dataset's annotations, with counts.
   * Computed in JavaScript from the denormalised label column rather than with
   * an aggregation, because `distinct()` cannot return counts and the
   * alternative — a `group` per strategy — is not part of the shared store API.
   */
  static async labelCounts(annotations) {
    const counts = new Map();
    for (const a of annotations || []) {
      const key = a.label || "(none)";
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label));
  }

  // --- Writes --------------------------------------------------------------

  static async create(dto) {
    if (!dto.name || !String(dto.name).trim()) {
      throw new ValidationError("Dataset name is required");
    }
    if (dto.mediaKind && !MEDIA_KINDS.includes(dto.mediaKind)) {
      throw new ValidationError(
        `mediaKind must be one of: ${MEDIA_KINDS.join(", ")}`,
      );
    }
    const now = new Date();
    const doc = {
      name: String(dto.name).trim(),
      description: dto.description || "",
      mediaKind: dto.mediaKind || "mixed",
      labelSetId: dto.labelSetId ? stringIds.coerce(dto.labelSetId) : null,
      labelSetName: dto.labelSetName ?? null,
      labelSetAssignedAt: dto.labelSetId ? now : null,
      totalAssets: 0,
      annotatedAssets: 0,
      totalAnnotations: 0,
      totalBytes: 0,
      status: "active",
      createdBy: stringIds.coerce(dto.createdBy),
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
    if (patch && Object.prototype.hasOwnProperty.call(patch, "labelSetId")) {
      set.labelSetId = patch.labelSetId ? stringIds.coerce(patch.labelSetId) : null;
      set.labelSetAssignedAt = patch.labelSetId ? new Date() : null;
    }
    const r = await this.collection().updateOne({ _id: oid }, { $set: set });
    return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  /**
   * Writes the denormalised counters. The asset service calls this after every
   * upload, annotation and delete, so the dataset list view is one query rather
   * than an aggregate per row. The values are passed in rather than recomputed
   * here, because the service is the layer that knows what changed.
   */
  static async setCounters(id, counters) {
    const oid = stringIds.coerce(id);
    if (!oid) return { matchedCount: 0, modifiedCount: 0 };
    const set = { updatedAt: new Date() };
    for (const key of [
      "totalAssets",
      "annotatedAssets",
      "totalAnnotations",
      "totalBytes",
    ]) {
      if (Object.prototype.hasOwnProperty.call(counters || {}, key)) {
        set[key] = Number(counters[key]) || 0;
      }
    }
    const r = await this.collection().updateOne({ _id: oid }, { $set: set });
    return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  static async assertExists(id) {
    const found = await this.findById(id);
    if (!found) throw new NotFoundError("Media dataset not found");
    return found;
  }

  static async deleteById(id) {
    const oid = stringIds.coerce(id);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteOne({ _id: oid });
    return { deletedCount: r.deletedCount };
  }
}

module.exports = MediaDataset;
