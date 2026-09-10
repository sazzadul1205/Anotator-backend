const logRequest = (req, res, next) => {
  console.log(
    `[${new Date().toISOString()}] ${req.method} ${req.originalUrl} - User: ${
      req.user?.username || "unauthenticated"
    }`
  );
  next();
};

module.exports = logRequest;