/**
 * Global Error Handler Middleware
 * Catches all unhandled errors and returns appropriate responses
 */

const logger = require("../utils/logger");

/**
 * Custom API Error class
 */
class ApiError extends Error {
  constructor(message, statusCode = 400, code = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Common error types
 */
const errors = {
  badRequest: (message) => new ApiError(message, 400, "BAD_REQUEST"),
  unauthorized: (message = "Unauthorized") =>
    new ApiError(message, 401, "UNAUTHORIZED"),
  forbidden: (message = "Forbidden") => new ApiError(message, 403, "FORBIDDEN"),
  notFound: (resource = "Resource") =>
    new ApiError(`${resource} not found`, 404, "NOT_FOUND"),
  conflict: (message) => new ApiError(message, 409, "CONFLICT"),
  tooManyRequests: (message = "Too many requests") =>
    new ApiError(message, 429, "TOO_MANY_REQUESTS"),
  internalError: (message = "Internal server error") =>
    new ApiError(message, 500, "INTERNAL_ERROR"),

  // Trading specific errors
  insufficientBalance: () =>
    new ApiError("Insufficient balance", 400, "INSUFFICIENT_BALANCE"),
  marketResolved: () =>
    new ApiError("Market is already resolved", 400, "MARKET_RESOLVED"),
  tradingPaused: () =>
    new ApiError("Trading is currently paused", 400, "TRADING_PAUSED"),
  slippageExceeded: (actual, max) =>
    new ApiError(
      `Slippage ${(actual * 100).toFixed(2)}% exceeds maximum ${(max * 100).toFixed(2)}%`,
      400,
      "SLIPPAGE_EXCEEDED",
    ),
  positionLimit: () =>
    new ApiError("Position limit exceeded", 400, "POSITION_LIMIT"),
  cooldownActive: (seconds) =>
    new ApiError(
      `Please wait ${seconds} seconds before trading again`,
      429,
      "COOLDOWN_ACTIVE",
    ),
};

/**
 * Error handler middleware
 */
const errorHandler = (err, req, res, next) => {
  // Log error
  logger.error("Error:", {
    message: err.message,
    code: err.code,
    statusCode: err.statusCode,
    stack: err.stack,
    path: req.path,
    method: req.method,
    userId: req.userId,
    ip: req.ip,
  });

  // Handle specific error types

  // Mongoose validation error
  if (err.name === "ValidationError") {
    const errors = Object.values(err.errors).map((e) => ({
      field: e.path,
      message: e.message,
    }));

    return res.status(400).json({
      success: false,
      error: "Validation failed",
      details: errors,
      timestamp: new Date().toISOString(),
    });
  }

  // Mongoose duplicate key error
  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    return res.status(409).json({
      success: false,
      error: `${field} already exists`,
      code: "DUPLICATE_KEY",
      timestamp: new Date().toISOString(),
    });
  }

  // Mongoose cast error (invalid ObjectId)
  if (err.name === "CastError") {
    return res.status(400).json({
      success: false,
      error: "Invalid ID format",
      code: "INVALID_ID",
      timestamp: new Date().toISOString(),
    });
  }

  // JWT errors
  if (err.name === "JsonWebTokenError") {
    return res.status(401).json({
      success: false,
      error: "Invalid token",
      code: "INVALID_TOKEN",
      timestamp: new Date().toISOString(),
    });
  }

  if (err.name === "TokenExpiredError") {
    return res.status(401).json({
      success: false,
      error: "Token expired",
      code: "TOKEN_EXPIRED",
      timestamp: new Date().toISOString(),
    });
  }

  // Custom API errors
  if (err instanceof ApiError) {
    return res.status(err.statusCode).json({
      success: false,
      error: err.message,
      code: err.code,
      timestamp: new Date().toISOString(),
    });
  }

  // AMM errors (from lmsr.js)
  if (err.message && err.message.includes(":")) {
    const [code, message] = err.message.split(":");
    const codeMap = {
      MARKET_RESOLVED: 400,
      TRADING_PAUSED: 400,
      MIN_TRADE: 400,
      MAX_TRADE: 400,
      SLIPPAGE_EXCEEDED: 400,
      LIQUIDITY_FLOOR: 400,
    };

    if (codeMap[code.trim()]) {
      return res.status(codeMap[code.trim()]).json({
        success: false,
        error: message.trim(),
        code: code.trim(),
        timestamp: new Date().toISOString(),
      });
    }
  }

  // Default error response
  const statusCode = err.statusCode || 500;
  const message =
    process.env.NODE_ENV === "production" && statusCode === 500
      ? "Internal server error"
      : err.message;

  return res.status(statusCode).json({
    success: false,
    error: message,
    code: err.code || "UNKNOWN_ERROR",
    timestamp: new Date().toISOString(),
  });
};

/**
 * Async handler wrapper to catch errors in async routes
 */
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
};

module.exports = errorHandler;
module.exports.ApiError = ApiError;
module.exports.errors = errors;
module.exports.asyncHandler = asyncHandler;
