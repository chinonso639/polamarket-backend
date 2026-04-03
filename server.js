/**
 * Polamarket Backend Server
 * Production-ready prediction market with LMSR-based AMM engine
 */

require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const http = require("http");
const { initializeSocketIO } = require("./services/socketService");
const { initializeJobs } = require("./jobs");
const logger = require("./utils/logger");
const rateLimiter = require("./middleware/rateLimiter");
const errorHandler = require("./middleware/errorHandler");

// Import routes
const authRoutes = require("./routes/authRoutes");
const marketRoutes = require("./routes/marketRoutes");
const userRoutes = require("./routes/userRoutes");
const depositRoutes = require("./routes/depositRoutes");
const withdrawalRoutes = require("./routes/withdrawalRoutes");
const betRoutes = require("./routes/betRoutes");
const adminRoutes = require("./routes/adminRoutes");
const polymarketRoutes = require("./routes/polymarketRoutes");

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO
const io = initializeSocketIO(server);

// Make io accessible to routes
app.set("io", io);

// Security middleware
app.use(helmet());
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || "*",
    credentials: true,
  }),
);

// Request logging
app.use(
  morgan("combined", {
    stream: { write: (message) => logger.info(message.trim()) },
  }),
);

// Body parsing
app.use(
  express.json({
    limit: "10mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }),
);
app.use(express.urlencoded({ extended: true }));

// Global rate limiting
app.use(rateLimiter.global);

// Health check endpoint
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// API routes
app.use("/api/auth", authRoutes);
app.use("/api/markets", marketRoutes);
app.use("/api/users", userRoutes);
app.use("/api/deposits", depositRoutes);
app.use("/api/withdrawals", withdrawalRoutes);
app.use("/api/bets", betRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/polymarket", polymarketRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
  });
});

// Global error handler
app.use(errorHandler);

// Database connection and server startup
const PORT = process.env.PORT || 5000;

mongoose
  .connect(process.env.MONGODB_URI || "mongodb://localhost:27017/polygrid", {
    // Mongoose 6+ doesn't need these options anymore
  })
  .then(() => {
    logger.info("📦 Connected to MongoDB");

    // Initialize scheduled jobs
    initializeJobs();

    // Start server
    server.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT}`);
      logger.info(`📊 Environment: ${process.env.NODE_ENV || "development"}`);
      logger.info(`🔌 Socket.IO initialized`);
    });
  })
  .catch((error) => {
    logger.error("❌ MongoDB connection error:", error);
    process.exit(1);
  });

// Graceful shutdown
process.on("SIGTERM", () => {
  logger.info("SIGTERM received. Shutting down gracefully...");
  server.close(() => {
    mongoose.connection.close(false, () => {
      logger.info("Server closed. Database connection closed.");
      process.exit(0);
    });
  });
});

module.exports = { app, server, io };
