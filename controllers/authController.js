const authService = require("../services/authService");

async function bootstrapStatus(req, res, next) {
  try {
    const result = await authService.getBootstrapStatus();
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function bootstrap(req, res, next) {
  try {
    const result = await authService.bootstrapAdmin(req.body);
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function login(req, res, next) {
  try {
    const result = await authService.login({ ...req.body, ip: req.ip });
    res.json({ success: true, ...result });
  } catch (err) {
    next(err);
  }
}

async function logout(req, res, next) {
  try {
    await authService.logout(req.user, req.ip);
    res.json({ success: true });
  } catch (err) {
    next(err);
  }
}

async function me(req, res) {
  res.json({ success: true, user: req.user });
}

module.exports = { bootstrapStatus, bootstrap, login, logout, me };
