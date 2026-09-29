// models/document/MediaAsset.js
// Document-store implementation of the media asset model.
//
// One asset is one image or one video. The record holds *metadata only* — the
// bytes live on disk under `config.media.root`, addressed by `storagePath`.
//
// `storagePath` never leaves the model layer: `mediaAssetToDTO` omits it, and
// the controller resolves it to a stream. That is what keeps a client from
// learning the on-disk layout and, more importantly, from building a path the
// server would then have to trust.

const storage = require("../../config/storage");
const { stringIds } = require("../shared/ids");
const { mediaAssetToDTO } = require("../shared/dto");
const { mediaAssetFilter } = require("../shared/mediaFilters");
const { DuplicateKeyError, ValidationError, NotFoundError } = require("../errors");

const COLLECTION = "media_assets";

function translateError(err) {
  if (err && err.code === 11000) {
    // The (datasetId, checksum) unique index. Surfaced distinctly because the
    // service turns it into a "this file is already in the dataset" 409, which
    // is a much more useful message than a generic duplicate.
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
    const oid = stringIds.coerce(id);
    if (!oid) return null;
    return mediaAssetToDTO(await this.collection().findOne({ _id: oid }));
  }

  /** The raw record, including `storagePath`. For the file-serving path only. */
  static async findRawById(id) {
    const oid = stringIds.coerce(id);
    if (!oid) return null;
    return this.collection().findOne({ _id: oid });
  }

  static async findOne(domain) {
    return mediaAssetToDTO(
      await this.collection().findOne(mediaAssetFilter(domain, stringIds)),
    );
  }

  static async findMany(domain = {}, options = {}) {
    const filter = mediaAssetFilter(domain, stringIds);
    const page = Math.max(1, options.page || 1);
    // 500, not 200: an image grid legitimately needs a large page, and unlike
    // comment text these rows are small. The cap still exists so a client
    // cannot request an unbounded page.
    const hardMax = options.internal === true ? 10_000 : 500;
    const limit = Math.min(hardMax, Math.max(1, options.limit || 50));
    const skip = (page - 1) * limit;
    const sort = options.sortBy ? { [options.sortBy]: options.sortDir || 1 } : { createdAt: -1 };

    const [total, docs] = await Promise.all([
      this.collection().countDocuments(filter),
      this.collection().find(filter, { sort, skip, limit }),
    ]);
    return {
      assets: docs.map(mediaAssetToDTO),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /**
   * Every asset in a dataset, unpaged. The exporters need all of them and
   * fetching in pages would make the export non-atomic: an annotation made
   * between two pages would be included for some images and not others.
   */
  static async findAllByDataset(datasetId, options = {}) {
    const oid = stringIds.coerce(datasetId);
    if (!oid) return [];
    const filter = { datasetId: oid };
    if (options.kind) filter.kind = options.kind;
    if (options.status) filter.status = options.status;
    const docs = await this.collection().find(filter, { sort: { createdAt: 1 } });
    return docs.map(mediaAssetToDTO);
  }

  static async findRawAllByDataset(datasetId) {
    const oid = stringIds.coerce(datasetId);
    if (!oid) return [];
    return this.collection().find({ datasetId: oid }, { sort: { createdAt: 1 } });
  }

  static async countByStatus(datasetId) {
    const oid = stringIds.coerce(datasetId);
    if (!oid) return { total: 0, pending: 0, annotated: 0 };
    const [total, pending, annotated] = await Promise.all([
      this.collection().countDocuments({ datasetId: oid }),
      this.collection().countDocuments({ datasetId: oid, status: "pending" }),
      this.collection().countDocuments({ datasetId: oid, status: "annotated" }),
    ]);
    return { total, pending, annotated };
  }

  static async countByKind(datasetId) {
    const oid = stringIds.coerce(datasetId);
    if (!oid) return { image: 0, video: 0 };
    const [image, video] = await Promise.all([
      this.collection().countDocuments({ datasetId: oid, kind: "image" }),
      this.collection().countDocuments({ datasetId: oid, kind: "video" }),
    ]);
    return { image, video };
  }

  static async sumBytes(datasetId) {
    const oid = stringIds.coerce(datasetId);
    if (!oid) return 0;
    const docs = await this.collection().find(
      { datasetId: oid },
      { projection: { sizeBytes: 1 } },
    );
    return docs.reduce((sum, d) => sum + (d.sizeBytes || 0), 0);
  }

  static async findManyByIds(ids) {
    const keys = (ids || []).map((v) => stringIds.coerce(v)).filter(Boolean);
    if (!keys.length) return [];
    const docs = await this.collection().find({ _id: { $in: keys } });
    return docs.map(mediaAssetToDTO);
  }

  // --- Writes --------------------------------------------------------------

  /**
   * `dto.id` is optional. The asset service supplies one so the on-disk path
   * can be derived before the insert; every provider honours a caller-supplied
   * `_id`, so the path and the record agree. When it is omitted the store
   * mints one, which is what the tests and the cascade-delete fixtures use.
   */
  static async create(dto) {
    if (!dto.datasetId) throw new ValidationError("datasetId is required");
    if (!KINDS.includes(dto.kind)) {
      throw new ValidationError(`kind must be one of: ${KINDS.join(", ")}`);
    }
    if (!dto.checksum) throw new ValidationError("checksum is required");
    const now = new Date();
    const doc = {
      datasetId: stringIds.coerce(dto.datasetId),
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
      createdBy: stringIds.coerce(dto.createdBy),
      updatedBy: stringIds.coerce(dto.updatedBy || dto.createdBy),
      createdAt: now,
      updatedAt: now,
    };
    try {
      const r = await this.collection().insertOne(
        dto.id ? { ...doc, _id: stringIds.coerce(dto.id) } : doc,
      );
      return { id: r.insertedId };
    } catch (err) {
      throw translateError(err);
    }
  }

  static async updateById(id, patch) {
    const oid = stringIds.coerce(id);
    if (!oid) return { matchedCount: 0, modifiedCount: 0 };
    const set = { updatedAt: new Date() };
    for (const key of ["assignedTo", "assignedAt", "assignedBy", "status", "annotationCount", "originalFileName"]) {
      if (Object.prototype.hasOwnProperty.call(patch || {}, key)) {
        set[key] =
          key === "assignedTo" && patch[key]
            ? stringIds.coerce(patch[key])
            : patch[key];
      }
    }
    const r = await this.collection().updateOne({ _id: oid }, { $set: set });
    return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  /**
   * Keeps `annotationCount` and the derived `status` in step.
   *
   * Both are denormalised on purpose: the dataset grid shows a per-asset
   * progress badge, and deriving it per row would mean a count query per image.
   * The caller passes the count because the annotation service is the only
   * layer that knows it has just changed.
   */
  static async setAnnotationState(id, count) {
    const oid = stringIds.coerce(id);
    if (!oid) return { matchedCount: 0, modifiedCount: 0 };
    const n = Math.max(0, Number(count) || 0);
    const r = await this.collection().updateOne(
      { _id: oid },
      {
        $set: {
          annotationCount: n,
          // A video with annotations on one frame is still partially annotated;
          // this stays "annotated" because that is the unit the exporter uses.
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
    const oid = stringIds.coerce(id);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteOne({ _id: oid });
    return { deletedCount: r.deletedCount };
  }

  static async deleteManyByDataset(datasetId) {
    const oid = stringIds.coerce(datasetId);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteMany({ datasetId: oid });
    return { deletedCount: r.deletedCount };
  }
}

module.exports = MediaAsset;
