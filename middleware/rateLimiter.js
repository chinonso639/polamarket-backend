/**
 * Rate Limiting Middleware
 * Protect against abuse and DDoS attacks
 */

const rateLimit = require("express-rate-limit");
const response = require("../utils/response");
const logger = require("../utils/logger");

/**
 * Create a rate limiter with custom options
 */
const createLimiter = (options) => {
  return rateLimit({
    windowMs: options.windowMs || 15 * 60 * 1000, // 15 minutes default
    max: options.max || 100,
    message: options.message || "Too many requests",
    standardHeaders: true,
    legacyHeaders: false,
    handler: (req, res) => {
      logger.warn("Rate limit exceeded", {
        ip: req.ip,
        path: req.path,
        userId: req.userId,
      });
      return response.rateLimited(res, Math.ceil(options.windowMs / 1000));
    },
    keyGenerator:
      options.keyGenerator ||
      ((req) => {
        // Use user ID if authenticated, otherwise IP
        return req.userId || req.ip;
      }),
    skip: options.skip || (() => false),
  });
};

/**
 * Global rate limiter - applies to all routes
 */
const global = createLimiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 1000, // 1000 requests per 15 minutes
  message: "Too many requests from this IP, please try again later",
});

/**
 * Auth rate limiter - stricter for login/register
 */
const auth = createLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 attempts per hour
  message: "Too many auth attempts, please try again later",
  keyGenerator: (req) => req.ip, // Always use IP for auth
});

/**
 * Trade rate limiter - prevent bot trading
 */
const trade = createLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 20, // 20 trades per minute
  message: "Trade rate limit exceeded. Please slow down.",
  keyGenerator: (req) => req.userId || req.ip,
});

/**
 * Withdrawal rate limiter - very strict
 */
const withdrawal = createLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 withdrawals per hour
  message: "Withdrawal rate limit exceeded. Please try again later.",
  keyGenerator: (req) => req.userId,
});

/**
 * Deposit rate limiter
 */
const deposit = createLimiter({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 10, // 10 deposits per hour
  message: "Deposit rate limit exceeded. Please try again later.",
});

/**
 * API rate limiter for public endpoints
 */
const api = createLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 60, // 60 requests per minute
  message: "API rate limit exceeded.",
});

/**
 * Webhook rate limiter
 */
const webhook = createLimiter({
  windowMs: 60 * 1000, // 1 minute
  max: 100, // 100 webhooks per minute
  keyGenerator: (req) => req.ip,
});

/**
 * Custom per-user rate limiting storage (in-memory)
 */
const userTradeCooldowns = new Map();

/**
 * Check user trade cooldown
 */
const checkTradeCooldown = (userId) => {
  const lastTrade = userTradeCooldowns.get(userId);
  const cooldownMs = parseInt(process.env.TRADE_COOLDOWN_MS) || 1000;

  if (lastTrade && Date.now() - lastTrade < cooldownMs) {
    return {
      allowed: false,
      waitMs: cooldownMs - (Date.now() - lastTrade),
    };
  }

  return { allowed: true };
};

/**
 * Record user trade time
 */
const recordTrade = (userId) => {
  userTradeCooldowns.set(userId, Date.now());

  // Clean up old entries periodically
  if (userTradeCooldowns.size > 10000) {
    const cutoff = Date.now() - 60000; // 1 minute ago
    for (const [id, time] of userTradeCooldowns) {
      if (time < cutoff) {
        userTradeCooldowns.delete(id);
      }
    }
  }
};

/**
 * Trade cooldown middleware
 */
const tradeCooldown = (req, res, next) => {
  if (!req.userId) {
    return response.unauthorized(res);
  }

  const cooldownCheck = checkTradeCooldown(req.userId);

  if (!cooldownCheck.allowed) {
    return response.error(
      res,
      `Please wait ${Math.ceil(cooldownCheck.waitMs / 1000)} seconds before trading again`,
      429,
      { waitMs: cooldownCheck.waitMs },
    );
  }

  // Record after successful trade (call recordTrade in controller)
  next();
};

module.exports = {
  createLimiter,
  global,
  auth,
  trade,
  withdrawal,
  deposit,
  api,
  webhook,
  checkTradeCooldown,
  recordTrade,
  tradeCooldown,
};
