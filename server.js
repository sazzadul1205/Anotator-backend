const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
require("dotenv").config();

const { connectDB } = require("./config/db");

const app = express();

// Security middleware
app.use(helmet());
app.use(cors());
app.use(express.json());

// Rate limiter ONLY for login endpoint
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 login attempts
    message: {
        success: false,
        error: "Too many login attempts. Please try again after 15 minutes."
    }
});

connectDB();

// Routes
const authRoutes = require("./routes/authRoutes");
const projectRoutes = require("./routes/projectRoutes");
const commentRoutes = require("./routes/commentRoutes");

// Apply login limiter ONLY to login route
app.use("/api/auth/login", loginLimiter);
app.use("/api/auth", authRoutes);
app.use("/api", projectRoutes);
app.use("/api", commentRoutes);

app.get("/", (req, res) => {
    res.json({
        message: "Annotator backend is running"
    });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});