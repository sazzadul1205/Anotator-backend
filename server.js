const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
require("dotenv").config();

const { connectDB } = require("./config/db");

const app = express();

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

connectDB();

// Root
app.get("/", (req, res) => {
  res.json({
    message: "Annotator backend is running",
  });
});

// Health check
app.get("/health", (req, res) => {
  res.status(200).json({
    success: true,
    message: "Server is healthy",
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// Routes
app.use("/api/auth", require("./routes/authRoute"));
app.use("/api/users", require("./routes/userRoute"));


// Error handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Route not found",
    path: req.originalUrl,
  });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
