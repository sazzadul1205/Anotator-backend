// models/index.js
// Barrel file. Re-exports every model so services can do:
//   const { Comment, Dataset, User } = require("../models");
//
// Later, when you add a second adapter, this becomes the switch that
// picks the folder. For now there's only one backend, so it's a
// straight re-export.

module.exports = {
  Comment: require("./Comment"),
  CommentVersion: require("./CommentVersion"),
  Dataset: require("./Dataset"),
  User: require("./User"),
  Taxonomy: require("./Taxonomy"),
  AuditLog: require("./AuditLog"),
  SystemLock: require("./SystemLock"),
  errors: require("./errors"),
};
