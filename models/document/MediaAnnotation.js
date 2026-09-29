// models/document/MediaAnnotation.js
// Document-store implementation of the media annotation model.
//
// One annotation is either a whole-image label (`classification`) or a
// rectangular region (`bbox`). Geometry is stored normalised to 0..1 by
// `utils/geometry.js` before it reaches this layer — this model persists
// validated values and does no geometry maths of its own.
//
// `datasetId` and the asset's `width`/`height` are denormalised onto every
// annotation. That is deliberate: the exporters need "every box in this
// dataset, with pixel dimensions" as one indexed query, and a join per row to
// recover three values that never change would be the single hottest query in
// the system.

const storage = require("../../config/storage");
const { stringIds } = require("../shared/ids");
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
    const oid = stringIds.coerce(id);
    if (!oid) return null;
    return mediaAnnotationToDTO(await this.collection().findOne({ _id: oid }));
  }

  static async findOne(domain) {
    return mediaAnnotationToDTO(
      await this.collection().findOne(mediaAnnotationFilter(domain, stringIds)),
    );
  }

  static async findMany(domain = {}, options = {}) {
    const filter = mediaAnnotationFilter(domain, stringIds);
    const page = Math.max(1, options.page || 1);
    // An image can carry hundreds of boxes; a dataset can carry hundreds of
    // thousands. The internal escape hatch is for the exporters, which must
    // read everything.
    const hardMax = options.internal === true ? 200_000 : 1000;
    const limit = Math.min(hardMax, Math.max(1, options.limit || 200));
    const skip = (page - 1) * limit;
    const sort = options.sortBy ? { [options.sortBy]: options.sortDir || 1 } : { createdAt: 1 };

    const [total, docs] = await Promise.all([
      this.collection().countDocuments(filter),
      this.collection().find(filter, { sort, skip, limit }),
    ]);
    return {
      annotations: docs.map(mediaAnnotationToDTO),
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  /** Unpaged read for the exporters. See MediaAsset.findAllByDataset. */
  static async findAllByDataset(datasetId, options = {}) {
    const oid = stringIds.coerce(datasetId);
    if (!oid) return [];
    const filter = { datasetId: oid };
    if (options.kind) filter.kind = options.kind;
    if (options.label) filter.label = options.label;
    const docs = await this.collection().find(filter, { sort: { createdAt: 1 } });
    return docs.map(mediaAnnotationToDTO);
  }

  static async findAllByAsset(assetId) {
    const oid = stringIds.coerce(assetId);
    if (!oid) return [];
    const docs = await this.collection().find(
      { assetId: oid },
      { sort: { createdAt: 1 } },
    );
    return docs.map(mediaAnnotationToDTO);
  }

  static async countByAsset(assetId) {
    const oid = stringIds.coerce(assetId);
    if (!oid) return 0;
    return this.collection().countDocuments({ assetId: oid });
  }

  static async countByDataset(datasetId) {
    const oid = stringIds.coerce(datasetId);
    if (!oid) return 0;
    return this.collection().countDocuments({ datasetId: oid });
  }

  /** Distinct label values in a dataset — the class vocabulary actually used. */
  static async distinctLabels(datasetId) {
    const oid = stringIds.coerce(datasetId);
    if (!oid) return [];
    return this.collection().distinct("label", { datasetId: oid });
  }

  /**
   * Label histogram for the dataset's class-balance panel. Computed in
   * JavaScript rather than with a `$group` because the shared store API has no
   * aggregation, and this is the same shape the text analytics already return.
   */
  static async labelHistogram(datasetId) {
    const docs = await this.findAllByDataset(datasetId, { kind: "bbox" });
    const counts = new Map();
    for (const a of docs) {
      counts.set(a.label, (counts.get(a.label) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, count]) => ({ label, count }))
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
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
      // A box with no coordinates would export as a zero-area region, which
      // most trainers silently drop. Refuse it at the boundary instead.
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
      assetId: stringIds.coerce(dto.assetId),
      datasetId: stringIds.coerce(dto.datasetId),
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
      createdBy: stringIds.coerce(dto.createdBy),
      updatedBy: stringIds.coerce(dto.updatedBy || dto.createdBy),
      createdAt: now,
      updatedAt: now,
    };
    const r = await this.collection().insertOne(doc);
    return { id: r.insertedId };
  }

  /**
   * Applies a patch and bumps `revision`. The caller is responsible for having
   * already validated and normalised any geometry — this layer persists.
   */
  static async updateById(id, patch, { bumpRevision = true } = {}) {
    const oid = stringIds.coerce(id);
    if (!oid) return { matchedCount: 0, modifiedCount: 0 };
    const set = { updatedAt: new Date() };
    for (const key of ["label", "note", "frameIndex", "timestampMs"]) {
      if (Object.prototype.hasOwnProperty.call(patch || {}, key)) {
        set[key] = patch[key];
      }
    }
    // Geometry is only written when a box is supplied, so a label-only edit
    // cannot accidentally zero the coordinates.
    if (patch && patch.box) {
      set.x = patch.box.x;
      set.y = patch.box.y;
      set.boxWidth = patch.box.width;
      set.boxHeight = patch.box.height;
    }

    // `$inc` is a sibling of `$set`, not a value inside it. Bumping through
    // `$inc` (rather than read-modify-write) keeps concurrent edits from
    // both writing revision N+1 and silently losing one increment.
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
    const oid = stringIds.coerce(id);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteOne({ _id: oid });
    return { deletedCount: r.deletedCount };
  }

  static async deleteManyByAsset(assetId) {
    const oid = stringIds.coerce(assetId);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteMany({ assetId: oid });
    return { deletedCount: r.deletedCount };
  }

  static async deleteManyByDataset(datasetId) {
    const oid = stringIds.coerce(datasetId);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteMany({ datasetId: oid });
    return { deletedCount: r.deletedCount };
  }

  /** Restores a deleted annotation from a version snapshot. */
  static async restoreFromSnapshot(snapshot) {
    return this.create({
      ...snapshot,
      createdBy: snapshot.createdBy,
    });
  }
}

module.exports = MediaAnnotation;
