// models/mongo/MediaAnnotation.js
// MongoDB implementation of the media annotation model.
//
// Method-for-method identical to models/document/MediaAnnotation.js. The
// histogram uses a real `$group` here, where the document store counts in
// JavaScript; both must return the same shape and the same ordering, because
// the parity suite compares them directly.

const storage = require("../../config/storage");
const { objectIds } = require("./oid");
const { mediaAnnotationToDTO } = require("../shared/dto");
const { mediaAnnotationFilter } = require("../shared/mediaFilters");
const { ValidationError, NotFoundError } = require("../errors");

const COLLECTION = "media_annotations";

const KINDS = ["bbox", "classification"];

class MediaAnnotation {
  static collection() {
    return storage.getStore().collection(COLLECTION);
  }

  // --- Reads ---------------------------------------------------------------

  static async findById(id) {
    const oid = objectIds.coerce(id);
    if (!oid) return null;
    return mediaAnnotationToDTO(await this.collection().findOne({ _id: oid }));
  }

  static async findOne(domain) {
    return mediaAnnotationToDTO(
      await this.collection().findOne(mediaAnnotationFilter(domain, objectIds)),
    );
  }

  static async findMany(domain = {}, options = {}) {
    const filter = mediaAnnotationFilter(domain, objectIds);
    const page = Math.max(1, options.page || 1);
    const hardMax = options.internal === true ? 200_000 : 1000;
    const limit = Math.min(hardMax, Math.max(1, options.limit || 200));
    const skip = (page - 1) * limit;
    const sort = options.sortBy
      ? { [options.sortBy]: options.sortDir || 1 }
      : { createdAt: 1 };

    const [total, docs] = await Promise.all([
      this.collection().countDocuments(filter),
      this.collection().find(filter).sort(sort).skip(skip).limit(limit).toArray(),
    ]);
    return {
      annotations: docs.map(mediaAnnotationToDTO),
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
    if (options.label) filter.label = options.label;
    const docs = await this.collection().find(filter).sort({ createdAt: 1 }).toArray();
    return docs.map(mediaAnnotationToDTO);
  }

  static async findAllByAsset(assetId) {
    const oid = objectIds.coerce(assetId);
    if (!oid) return [];
    const docs = await this.collection()
      .find({ assetId: oid })
      .sort({ createdAt: 1 })
      .toArray();
    return docs.map(mediaAnnotationToDTO);
  }

  static async countByAsset(assetId) {
    const oid = objectIds.coerce(assetId);
    if (!oid) return 0;
    return this.collection().countDocuments({ assetId: oid });
  }

  static async countByDataset(datasetId) {
    const oid = objectIds.coerce(datasetId);
    if (!oid) return 0;
    return this.collection().countDocuments({ datasetId: oid });
  }

  static async distinctLabels(datasetId) {
    const oid = objectIds.coerce(datasetId);
    if (!oid) return [];
    return this.collection().distinct("label", { datasetId: oid });
  }

  static async labelHistogram(datasetId) {
    const oid = objectIds.coerce(datasetId);
    if (!oid) return [];
    const rows = await this.collection()
      .aggregate([
        { $match: { datasetId: oid, kind: "bbox" } },
        { $group: { _id: "$label", count: { $sum: 1 } } },
        // The tiebreaker on _id is what makes this ordering deterministic. The
        // document store sorts on the label text for the same reason; without
        // it, two providers would legitimately disagree on tied counts.
        { $sort: { count: -1, _id: 1 } },
        { $project: { _id: 0, label: "$_id", count: 1 } },
      ])
      .toArray();
    // Re-shape rather than returning the aggregate output directly: BSON gives
    // the projected fields back in its own order, so the same histogram would
    // serialise as {"count":..,"label":..} here and {"label":..,"count":..} on
    // the document providers. The values are identical, but a response whose
    // key order changes with DATA_PROVIDER is a portability bug for anything
    // doing a structural comparison.
    return rows.map((r) => ({ label: r.label, count: r.count }));
  }

  // --- Writes --------------------------------------------------------------

  static async create(dto) {
    if (!dto.assetId) throw new ValidationError("assetId is required");
    if (!dto.datasetId) throw new ValidationError("datasetId is required");
    if (!KINDS.includes(dto.kind)) {
      throw new ValidationError(`kind must be one of: ${KINDS.join(", ")}`);
    }
    if (!dto.label) throw new ValidationError("label is required");

    const isBox = dto.kind === "bbox";
    if (isBox) {
      const nums = [dto.x, dto.y, dto.boxWidth, dto.boxHeight];
      if (nums.some((n) => typeof n !== "number" || !Number.isFinite(n))) {
        throw new ValidationError(
          "A bbox requires numeric x, y, boxWidth and boxHeight",
        );
      }
      if (dto.boxWidth <= 0 || dto.boxHeight <= 0) {
        throw new ValidationError("A bbox must have positive width and height");
      }
    }

    const now = new Date();
    const doc = {
      assetId: objectIds.coerce(dto.assetId),
      datasetId: objectIds.coerce(dto.datasetId),
      kind: dto.kind,
      label: dto.label,
      x: isBox ? dto.x : null,
      y: isBox ? dto.y : null,
      boxWidth: isBox ? dto.boxWidth : null,
      boxHeight: isBox ? dto.boxHeight : null,
      frameIndex: dto.frameIndex ?? null,
      timestampMs: dto.timestampMs ?? null,
      width: dto.width ?? null,
      height: dto.height ?? null,
      note: dto.note ?? null,
      revision: 1,
      createdBy: objectIds.coerce(dto.createdBy),
      updatedBy: objectIds.coerce(dto.updatedBy || dto.createdBy),
      createdAt: now,
      updatedAt: now,
    };
    const r = await this.collection().insertOne(doc);
    return { id: r.insertedId.toString() };
  }

  static async updateById(id, patch, { bumpRevision = true } = {}) {
    const oid = objectIds.coerce(id);
    if (!oid) return { matchedCount: 0, modifiedCount: 0 };
    const set = { updatedAt: new Date() };
    for (const key of ["label", "note", "frameIndex", "timestampMs"]) {
      if (Object.prototype.hasOwnProperty.call(patch || {}, key)) {
        set[key] = patch[key];
      }
    }
    if (patch && patch.box) {
      set.x = patch.box.x;
      set.y = patch.box.y;
      set.boxWidth = patch.box.width;
      set.boxHeight = patch.box.height;
    }
    const update = { $set: set };
    if (bumpRevision) update.$inc = { revision: 1 };
    const r = await this.collection().updateOne({ _id: oid }, update);
    return { matchedCount: r.matchedCount, modifiedCount: r.modifiedCount };
  }

  static async assertExists(id) {
    const found = await this.findById(id);
    if (!found) throw new NotFoundError("Annotation not found");
    return found;
  }

  static async deleteById(id) {
    const oid = objectIds.coerce(id);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteOne({ _id: oid });
    return { deletedCount: r.deletedCount };
  }

  static async deleteManyByAsset(assetId) {
    const oid = objectIds.coerce(assetId);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteMany({ assetId: oid });
    return { deletedCount: r.deletedCount };
  }

  static async deleteManyByDataset(datasetId) {
    const oid = objectIds.coerce(datasetId);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteMany({ datasetId: oid });
    return { deletedCount: r.deletedCount };
  }

  static async restoreFromSnapshot(snapshot) {
    return this.create({ ...snapshot, createdBy: snapshot.createdBy });
  }
}

module.exports = MediaAnnotation;
