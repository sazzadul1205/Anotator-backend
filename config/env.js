function validateEnv() {
  const required = ["MONGO_URI", "JWT_SECRET", "DB_NAME"];
  const missing = required.filter((k) => !process.env[k]);
  if (missing.length) {
    console.error(`❌ Missing env vars: ${missing.join(", ")}`);
    process.exit(1);
  }
  if (process.env.JWT_SECRET.length < 32) {
    console.error("❌ JWT_SECRET must be at least 32 chars");
    process.exit(1);
  }
  if (process.env.NODE_ENV === "production" && !process.env.CORS_ORIGIN) {
    console.error("❌ CORS_ORIGIN is required in production");
    process.exit(1);
  }
}

module.exports = { validateEnv };
