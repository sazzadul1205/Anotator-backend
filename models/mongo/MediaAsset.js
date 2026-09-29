// models/mongo/MediaAsset.js
// MongoDB implementation of the media asset model.
//
// Method-for-method identical to models/document/MediaAsset.js. As there, only
// metadata lives here — the file bytes are on disk, addressed by `storagePath`,
// which never leaves the model layer.

const storage = require("../../config/storage");
const { objectIds } = require("./oid");
const { mediaAssetToDTO } = require("../shared/dto");
const { mediaAssetFilter } = require("../shared/mediaFilters");
const { DuplicateKeyError, ValidationError, NotFoundError } = require("../errors");

const COLLECTION = "media_assets";

function translateError(err) {
  if (err && err.code === 11000) {
    const e = new DuplicateKeyError("file already uploaded to this dataset");
    e.reason = "duplicate_file";
    return e;
  }
  return err;
}

const KINDS = ["image", "video"];

class MediaAsset {
  static collection() {
    return storage.getStore().collection(COLLECTION);
  }

  // --- Reads ---------------------------------------------------------------

  static async findById(id) {
    const oid = objectIds.coerce(id);
    if (!oid) return null;
    return mediaAssetToDTO(await this.collection().findOne({ _id: oid }));
  }

  static async findRawById(id) {
    const oid = objectIds.coerce(id);
    if (!oid) return null;
    return this.collection().findOne({ _id: oid });
  }

  static async findOne(domain) {
    return mediaAssetToDTO(
      await this.collection().findOne(mediaAssetFilter(domain, objectIds)),
    );
  }

  static async findMany(domain = {}, options = {}) {
    const filter = mediaAssetFilter(domain, objectIds);
    const page = Math.max(1, options.page || 1);
    const hardMax = options.internal === true ? 10_000 : 500;
    const limit = Math.min(hardMax, Math.max(1, options.limit || 50));
    const skip = (page - 1) * limit;
    const sort = options.sortBy
      ? { [options.sortBy]: options.sortDir || 1 }
      : { createdAt: -1 };

    const [total, docs] = await Promise.all([
      this.collection().countDocuments(filter),
      this.collection().find(filter).sort(sort).skip(skip).limit(limit).toArray(),
    ]);
    return {
      assets: docs.map(mediaAssetToDTO),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  static async findAllByDataset(datasetId, options = {}) {
    const oid = objectIds.coerce(datasetId);
    if (!oid) return [];
    const filter = { datasetId: oid };
    if (options.kind) filter.kind = options.kind;
    if (options.status) filter.status = options.status;
    const docs = await this.collection().find(filter).sort({ createdAt: 1 }).toArray();
    return docs.map(mediaAssetToDTO);
  }

  static async findRawAllByDataset(datasetId) {
    const oid = objectIds.coerce(datasetId);
    if (!oid) return [];
    return this.collection().find({ datasetId: oid }).sort({ createdAt: 1 }).toArray();
  }

  static async countByStatus(datasetId) {
    const oid = objectIds.coerce(datasetId);
    if (!oid) return { total: 0, pending: 0, annotated: 0 };
    const [total, pending, annotated] = await Promise.all([
      this.collection().countDocuments({ datasetId: oid }),
      this.collection().countDocuments({ datasetId: oid, status: "pending" }),
      this.collection().countDocuments({ datasetId: oid, status: "annotated" }),
    ]);
    return { total, pending, annotated };
  }

  static async countByKind(datasetId) {
    const oid = objectIds.coerce(datasetId);
    if (!oid) return { image: 0, video: 0 };
    const [image, video] = await Promise.all([
      this.collection().countDocuments({ datasetId: oid, kind: "image" }),
      this.collection().countDocuments({ datasetId: oid, kind: "video" }),
    ]);
    return { image, video };
  }

  /**
   * Mongo resolves the byte total with a real `$sum`; the document store
   * reduces in JavaScript. Same answer, different engine.
   */
  static async sumBytes(datasetId) {
    const oid = objectIds.coerce(datasetId);
    if (!oid) return 0;
    const [row] = await this.collection()
      .aggregate([
        { $match: { datasetId: oid } },
        { $group: { _id: null, total: { $sum: "$sizeBytes" } } },
      ])
      .toArray();
    return row ? row.total || 0 : 0;
  }

  static async findManyByIds(ids) {
    const keys = (ids || []).map((v) => objectIds.coerce(v)).filter(Boolean);
    if (!keys.length) return [];
    const docs = await this.collection().find({ _id: { $in: keys } }).toArray();
    return docs.map(mediaAssetToDTO);
  }

  // --- Writes --------------------------------------------------------------

  /**
   * `dto.id` is optional. The asset service supplies one so the on-disk path
   * can be derived before the insert; Mongo honours a caller-supplied `_id`, so
   * the path and the record agree. When it is omitted the driver mints one.
   */
  static async create(dto) {
    if (!dto.datasetId) throw new ValidationError("datasetId is required");
    if (!KINDS.includes(dto.kind)) {
      throw new ValidationError(`kind must be one of: ${KINDS.join(", ")}`);
    }
    if (!dto.checksum) throw new ValidationError("checksum is required");
    const now = new Date();
    const doc = {
      datasetId: objectIds.coerce(dto.datasetId),
      kind: dto.kind,
      originalFileName: dto.originalFileName || "",
      extension: dto.extension || "",
      mimeType: dto.mimeType ?? null,
      sizeBytes: Number(dto.sizeBytes) || 0,
      checksum: dto.checksum,
      width: dto.width ?? null,
      height: dto.height ?? null,
      durationMs: dto.durationMs ?? null,
      storagePath: dto.storagePath,
      status: "pending",
      annotationCount: 0,
      assignedTo: null,
      assignedAt: null,
      assignedBy: null,
      source: dto.source || "upload",
      createdBy: objectIds.coerce(dto.createdBy),
      updatedBy: objectIds.coerce(dto.updatedBy || dto.createdBy),
      createdAt: now,
      updatedAt: now,
    };
    try {
      const r = await this.collection().insertOne(
        dto.id ? { ...doc, _id: objectIds.coerce(dto.id) } : doc,
      );
      return { id: r.insertedId.toString() };
    } catch (err) {
      throw translateError(err);
    }
  }

  static async updateById(id, patch) {
    const oid = objectIds.coerce(id);
    if (!oid) return { matchedCount: 0, modifiedCount: 0 };
    const set = { updatedAt: new Date() };
    for (const key of ["assignedTo", "assignedAt", "assignedBy", "status", "annotationCount", "originalFileName"]) {
      if (Object.prototype.hasOwnProperty.call(patch || {}, key)) {
        set[key] =
          key === "assignedTo" && patch[key]
            ? objectIds.coerce(patch[key])
            : patch[key];
      }
    }
    const r = await this.collection().updateOne({ _id: oid }, { $set: set });
    return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  static async setAnnotationState(id, count) {
    const oid = objectIds.coerce(id);
    if (!oid) return { matchedCount: 0, modifiedCount: 0 };
    const n = Math.max(0, Number(count) || 0);
    const r = await this.collection().updateOne(
      { _id: oid },
      {
        $set: {
          annotationCount: n,
          status: n > 0 ? "annotated" : "pending",
          updatedAt: new Date(),
        },
      },
    );
    return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  static async assertExists(id) {
    const found = await this.findById(id);
    if (!found) throw new NotFoundError("Media asset not found");
    return found;
  }

  static async deleteById(id) {
    const oid = objectIds.coerce(id);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteOne({ _id: oid });
    return { deletedCount: r.deletedCount };
  }

  static async deleteManyByDataset(datasetId) {
    const oid = objectIds.coerce(datasetId);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteMany({ datasetId: oid });
    return { deletedCount: r.deletedCount };
  }
}

module.exports = MediaAsset;
