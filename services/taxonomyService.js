// services/taxonomyService.js
// Manage taxonomies and their assignment to datasets.

const { Taxonomy, Dataset } = require("../models");
const { audit } = require("../utils/audit");

const DEFAULT_SENTIMENTS = ["positive", "negative", "neutral", "unannotated"];
const DEFAULT_TYPES = ["bangla", "english", "banglish", "unclassified"];

// ---------------------------------------------------------------------------
// Pure validation / normalization helpers
// ---------------------------------------------------------------------------

function slugify(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

function normalizeList(arr, field) {
  if (!Array.isArray(arr) || arr.length === 0) {
    return { error: `${field} must be a non-empty array` };
  }
  if (arr.length > 50) {
    return { error: `${field} cannot have more than 50 items` };
  }

  const seen = new Set();
  const items = [];
  for (let i = 0; i < arr.length; i++) {
    const raw = arr[i];
    if (!raw || typeof raw !== "object") {
      return { error: `${field}[${i}] must be an object` };
    }
    const label =
      typeof raw.label === "string" && raw.label.trim()
        ? raw.label.trim().slice(0, 60)
        : null;
    if (!label) return { error: `${field}[${i}].label is required` };

    const value = raw.value ? slugify(raw.value) : slugify(label);
    if (!value) {
      return {
        error: `${field}[${i}].value could not be derived from label "${label}"`,
      };
    }
    if (seen.has(value)) {
      return { error: `${field} has duplicate value "${value}"` };
    }
    seen.add(value);

    const order =
      typeof raw.order === "number" && Number.isFinite(raw.order)
        ? raw.order
        : i;

    items.push({ value, label, order });
  }

  items.sort((a, b) => a.order - b.order);
  return { items };
}

function validateAndNormalize(sentiment, type) {
  const sRes = normalizeList(sentiment, "sentiment");
  if (sRes.error) return sRes;
  const tRes = normalizeList(type, "type");
  if (tRes.error) return tRes;

  if (!sRes.items.some((i) => i.value === "unannotated")) {
    sRes.items.push({ value: "unannotated", label: "Unannotated", order: 999 });
  }
  if (!tRes.items.some((i) => i.value === "unclassified")) {
    tRes.items.push({
      value: "unclassified",
      label: "Unclassified",
      order: 999,
    });
  }

  return { sentiment: sRes.items, type: tRes.items };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

async function listTaxonomies(query, user) {
  const filter = {};
  if (query.kind) {
    if (!["sentiment", "type"].includes(query.kind)) {
      const err = new Error("kind must be sentiment or type");
      err.status = 400;
      throw err;
    }
    filter.kind = query.kind;
  }
  if (user.role !== "admin") filter.isActive = true;
  else if (query.isActive !== undefined)
    filter.isActive = query.isActive === "true";

  return Taxonomy.findMany(filter);
}

async function getDefaults() {
  return {
    sentiment: DEFAULT_SENTIMENTS,
    type: DEFAULT_TYPES,
  };
}

async function getForDataset(datasetId, user) {
  const dataset = await Dataset.findById(datasetId);
  if (!dataset) {
    const err = new Error("Dataset not found");
    err.status = 404;
    throw err;
  }
  if (user.role !== "admin" && dataset.assignedTo !== user.userId) {
    const err = new Error("Not assigned to you");
    err.status = 403;
    throw err;
  }

  let taxonomy = null;
  if (dataset.taxonomyId) {
    taxonomy = await Taxonomy.findById(dataset.taxonomyId);
  }

  const sentiment = taxonomy
    ? taxonomy.sentiment
    : DEFAULT_SENTIMENTS.map((label, i) => ({ value: label, label, order: i }));
  const type = taxonomy
    ? taxonomy.type
    : DEFAULT_TYPES.map((label, i) => ({ value: label, label, order: i }));

  return {
    datasetId: dataset.id,
    taxonomyId: dataset.taxonomyId || null,
    taxonomyName: taxonomy ? taxonomy.name : "Default",
    sentiment,
    type,
  };
}

async function createTaxonomy(
  { name, description = "", sentiment, type },
  actor,
) {
  if (!name || typeof name !== "string" || !name.trim()) {
    const err = new Error("name is required");
    err.status = 400;
    throw err;
  }
  if (name.trim().length > 120) {
    const err = new Error("name must be ≤ 120 chars");
    err.status = 400;
    throw err;
  }

  const result = validateAndNormalize(sentiment, type);
  if (result.error) {
    const err = new Error(result.error);
    err.status = 400;
    throw err;
  }

  const { id: taxonomyId } = await Taxonomy.create({
    name: name.trim(),
    description: String(description).trim().slice(0, 500),
    sentiment: result.sentiment,
    type: result.type,
    isActive: true,
    createdBy: actor.userId,
    updatedBy: actor.userId,
  });

  await audit({
    action: "taxonomy.create",
    actor,
    targetType: "taxonomy",
    targetId: taxonomyId,
    metadata: { name: name.trim() },
  });

  return { taxonomyId, message: "Taxonomy created" };
}

async function getTaxonomy(id, user) {
  const taxonomy = await Taxonomy.findById(id);
  if (!taxonomy) {
    const err = new Error("Taxonomy not found");
    err.status = 404;
    throw err;
  }
  if (user.role !== "admin" && !taxonomy.isActive) {
    const err = new Error("Taxonomy is inactive");
    err.status = 403;
    throw err;
  }
  return taxonomy;
}

async function updateTaxonomy(id, body, actor) {
  const taxonomy = await Taxonomy.findById(id);
  if (!taxonomy) {
    const err = new Error("Taxonomy not found");
    err.status = 404;
    throw err;
  }

  const updates = { updatedBy: actor.userId };

  if (body.name !== undefined) {
    if (typeof body.name !== "string" || !body.name.trim()) {
      const err = new Error("name cannot be empty");
      err.status = 400;
      throw err;
    }
    updates.name = body.name.trim().slice(0, 120);
  }
  if (body.description !== undefined) {
    updates.description = String(body.description).trim().slice(0, 500);
  }
  if (body.isActive !== undefined) updates.isActive = !!body.isActive;

  if (body.sentiment !== undefined || body.type !== undefined) {
    const nextSentiment =
      body.sentiment !== undefined ? body.sentiment : taxonomy.sentiment;
    const nextType = body.type !== undefined ? body.type : taxonomy.type;
    const result = validateAndNormalize(nextSentiment, nextType);
    if (result.error) {
      const err = new Error(result.error);
      err.status = 400;
      throw err;
    }
    updates.sentiment = result.sentiment;
    updates.type = result.type;
  }

  await Taxonomy.updateById(id, updates);

  await audit({
    action: "taxonomy.update",
    actor,
    targetType: "taxonomy",
    targetId: id,
    metadata: { fields: Object.keys(updates) },
  });

  return { message: "Taxonomy updated" };
}

async function deleteTaxonomy(id, hard, actor) {
  const taxonomy = await Taxonomy.findById(id);
  if (!taxonomy) {
    const err = new Error("Taxonomy not found");
    err.status = 404;
    throw err;
  }

  if (hard) {
    const datasetsUsing = await Taxonomy.countDatasetsUsing(id);
    if (datasetsUsing > 0) {
      const err = new Error(
        `Taxonomy is used by ${datasetsUsing} dataset(s). Unassign first or use soft-delete.`,
      );
      err.status = 400;
      throw err;
    }
    await Taxonomy.deleteById(id);
  } else {
    await Taxonomy.deactivate(id, actor.userId);
  }

  await audit({
    action: hard ? "taxonomy.delete" : "taxonomy.deactivate",
    actor,
    targetType: "taxonomy",
    targetId: id,
    metadata: { name: taxonomy.name },
  });

  return {
    message: hard ? "Taxonomy deleted" : "Taxonomy deactivated",
  };
}

async function assignToDataset(taxonomyId, datasetId, actor) {
  const [taxonomy, dataset] = await Promise.all([
    Taxonomy.findById(taxonomyId),
    Dataset.findById(datasetId),
  ]);

  if (!taxonomy) {
    const err = new Error("Taxonomy not found");
    err.status = 404;
    throw err;
  }
  if (!dataset) {
    const err = new Error("Dataset not found");
    err.status = 404;
    throw err;
  }
  if (!taxonomy.isActive) {
    const err = new Error("Taxonomy is inactive");
    err.status = 400;
    throw err;
  }

  await Dataset.updateById(datasetId, {
    taxonomyId: taxonomy.id,
    taxonomyName: taxonomy.name,
    taxonomyAssignedAt: new Date(),
  });

  await audit({
    action: "taxonomy.assign_to_dataset",
    actor,
    targetType: "dataset",
    targetId: datasetId,
    metadata: { taxonomyId, name: taxonomy.name },
  });

  return { message: "Taxonomy assigned to dataset" };
}

async function unassignFromDataset(taxonomyId, datasetId, actor) {
  const dataset = await Dataset.findById(datasetId);
  if (!dataset) {
    const err = new Error("Dataset not found");
    err.status = 404;
    throw err;
  }
  if (!dataset.taxonomyId || dataset.taxonomyId !== taxonomyId) {
    const err = new Error("Dataset is not using this taxonomy");
    err.status = 400;
    throw err;
  }

  await Dataset.clearTaxonomy(datasetId);

  await audit({
    action: "taxonomy.unassign_from_dataset",
    actor,
    targetType: "dataset",
    targetId: datasetId,
    metadata: { taxonomyId },
  });

  return { message: "Taxonomy unassigned from dataset" };
}

module.exports = {
  DEFAULT_SENTIMENTS,
  DEFAULT_TYPES,
  slugify,
  validateAndNormalize,
  listTaxonomies,
  getDefaults,
  getForDataset,
  createTaxonomy,
  getTaxonomy,
  updateTaxonomy,
  deleteTaxonomy,
  assignToDataset,
  unassignFromDataset,
};
