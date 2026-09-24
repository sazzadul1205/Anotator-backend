// services/authService.js
// First-time admin bootstrap, login, logout.

const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { User, SystemLock } = require("../models");
const { audit } = require("../utils/audit");

const BOOTSTRAP_LOCK_ID = "admin_bootstrap";

/**
 * Report whether an admin already exists.
 */
async function getBootstrapStatus() {
  const adminCount = await User.countAdmins();
  return { adminCount };
}

/**
 * Create the first admin. Uses a system lock so concurrent requests
 * can't both succeed.
 */
async function bootstrapAdmin({ name, email, password, confirmPassword }) {
  if (!name || !email || !password || !confirmPassword) {
    const err = new Error("Missing fields");
    err.status = 400;
    throw err;
  }
  if (password !== confirmPassword) {
    const err = new Error("Passwords do not match");
    err.status = 400;
    throw err;
  }
  if (password.length < 6) {
    const err = new Error("Password too short (min 6)");
    err.status = 400;
    throw err;
  }

  let lockClaimed = false;
  try {
    // Try to claim the bootstrap lock
    try {
      await SystemLock.claim(BOOTSTRAP_LOCK_ID);
      lockClaimed = true;
    } catch (err) {
      if (err.name === "DuplicateKeyError") {
        const e = new Error("Admin account already exists");
        e.status = 400;
        throw e;
      }
      throw err;
    }

    // Secondary check
    const adminCount = await User.countAdmins();
    if (adminCount > 0) {
      await SystemLock.release(BOOTSTRAP_LOCK_ID);
      lockClaimed = false;
      const e = new Error("Admin account already exists");
      e.status = 400;
      throw e;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const normalizedEmail = email.toLowerCase().trim();

    const { id: userId } = await User.create({
      email: normalizedEmail,
      name: name.trim(),
      password: hashedPassword,
      role: "admin",
    });

    await audit({
      action: "auth.bootstrap",
      actor: null,
      targetType: "user",
      targetId: userId,
      metadata: { email: normalizedEmail },
    });

    return { userId, message: "Admin account created successfully" };
  } catch (err) {
    if (lockClaimed) {
      try {
        await SystemLock.release(BOOTSTRAP_LOCK_ID);
      } catch {
        // best effort
      }
    }
    throw err;
  }
}

/**
 * Authenticate and issue a JWT.
 */
async function login({ email, password, ip }) {
  if (!email || !password) {
    const err = new Error("Missing fields");
    err.status = 400;
    throw err;
  }

  const user = await User.findByEmail(email);
  if (!user || !user.isActive) {
    const err = new Error("Invalid credentials");
    err.status = 401;
    throw err;
  }

  const match = await bcrypt.compare(password, user.password);
  if (!match) {
    const err = new Error("Invalid credentials");
    err.status = 401;
    throw err;
  }

  const token = jwt.sign(
    {
      userId: user.id,
      role: user.role,
      tokenVersion: user.tokenVersion || 0,
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );

  await audit({
    action: "auth.login",
    actor: { userId: user.id, email: user.email, role: user.role },
    metadata: { ip },
  });

  return {
    user: {
      _id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
      isActive: user.isActive,
      createdAt: user.createdAt,
      updatedAt: user.updatedAt,
    },
    token,
  };
}

/**
 * Invalidate the user's tokens by bumping tokenVersion.
 */
async function logout(reqUser, ip) {
  await User.bumpTokenVersion(reqUser.userId);

  await audit({
    action: "auth.logout",
    actor: reqUser,
    metadata: { ip },
  });
}

module.exports = { getBootstrapStatus, bootstrapAdmin, login, logout };
