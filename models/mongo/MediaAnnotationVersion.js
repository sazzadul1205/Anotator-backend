// models/mongo/MediaAnnotationVersion.js
// MongoDB implementation of the media annotation version model.
//
// Method-for-method identical to models/document/MediaAnnotationVersion.js.

const storage = require("../../config/storage");
const { objectIds } = require("./oid");
const { mediaAnnotationVersionToDTO } = require("../shared/dto");
const { dateKey } = require("../shared/aggregate");

const COLLECTION = "media_annotation_versions";

function toDocument(dto) {
  return {
    annotationId: objectIds.coerce(dto.annotationId),
    assetId: objectIds.coerce(dto.assetId),
    datasetId: objectIds.coerce(dto.datasetId),
    revision: Number(dto.revision) || 1,
    snapshot: dto.snapshot,
    changedFields: dto.changedFields || [],
    changeType: dto.changeType,
    restoredFrom: dto.restoredFrom ?? null,
    changedBy: objectIds.coerce(dto.changedBy),
    createdAt: dto.createdAt instanceof Date ? dto.createdAt : new Date(),
  };
}

class MediaAnnotationVersion {
  static collection() {
    return storage.getStore().collection(COLLECTION);
  }

  static async create(dto) {
    const r = await this.collection().insertOne(toDocument(dto));
    return { id: r.insertedId.toString() };
  }

  static async insertMany(dtos) {
    if (!dtos || !dtos.length) return [];
    const r = await this.collection().insertMany(dtos.map(toDocument));
    return Object.values(r.insertedIds).map((oid) => ({ id: oid.toString() }));
  }

  static async findByAnnotationId(annotationId, options = {}) {
    const oid = objectIds.coerce(annotationId);
    if (!oid) return [];
    let cursor = this.collection()
      .find({ annotationId: oid })
      .sort({ revision: -1 });
    if (options.skip) cursor = cursor.skip(options.skip);
    if (options.limit) cursor = cursor.limit(options.limit);
    const docs = await cursor.toArray();
    return docs.map(mediaAnnotationVersionToDTO);
  }

  static async countByAnnotationId(annotationId) {
    const oid = objectIds.coerce(annotationId);
    if (!oid) return 0;
    return this.collection().countDocuments({ annotationId: oid });
  }

  static async findOne({ annotationId, revision }) {
    const oid = objectIds.coerce(annotationId);
    if (!oid) return null;
    return mediaAnnotationVersionToDTO(
      await this.collection().findOne({ annotationId: oid, revision }),
    );
  }

  static async findLatest(annotationId) {
    const oid = objectIds.coerce(annotationId);
    if (!oid) return null;
    const docs = await this.collection()
      .find({ annotationId: oid })
      .sort({ revision: -1 })
      .limit(1)
      .toArray();
    return docs.length ? mediaAnnotationVersionToDTO(docs[0]) : null;
  }

  static async deleteByAssetId(assetId) {
    const oid = objectIds.coerce(assetId);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteMany({ assetId: oid });
    return { deletedCount: r.deletedCount };
  }

  static async deleteByDatasetId(datasetId) {
    const oid = objectIds.coerce(datasetId);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteMany({ datasetId: oid });
    return { deletedCount: r.deletedCount };
  }

  static async activityByDate(since) {
    const rows = await this.collection().find({ createdAt: { $gte: since } }).toArray();
    return tallyByDate(rows);
  }

  static async activityByDateForDataset(datasetId) {
    const oid = objectIds.coerce(datasetId);
    if (!oid) return [];
    const rows = await this.collection().find({ datasetId: oid }).toArray();
    return tallyByDate(rows);
  }
}

function tallyByDate(rows) {
  const counts = new Map();
  for (const row of rows) {
    const key = dateKey(row.createdAt);
    if (key === null) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([date, count]) => ({ date, count }));
}

module.exports = MediaAnnotationVersion;
