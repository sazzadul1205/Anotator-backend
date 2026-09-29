// models/mongo/MediaDataset.js
// MongoDB implementation of the media dataset model.
//
// Method-for-method identical to models/document/MediaDataset.js. The only
// differences are the ObjectId id adapter and the use of real aggregation
// pipelines where the document store computes in JavaScript.

const storage = require("../../config/storage");
const { objectIds } = require("./oid");
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
    const oid = objectIds.coerce(id);
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
    const safeLimit = Math.min(200, Math.max(1, limit));
    const skip = (safePage - 1) * safeLimit;
    const [total, docs] = await Promise.all([
      this.collection().countDocuments({}),
      this.collection()
        .find({})
        .sort({ [sortBy]: sortDir })
        .skip(skip)
        .limit(safeLimit)
        .toArray(),
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
   * Label counts across a dataset's annotations. Mongo resolves this with a
   * real `$group`, where the document store builds the same result in JS.
   */
  static async labelCounts(datasetId) {
    const oid = objectIds.coerce(datasetId);
    if (!oid) return [];
    const rows = await this.collection()
      .aggregate([
        { $match: { datasetId: oid } },
        { $group: { _id: { $ifNull: ["$label", "(none)"] }, count: { $sum: 1 } } },
        { $sort: { count: -1, _id: 1 } },
        { $project: { _id: 0, label: "$_id", count: 1 } },
      ])
      .toArray();
    return rows;
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
      labelSetId: objectIds.coerce(dto.labelSetId),
      labelSetName: dto.labelSetName ?? null,
      labelSetAssignedAt: dto.labelSetId ? now : null,
      totalAssets: 0,
      annotatedAssets: 0,
      totalAnnotations: 0,
      totalBytes: 0,
      status: "active",
      createdBy: objectIds.coerce(dto.createdBy),
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
    if (patch && Object.prototype.hasOwnProperty.call(patch, "labelSetId")) {
      set.labelSetId = patch.labelSetId ? objectIds.coerce(patch.labelSetId) : null;
      set.labelSetAssignedAt = patch.labelSetId ? new Date() : null;
    }
    const r = await this.collection().updateOne({ _id: oid }, { $set: set });
    return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  static async setCounters(id, counters) {
    const oid = objectIds.coerce(id);
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
    const oid = objectIds.coerce(id);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteOne({ _id: oid });
    return { deletedCount: r.deletedCount };
  }
}

module.exports = MediaDataset;
