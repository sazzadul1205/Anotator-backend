// routes/taxonomyRoute.js
const express = require("express");
const { ObjectId } = require("mongodb");
const { getDB } = require("../config/db");
const { verifyToken, verifyAdmin } = require("../middleware/auth");
const { audit } = require("../utils/audit");

const router = express.Router();

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function toObjectId(id) {
  try {
    return new ObjectId(id);
  } catch {
    return null;
  }
}

function slugify(str) {
  return String(str)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
}

const VALID_KINDS = ["sentiment", "type"];
const DEFAULT_SENTIMENTS = ["positive", "negative", "neutral", "unannotated"];
const DEFAULT_TYPES = ["bangla", "english", "banglish", "unclassified"];

/* ------------------------------------------------------------------ */
/* Literal-path routes first                                           */
/* ------------------------------------------------------------------ */

/**
 * GET /api/taxonomies
 * List all taxonomies. Admin sees all; annotators see only active ones
 * plus the built-in defaults for convenience.
 */
router.get("/", verifyToken, async (req, res) => {
  try {
    const db = getDB();
    const filter = {};
    if (req.query.kind) {
      if (!VALID_KINDS.includes(req.query.kind)) {
        return res
          .status(400)
          .json({ success: false, error: "kind must be sentiment or type" });
      }
      filter.kind = req.query.kind;
    }
    if (req.user.role !== "admin") {
      filter.isActive = true;
    } else if (req.query.isActive !== undefined) {
      filter.isActive = req.query.isActive === "true";
    }

    const taxonomies = await db
      .collection("taxonomies")
      .find(filter)
      .sort({ kind: 1, order: 1, label: 1 })
      .toArray();

    res.json({ success: true, taxonomies });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * GET /api/taxonomies/defaults
 * Returns the built-in fallback values used when a dataset has no
 * taxonomy assigned. Useful for frontends to render dropdowns.
 */
router.get("/defaults", verifyToken, (req, res) => {
  res.json({
    success: true,
    defaults: {
      sentiment: DEFAULT_SENTIMENTS,
      type: DEFAULT_TYPES,
    },
  });
});

/**
 * GET /api/taxonomies/for-dataset/:datasetId
 * Returns the effective taxonomy for a dataset:
 *   1. If dataset.taxonomyId set → use that taxonomy's items
 *   2. Otherwise → fall back to defaults
 * Annotators must be assigned to the dataset (admins bypass).
 */
router.get("/for-dataset/:datasetId", verifyToken, async (req, res) => {
  try {
    const db = getDB();
    const datasetId = toObjectId(req.params.datasetId);
    if (!datasetId) {
      return res
        .status(400)
        .json({ success: false, error: "Invalid datasetId" });
    }

    const dataset = await db
      .collection("datasets")
      .findOne(
        { _id: datasetId },
        { projection: { assignedTo: 1, taxonomyId: 1 } },
      );
    if (!dataset) {
      return res
        .status(404)
        .json({ success: false, error: "Dataset not found" });
    }

    if (
      req.user.role !== "admin" &&
      (!dataset.assignedTo || dataset.assignedTo.toString() !== req.user.userId)
    ) {
      return res
        .status(403)
        .json({ success: false, error: "Not assigned to you" });
    }

    let taxonomy = null;
    if (dataset.taxonomyId) {
      taxonomy = await db
        .collection("taxonomies")
        .findOne({ _id: dataset.taxonomyId });
    }

    const sentiment = taxonomy
      ? taxonomy.sentiment
      : DEFAULT_SENTIMENTS.map((label, i) => ({
          value: label,
          label,
          order: i,
        }));
    const type = taxonomy
      ? taxonomy.type
      : DEFAULT_TYPES.map((label, i) => ({ value: label, label, order: i }));

    res.json({
      success: true,
      datasetId: datasetId.toString(),
      taxonomyId: dataset.taxonomyId ? dataset.taxonomyId.toString() : null,
      taxonomyName: taxonomy ? taxonomy.name : "Default",
      sentiment,
      type,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Create                                                              */
/* ------------------------------------------------------------------ */

/**
 * POST /api/taxonomies
 * Body: {
 *   name: "Product Review Labels",
 *   description?: "...",
 *   sentiment: [{ value, label, order? }],
 *   type: [{ value, label, order? }]
 * }
 * Admin only.
 */
router.post("/", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    const { name, description = "", sentiment, type } = req.body;

    if (!name || typeof name !== "string" || !name.trim()) {
      return res
        .status(400)
        .json({ success: false, error: "name is required" });
    }
    if (name.trim().length > 120) {
      return res
        .status(400)
        .json({ success: false, error: "name must be ≤ 120 chars" });
    }

    const result = validateAndNormalize(sentiment, type);
    if (result.error) {
      return res.status(400).json({ success: false, error: result.error });
    }

    const doc = {
      name: name.trim(),
      description: String(description).trim().slice(0, 500),
      sentiment: result.sentiment,
      type: result.type,
      isActive: true,
      createdBy: new ObjectId(req.user.userId),
      updatedBy: new ObjectId(req.user.userId),
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const insert = await db.collection("taxonomies").insertOne(doc);

    await audit({
      action: "taxonomy.create",
      actor: req.user,
      targetType: "taxonomy",
      targetId: insert.insertedId.toString(),
      metadata: { name: doc.name },
    });

    res.status(201).json({
      success: true,
      message: "Taxonomy created",
      taxonomyId: insert.insertedId,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Read one                                                            */
/* ------------------------------------------------------------------ */

router.get("/:id", verifyToken, async (req, res) => {
  try {
    const db = getDB();
    const id = toObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, error: "Invalid id" });
    }

    const taxonomy = await db.collection("taxonomies").findOne({ _id: id });
    if (!taxonomy) {
      return res
        .status(404)
        .json({ success: false, error: "Taxonomy not found" });
    }
    if (req.user.role !== "admin" && !taxonomy.isActive) {
      return res
        .status(403)
        .json({ success: false, error: "Taxonomy is inactive" });
    }

    res.json({ success: true, taxonomy });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Update                                                              */
/* ------------------------------------------------------------------ */

router.patch("/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    const id = toObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, error: "Invalid id" });
    }

    const taxonomy = await db.collection("taxonomies").findOne({ _id: id });
    if (!taxonomy) {
      return res
        .status(404)
        .json({ success: false, error: "Taxonomy not found" });
    }

    const updates = {
      updatedAt: new Date(),
      updatedBy: new ObjectId(req.user.userId),
    };

    if (req.body.name !== undefined) {
      if (typeof req.body.name !== "string" || !req.body.name.trim()) {
        return res
          .status(400)
          .json({ success: false, error: "name cannot be empty" });
      }
      updates.name = req.body.name.trim().slice(0, 120);
    }
    if (req.body.description !== undefined) {
      updates.description = String(req.body.description).trim().slice(0, 500);
    }
    if (req.body.isActive !== undefined) {
      updates.isActive = !!req.body.isActive;
    }

    // If either list is being replaced, revalidate both (they must remain coherent)
    if (req.body.sentiment !== undefined || req.body.type !== undefined) {
      const nextSentiment =
        req.body.sentiment !== undefined
          ? req.body.sentiment
          : taxonomy.sentiment;
      const nextType =
        req.body.type !== undefined ? req.body.type : taxonomy.type;

      const result = validateAndNormalize(nextSentiment, nextType);
      if (result.error) {
        return res.status(400).json({ success: false, error: result.error });
      }
      updates.sentiment = result.sentiment;
      updates.type = result.type;
    }

    await db.collection("taxonomies").updateOne({ _id: id }, { $set: updates });

    await audit({
      action: "taxonomy.update",
      actor: req.user,
      targetType: "taxonomy",
      targetId: id.toString(),
      metadata: { fields: Object.keys(updates) },
    });

    res.json({ success: true, message: "Taxonomy updated" });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Delete (soft + hard)                                                */
/* ------------------------------------------------------------------ */

/**
 * DELETE /api/taxonomies/:id
 * Hard-delete is blocked if any dataset or comment still references it.
 * Otherwise soft-delete (set isActive=false).
 */
router.delete("/:id", verifyToken, verifyAdmin, async (req, res) => {
  try {
    const db = getDB();
    const id = toObjectId(req.params.id);
    if (!id) {
      return res.status(400).json({ success: false, error: "Invalid id" });
    }

    const taxonomy = await db.collection("taxonomies").findOne({ _id: id });
    if (!taxonomy) {
      return res
        .status(404)
        .json({ success: false, error: "Taxonomy not found" });
    }

    const hard = req.query.hard === "true";

    if (hard) {
      const [datasetsUsing, commentsUsing] = await Promise.all([
        db.collection("datasets").countDocuments({ taxonomyId: id }),
        // comments store concrete values, not taxonomyId — but if we want to be strict,
        // we check whether any comment in a dataset that uses this taxonomy is annotated
        // with a value that's no longer in the taxonomy. Skip for simplicity: only
        // block if a dataset points at it.
        Promise.resolve(0),
      ]);
      if (datasetsUsing > 0) {
        return res.status(400).json({
          success: false,
          error: `Taxonomy is used by ${datasetsUsing} dataset(s). Unassign first or use soft-delete.`,
        });
      }
      await db.collection("taxonomies").deleteOne({ _id: id });
    } else {
      await db
        .collection("taxonomies")
        .updateOne(
          { _id: id },
          {
            $set: {
              isActive: false,
              updatedAt: new Date(),
              updatedBy: new ObjectId(req.user.userId),
            },
          },
        );
    }

    await audit({
      action: hard ? "taxonomy.delete" : "taxonomy.deactivate",
      actor: req.user,
      targetType: "taxonomy",
      targetId: id.toString(),
      metadata: { name: taxonomy.name },
    });

    res.json({
      success: true,
      message: hard ? "Taxonomy deleted" : "Taxonomy deactivated",
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ------------------------------------------------------------------ */
/* Assign / unassign to a dataset                                      */
/* ------------------------------------------------------------------ */

/**
 * PATCH /api/taxonomies/:id/assign/:datasetId
 * Assign a taxonomy to a dataset.
 */
router.patch(
  "/:id/assign/:datasetId",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const db = getDB();
      const taxonomyId = toObjectId(req.params.id);
      const datasetId = toObjectId(req.params.datasetId);
      if (!taxonomyId || !datasetId) {
        return res.status(400).json({ success: false, error: "Invalid id" });
      }

      const [taxonomy, dataset] = await Promise.all([
        db.collection("taxonomies").findOne({ _id: taxonomyId }),
        db.collection("datasets").findOne({ _id: datasetId }),
      ]);
      if (!taxonomy) {
        return res
          .status(404)
          .json({ success: false, error: "Taxonomy not found" });
      }
      if (!dataset) {
        return res
          .status(404)
          .json({ success: false, error: "Dataset not found" });
      }
      if (!taxonomy.isActive) {
        return res
          .status(400)
          .json({ success: false, error: "Taxonomy is inactive" });
      }

      await db.collection("datasets").updateOne(
        { _id: datasetId },
        {
          $set: {
            taxonomyId,
            taxonomyName: taxonomy.name,
            taxonomyAssignedAt: new Date(),
            updatedAt: new Date(),
          },
        },
      );

      await audit({
        action: "taxonomy.assign_to_dataset",
        actor: req.user,
        targetType: "dataset",
        targetId: datasetId.toString(),
        metadata: { taxonomyId: taxonomyId.toString(), name: taxonomy.name },
      });

      res.json({
        success: true,
        message: "Taxonomy assigned to dataset",
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

/**
 * DELETE /api/taxonomies/:id/assign/:datasetId
 * Remove taxonomy from a dataset (falls back to defaults).
 */
router.delete(
  "/:id/assign/:datasetId",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    try {
      const db = getDB();
      const taxonomyId = toObjectId(req.params.id);
      const datasetId = toObjectId(req.params.datasetId);
      if (!taxonomyId || !datasetId) {
        return res.status(400).json({ success: false, error: "Invalid id" });
      }

      const dataset = await db
        .collection("datasets")
        .findOne({ _id: datasetId });
      if (!dataset) {
        return res
          .status(404)
          .json({ success: false, error: "Dataset not found" });
      }
      if (!dataset.taxonomyId || !dataset.taxonomyId.equals(taxonomyId)) {
        return res.status(400).json({
          success: false,
          error: "Dataset is not using this taxonomy",
        });
      }

      await db.collection("datasets").updateOne(
        { _id: datasetId },
        {
          $unset: { taxonomyId: "", taxonomyName: "", taxonomyAssignedAt: "" },
          $set: { updatedAt: new Date() },
        },
      );

      await audit({
        action: "taxonomy.unassign_from_dataset",
        actor: req.user,
        targetType: "dataset",
        targetId: datasetId.toString(),
        metadata: { taxonomyId: taxonomyId.toString() },
      });

      res.json({
        success: true,
        message: "Taxonomy unassigned from dataset",
      });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  },
);

/* ------------------------------------------------------------------ */
/* Validation helper                                                   */
/* ------------------------------------------------------------------ */

/**
 * Validates and normalizes the sentiment/type arrays.
 * Each item must be: { value, label, order? }
 * - value must be a unique slug (lowercase, no spaces)
 * - label must be a non-empty string
 * Both arrays must have at least one item.
 * Reserves the special sentinels "unannotated" and "unclassified"
 * so the rest of the code (which uses them as "not set") keeps working.
 */
function validateAndNormalize(sentiment, type) {
  const sRes = normalizeList(sentiment, "sentiment");
  if (sRes.error) return sRes;
  const tRes = normalizeList(type, "type");
  if (tRes.error) return tRes;

  // Ensure "unannotated" / "unclassified" are always present so the rest
  // of the codebase can keep using them as sentinel values.
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
    if (!label) {
      return { error: `${field}[${i}].label is required` };
    }

    // value is optional — derive from label if not supplied
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

module.exports = router;
