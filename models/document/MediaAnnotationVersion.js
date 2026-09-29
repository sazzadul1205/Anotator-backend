// models/document/MediaAnnotationVersion.js
// Document-store implementation of the media annotation version model.
//
// The media equivalent of CommentVersion: an append-only history trail. Every
// create, update, delete and restore of an annotation appends one snapshot, so
// bounding boxes have the same auditability as text labels. Restoring appends
// a new revision rather than rewriting an existing row, so history cannot be
// falsified after the fact.

const storage = require("../../config/storage");
const { stringIds } = require("../shared/ids");
const { mediaAnnotationVersionToDTO } = require("../shared/dto");
const { dateKey } = require("../shared/aggregate");

const COLLECTION = "media_annotation_versions";

function toDocument(dto) {
  return {
    annotationId: stringIds.coerce(dto.annotationId),
    assetId: stringIds.coerce(dto.assetId),
    datasetId: stringIds.coerce(dto.datasetId),
    revision: Number(dto.revision) || 1,
    snapshot: dto.snapshot,
    changedFields: dto.changedFields || [],
    changeType: dto.changeType,
    restoredFrom: dto.restoredFrom ?? null,
    changedBy: stringIds.coerce(dto.changedBy),
    createdAt: dto.createdAt instanceof Date ? dto.createdAt : new Date(),
  };
}

class MediaAnnotationVersion {
  static collection() {
    return storage.getStore().collection(COLLECTION);
  }

  static async create(dto) {
    const r = await this.collection().insertOne(toDocument(dto));
    return { id: r.insertedId };
  }

  static async insertMany(dtos) {
    if (!dtos || !dtos.length) return [];
    const r = await this.collection().insertMany(dtos.map(toDocument));
    return Object.values(r.insertedIds).map((newId) => ({ id: newId }));
  }

  static async findByAnnotationId(annotationId, options = {}) {
    const oid = stringIds.coerce(annotationId);
    if (!oid) return [];
    const docs = await this.collection().find(
      { annotationId: oid },
      {
        sort: { revision: -1 },
        skip: options.skip || 0,
        limit: options.limit || undefined,
      },
    );
    return docs.map(mediaAnnotationVersionToDTO);
  }

  static async countByAnnotationId(annotationId) {
    const oid = stringIds.coerce(annotationId);
    if (!oid) return 0;
    return this.collection().countDocuments({ annotationId: oid });
  }

  static async findOne({ annotationId, revision }) {
    const oid = stringIds.coerce(annotationId);
    if (!oid) return null;
    return mediaAnnotationVersionToDTO(
      await this.collection().findOne({ annotationId: oid, revision }),
    );
  }

  /** Newest snapshot, which is what a restore falls back to. */
  static async findLatest(annotationId) {
    const oid = stringIds.coerce(annotationId);
    if (!oid) return null;
    const docs = await this.collection().find(
      { annotationId: oid },
      { sort: { revision: -1 }, limit: 1 },
    );
    return docs.length ? mediaAnnotationVersionToDTO(docs[0]) : null;
  }

  static async deleteByAssetId(assetId) {
    const oid = stringIds.coerce(assetId);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteMany({ assetId: oid });
    return { deletedCount: r.deletedCount };
  }

  static async deleteByDatasetId(datasetId) {
    const oid = stringIds.coerce(datasetId);
    if (!oid) return { deletedCount: 0 };
    const r = await this.collection().deleteMany({ datasetId: oid });
    return { deletedCount: r.deletedCount };
  }

  static async activityByDate(since) {
    const rows = await this.collection().find({ createdAt: { $gte: since } });
    return tallyByDate(rows);
  }

  static async activityByDateForDataset(datasetId) {
    const oid = stringIds.coerce(datasetId);
    if (!oid) return [];
    // No join needed: unlike comment versions, these rows carry their own
    // datasetId, so this is a direct filter rather than a lookup.
    const rows = await this.collection().find({ datasetId: oid });
    return tallyByDate(rows);
  }
}

/** Groups rows into [{ date, count }], ascending. */
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
