const bcrypt = require("bcryptjs");
const { ObjectId } = require("mongodb");
const User = require("../models/User");
const Dataset = require("../models/Dataset");
const { audit } = require("../utils/audit");

async function listUsers() {
  return User.findAll();
}

async function createUser({ name, email, password, role }, actor) {
  if (!name || !email || !password || !role) {
    const err = new Error("Missing fields");
    err.status = 400;
    throw err;
  }
  if (!["admin", "annotator"].includes(role)) {
    const err = new Error("Invalid role");
    err.status = 400;
    throw err;
  }
  if (password.length < 6) {
    const err = new Error("Password too short (min 6)");
    err.status = 400;
    throw err;
  }

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await User.findByEmail(normalizedEmail);
  if (existing) {
    const err = new Error("User already exists");
    err.status = 400;
    throw err;
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  let userId;
  try {
    userId = await User.create({
      name: name.trim(),
      email: normalizedEmail,
      password: hashedPassword,
      role,
    });
  } catch (err) {
    if (err.code === 11000) {
      const e = new Error("User already exists");
      e.status = 400;
      throw e;
    }
    throw err;
  }

  await audit({
    action: "user.create",
    actor,
    targetType: "user",
    targetId: userId.toString(),
    metadata: { email: normalizedEmail, role },
  });

  return { userId, message: "User created successfully" };
}

async function getUser(id) {
  const user = await User.findById(id);
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }
  return user;
}

async function updateUser(id, { name, email }, actor) {
  if (!name && !email) {
    const err = new Error("Missing fields");
    err.status = 400;
    throw err;
  }

  const user = await User.findById(id);
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }

  const updates = {};
  if (name) updates.name = name.trim();
  if (email) {
    const normalizedEmail = email.toLowerCase().trim();
    const existing = await User.collection().findOne({
      email: normalizedEmail,
      _id: { $ne: new ObjectId(id) },
    });
    if (existing) {
      const err = new Error("Email already exists");
      err.status = 400;
      throw err;
    }
    updates.email = normalizedEmail;
  }

  await User.updateById(id, updates);
  const updated = await User.findById(id);

  await audit({
    action: "user.update",
    actor,
    targetType: "user",
    targetId: id,
    metadata: { updates },
  });

  return { user: updated, message: "User updated successfully" };
}

async function toggleStatus(id, actorUserId, actor) {
  if (actorUserId === id) {
    const err = new Error("You cannot change your own status");
    err.status = 400;
    throw err;
  }

  const user = await User.findById(id);
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }

  const newStatus = !user.isActive;
  await User.updateStatus(id, newStatus);

  await audit({
    action: newStatus ? "user.activate" : "user.deactivate",
    actor,
    targetType: "user",
    targetId: id,
    metadata: { email: user.email },
  });

  return {
    isActive: newStatus,
    message: newStatus
      ? "User activated successfully"
      : "User deactivated successfully",
  };
}

async function resetPassword(id, { newPassword, confirmPassword }, actor) {
  if (!newPassword || !confirmPassword) {
    const err = new Error("Missing fields");
    err.status = 400;
    throw err;
  }
  if (newPassword !== confirmPassword) {
    const err = new Error("Password and Confirm Password do not match");
    err.status = 400;
    throw err;
  }
  if (newPassword.length < 6) {
    const err = new Error("Password too short (min 6)");
    err.status = 400;
    throw err;
  }

  const user = await User.findById(id);
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }

  const hashed = await bcrypt.hash(newPassword, 10);
  await User.updatePassword(id, hashed);

  await audit({
    action: "user.password_reset",
    actor,
    targetType: "user",
    targetId: id,
    metadata: { email: user.email },
  });

  return { message: "Password reset successfully" };
}

async function deleteUser(id, actorUserId, actor) {
  if (actorUserId === id) {
    const err = new Error("You cannot delete yourself");
    err.status = 400;
    throw err;
  }

  const user = await User.findById(id);
  if (!user) {
    const err = new Error("User not found");
    err.status = 404;
    throw err;
  }

  const assigned = await Dataset.countAssignedTo(id);
  if (assigned > 0) {
    const err = new Error(
      `User has ${assigned} dataset(s) assigned. Unassign first.`,
    );
    err.status = 400;
    throw err;
  }

  await User.deleteById(id);

  await audit({
    action: "user.delete",
    actor,
    targetType: "user",
    targetId: id,
    metadata: { email: user.email, role: user.role },
  });

  return { message: "User deleted successfully" };
}

module.exports = {
  listUsers,
  createUser,
  getUser,
  updateUser,
  toggleStatus,
  resetPassword,
  deleteUser,
};
