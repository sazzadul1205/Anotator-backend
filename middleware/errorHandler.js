function notFound(req, res) {
  res.status(404).json({
    success: false,
    error: "Route not found",
    path: req.originalUrl,
  });
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  console.error("[error]", err);
  res.status(err.status || 500).json({
    success: false,
    error:
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : err.message,
  });
}

module.exports = { notFound, errorHandler };
