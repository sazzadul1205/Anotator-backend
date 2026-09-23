const taxonomyService = require("../services/taxonomyService");

async function list(req, res, next) {
  try {
    const taxonomies = await taxonomyService.listTaxonomies(
      req.query,
      req.user,
    );
    res.json({ success: true, taxonomies });
  } catch (err) {
    next(err);
  }
}

async function getDefaults(req, res, next) {
  try {
    const defaults = await taxonomyService.getDefaults();
    res.json({ success: true, defaults });
  } catch (err) {
    next(err);
  }
}

async function getForDataset(req, res, next) {
  try {
    const result = await taxonomyService.getForDataset(
      req.params.datasetId,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const result = await taxonomyService.createTaxonomy(req.body, req.user);
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const taxonomy = await taxonomyService.getTaxonomy(req.params.id, req.user);
    res.json({ success: true, taxonomy });
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const result = await taxonomyService.updateTaxonomy(
      req.params.id,
      req.body,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function remove(req, res, next) {
  try {
    const hard = req.query.hard === "true";
    const result = await taxonomyService.deleteTaxonomy(
      req.params.id,
      hard,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function assignToDataset(req, res, next) {
  try {
    const result = await taxonomyService.assignToDataset(
      req.params.id,
      req.params.datasetId,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function unassignFromDataset(req, res, next) {
  try {
    const result = await taxonomyService.unassignFromDataset(
      req.params.id,
      req.params.datasetId,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  list,
  getDefaults,
  getForDataset,
  create,
  getOne,
  update,
  remove,
  assignToDataset,
  unassignFromDataset,
};
