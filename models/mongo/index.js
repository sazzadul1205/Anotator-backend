// models/mongo/index.js
// The MongoDB strategy: thirteen model classes that satisfy the contract in
// models/contract.js.
//
// Selected automatically when DATA_PROVIDER=mongo (the default). Requiring
// this folder pulls in the `mongodb` driver, which is exactly why the JSON
// provider never requires it.

module.exports = {
  Comment: require("./Comment"),
  CommentVersion: require("./CommentVersion"),
  Dataset: require("./Dataset"),
  User: require("./User"),
  Taxonomy: require("./Taxonomy"),
  AuditLog: require("./AuditLog"),
  SystemLock: require("./SystemLock"),
  // Media: images and videos
  MediaDataset: require("./MediaDataset"),
  MediaAsset: require("./MediaAsset"),
  MediaAnnotation: require("./MediaAnnotation"),
  MediaAnnotationVersion: require("./MediaAnnotationVersion"),
  MediaLabelSet: require("./MediaLabelSet"),
  // Presence: live sessions
  PresenceSession: require("./PresenceSession"),
};
