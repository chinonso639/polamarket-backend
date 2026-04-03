/**
 * Authentication Middleware
 * JWT-based authentication and authorization
 */

const jwt = require("jsonwebtoken");
const User = require("../models/User");
const response = require("../utils/response");
const logger = require("../utils/logger");

/**
 * Authenticate user via JWT token
 */
const authenticate = async (req, res, next) => {
  try {
    // Get token from header
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return response.unauthorized(res, "No token provided");
    }

    const token = authHeader.split(" ")[1];

    // Verify token
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Find user
    const user = await User.findById(decoded.userId);

    if (!user) {
      return response.unauthorized(res, "User not found");
    }

    if (!user.isActive) {
      return response.forbidden(res, "Account is deactivated");
    }

    if (user.isBanned) {
      return response.forbidden(
        res,
        `Account banned: ${user.banReason || "Contact support"}`,
      );
    }

    // Attach user to request
    req.user = user;
    req.userId = user._id.toString();

    next();
  } catch (error) {
    if (error.name === "JsonWebTokenError") {
      return response.unauthorized(res, "Invalid token");
    }
    if (error.name === "TokenExpiredError") {
      return response.unauthorized(res, "Token expired");
    }

    logger.error("Authentication error:", error);
    return response.serverError(res, "Authentication failed");
  }
};

/**
 * Optional authentication - doesn't fail if no token
 */
const optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      req.user = null;
      return next();
    }

    const token = authHeader.split(" ")[1];
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.userId);

    req.user = user;
    req.userId = user?._id.toString();

    next();
  } catch (error) {
    // On any error, just continue without auth
    req.user = null;
    next();
  }
};

/**
 * Admin authorization
 */
const requireAdmin = async (req, res, next) => {
  if (!req.user) {
    return response.unauthorized(res);
  }

  // Check if user has admin role (you might want to add a role field to User model)
  if (req.user.email !== process.env.ADMIN_EMAIL && !req.user.isAdmin) {
    return response.forbidden(res, "Admin access required");
  }

  next();
};

/**
 * Verify API key for programmatic access
 */
const verifyApiKey = async (req, res, next) => {
  try {
    const apiKey = req.headers["x-api-key"];

    if (!apiKey) {
      return response.unauthorized(res, "API key required");
    }

    const user = await User.findOne({ apiKey }).select("+apiKey");

    if (!user) {
      return response.unauthorized(res, "Invalid API key");
    }

    // Update last used timestamp
    user.apiKeyLastUsed = new Date();
    await user.save();

    req.user = user;
    req.userId = user._id.toString();

    next();
  } catch (error) {
    logger.error("API key verification error:", error);
    return response.serverError(res);
  }
};

/**
 * Generate JWT token for a user
 *
 * @param {Object} user - User object
 * @returns {string} - JWT token
 */
const generateToken = (user) => {
  return jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || "7d",
  });
};

/**
 * Generate refresh token
 */
const generateRefreshToken = (user) => {
  return jwt.sign(
    { userId: user._id, type: "refresh" },
    process.env.JWT_SECRET,
    { expiresIn: "30d" },
  );
};

module.exports = {
  authenticate,
  optionalAuth,
  requireAdmin,
  verifyApiKey,
  generateToken,
  generateRefreshToken,
};
