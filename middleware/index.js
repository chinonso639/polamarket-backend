/**
 * Middleware Module Index
 */

const auth = require("./auth");
const rateLimiter = require("./rateLimiter");
const errorHandler = require("./errorHandler");

module.exports = {
  auth,
  rateLimiter,
  errorHandler,

  // Convenience exports
  authenticate: auth.authenticate,
  optionalAuth: auth.optionalAuth,
  requireAdmin: auth.requireAdmin,
  generateToken: auth.generateToken,

  ApiError: errorHandler.ApiError,
  errors: errorHandler.errors,
  asyncHandler: errorHandler.asyncHandler,
};
