// models/document/index.js
// The document strategy: seven model classes that talk to a store presenting
// the MongoDB collection API over string ids.
//
// Three providers select this strategy — json, sqlite and mysql — because all
// three are reached through the same store interface. The differences between
// them live entirely in config/storage/; only models/mongo/ needs its own
// implementation, because MongoDB is the one driver with a different id type
// (ObjectId).
//
// Requiring this folder never loads the mongodb driver, so the two strategies
// stay fully independent.

module.exports = {
  Comment: require("./Comment"),
  CommentVersion: require("./CommentVersion"),
  Dataset: require("./Dataset"),
  User: require("./User"),
  Taxonomy: require("./Taxonomy"),
  AuditLog: require("./AuditLog"),
  SystemLock: require("./SystemLock"),
};
