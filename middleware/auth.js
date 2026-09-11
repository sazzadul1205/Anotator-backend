const jwt = require("jsonwebtoken");

// Middleware to verify token
function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;

  // Check if Authorization header exists
  if (!authHeader) {
    return res.status(401).json({
      success: false,
      error: "No token provided",
    });
  }

  // Check Bearer format
  if (!authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      error: "Invalid authorization format",
    });
  }

  // Extract token
  const token = authHeader.split(" ")[1];

  // Verify token
  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      return res.status(401).json({
        success: false,
        error: "Invalid or expired token",
      });
    }

    // Attach decoded user information to request
    req.user = decoded;

    // Pass control to next middleware
    next();
  });
}

// Middleware to verify Admin
function verifyAdmin(req, res, next) {
  if (req.user?.role === "admin") {
    return next();
  }

  return res.status(403).json({
    success: false,
    error: "Unauthorized",
  });
}

module.exports = {
  verifyToken,
  verifyAdmin,
};