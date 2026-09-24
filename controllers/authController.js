// controllers/authController.js
// Authentication endpoints.

const authService = require("../services/authService");

/**
 * GET /api/auth/bootstrap-status
 * Returns { adminCount } so the UI can decide whether to show setup.
 */
async function bootstrapStatus(req, res, next) {
  try {
    const result = await authService.getBootstrapStatus();
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/auth/bootstrap
 * Creates the first admin. Refuses if one already exists.
 */
async function bootstrap(req, res, next) {
  try {
    const result = await authService.bootstrapAdmin(req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/auth/login
 * Returns { user, token }.
 */
async function login(req, res, next) {
  try {
    const result = await authService.login({ ...req.body, ip: req.ip });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

/**
 * POST /api/auth/logout
 * Invalidates the caller's current tokens.
 */
async function logout(req, res, next) {
  try {
    await authService.logout(req.user, req.ip);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

/**
 * GET /api/auth/me
 * Returns the authenticated user (injected by auth middleware).
 */
async function me(req, res) {
  res.json({ success: true, user: req.user });
}

module.exports = { bootstrapStatus, bootstrap, login, logout, me };
