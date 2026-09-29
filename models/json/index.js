// models/json/index.js
// The JSON strategy: seven model classes backed by in-app JSON files that
// satisfy the same contract as models/mongo.
//
// Selected when DATA_PROVIDER=json. Requiring this folder never loads the
// mongodb driver, so the two strategies are fully independent.

module.exports = {
  Comment: require("./Comment"),
  CommentVersion: require("./CommentVersion"),
  Dataset: require("./Dataset"),
  User: require("./User"),
  Taxonomy: require("./Taxonomy"),
  AuditLog: require("./AuditLog"),
  SystemLock: require("./SystemLock"),
};
