/**
 * API Response Helpers
 * Standardized response formats for consistent API responses
 */

/**
 * Success response
 *
 * @param {Object} res - Express response object
 * @param {any} data - Response data
 * @param {string} message - Optional success message
 * @param {number} statusCode - HTTP status code (default: 200)
 */
function success(res, data, message = "Success", statusCode = 200) {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
    timestamp: new Date().toISOString(),
  });
}

/**
 * Created response (201)
 *
 * @param {Object} res - Express response object
 * @param {any} data - Created resource data
 * @param {string} message - Optional message
 */
function created(res, data, message = "Resource created successfully") {
  return success(res, data, message, 201);
}

/**
 * Error response
 *
 * @param {Object} res - Express response object
 * @param {string} message - Error message
 * @param {number} statusCode - HTTP status code (default: 400)
 * @param {Object} details - Additional error details
 */
function error(res, message, statusCode = 400, details = null) {
  const response = {
    success: false,
    error: message,
    timestamp: new Date().toISOString(),
  };

  if (details) {
    response.details = details;
  }

  return res.status(statusCode).json(response);
}

/**
 * Not found response (404)
 */
function notFound(res, resource = "Resource") {
  return error(res, `${resource} not found`, 404);
}

/**
 * Unauthorized response (401)
 */
function unauthorized(res, message = "Authentication required") {
  return error(res, message, 401);
}

/**
 * Forbidden response (403)
 */
function forbidden(res, message = "Access denied") {
  return error(res, message, 403);
}

/**
 * Validation error response (422)
 */
function validationError(res, errors) {
  return error(res, "Validation failed", 422, errors);
}

/**
 * Rate limit exceeded response (429)
 */
function rateLimited(res, retryAfter = 60) {
  res.set("Retry-After", retryAfter);
  return error(res, "Too many requests, please try again later", 429, {
    retryAfter,
  });
}

/**
 * Server error response (500)
 */
function serverError(res, message = "Internal server error") {
  return error(res, message, 500);
}

/**
 * Paginated response
 *
 * @param {Object} res - Express response object
 * @param {Array} data - Array of items
 * @param {number} page - Current page
 * @param {number} limit - Items per page
 * @param {number} total - Total items count
 */
function paginated(res, data, page, limit, total) {
  const totalPages = Math.ceil(total / limit);

  return res.status(200).json({
    success: true,
    data,
    pagination: {
      page,
      limit,
      total,
      totalPages,
      hasMore: page < totalPages,
    },
    timestamp: new Date().toISOString(),
  });
}

/**
 * Trade response with detailed info
 */
function tradeSuccess(res, tradeResult) {
  return res.status(200).json({
    success: true,
    message: `Successfully bought ${tradeResult.outcome} shares`,
    trade: {
      outcome: tradeResult.outcome,
      shares: tradeResult.shares,
      amountSpent: tradeResult.amountSpent,
      fee: tradeResult.fee,
      avgPrice: tradeResult.avgPrice,
      slippage: tradeResult.slippage,
    },
    market: {
      pricesBefore: tradeResult.pricesBefore,
      pricesAfter: tradeResult.pricesAfter,
    },
    timestamp: new Date().toISOString(),
  });
}

module.exports = {
  success,
  created,
  error,
  notFound,
  unauthorized,
  forbidden,
  validationError,
  rateLimited,
  serverError,
  paginated,
  tradeSuccess,
};
