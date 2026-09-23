const userService = require("../services/userService");

async function list(req, res, next) {
  try {
    const users = await userService.listUsers();
    res.json({ success: true, users });
  } catch (err) {
    next(err);
  }
}

async function create(req, res, next) {
  try {
    const result = await userService.createUser(req.body, req.user);
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function getOne(req, res, next) {
  try {
    const user = await userService.getUser(req.params.id);
    res.json({ success: true, user });
  } catch (err) {
    next(err);
  }
}

async function update(req, res, next) {
  try {
    const result = await userService.updateUser(
      req.params.id,
      req.body,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function toggleStatus(req, res, next) {
  try {
    const result = await userService.toggleStatus(
      req.params.id,
      req.user.userId,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function resetPassword(req, res, next) {
  try {
    const result = await userService.resetPassword(
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
    const result = await userService.deleteUser(
      req.params.id,
      req.user.userId,
      req.user,
    );
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  list,
  create,
  getOne,
  update,
  toggleStatus,
  resetPassword,
  remove,
};
