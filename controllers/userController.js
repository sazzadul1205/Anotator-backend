// controllers/userController.js
// Thin HTTP wrappers around userService.

const userService = require("../services/userService");

/**
 * GET /api/users
 * List all users (admin only — enforced at route layer).
 */
async function list(req, res, next) {
  try {
    const users = await userService.listUsers();
    res.json({ success: true, users });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/users
 * Create a user.
 */
async function create(req, res, next) {
  try {
    const result = await userService.createUser(req.body, req.user);
    res.status(201).json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/users/:id
 * Fetch one user.
 */
async function getOne(req, res, next) {
  try {
    const user = await userService.getUser(req.params.id);
    res.json({ success: true, user });
  } catch (err) {
    next(err);
  }
}

/**
 * PATCH /api/users/:id
 * Update a user's name and/or email.
 */
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

/**
 * PATCH /api/users/:id/status
 * Flip the user's isActive flag.
 */
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

/**
 * POST /api/users/:id/reset-password
 * Reset a user's password (admin action).
 */
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

/**
 * DELETE /api/users/:id
 * Delete a user (refuses if the user still owns datasets).
 */
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
