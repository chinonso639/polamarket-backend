/**
 * Validation Helpers
 * Input validation utilities for API endpoints
 */

const { body, param, query, validationResult } = require("express-validator");

/**
 * Validate request and return errors if any
 */
const validate = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      success: false,
      error: "Validation failed",
      details: errors.array().map((err) => ({
        field: err.path,
        message: err.msg,
      })),
    });
  }
  next();
};

/**
 * Common validation rules
 */
const rules = {
  // User validation
  email: body("email")
    .isEmail()
    .withMessage("Valid email is required")
    .normalizeEmail(),

  password: body("password")
    .isLength({ min: 8 })
    .withMessage("Password must be at least 8 characters")
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)/)
    .withMessage("Password must contain uppercase, lowercase, and number"),

  username: body("username")
    .optional()
    .isLength({ min: 3, max: 30 })
    .withMessage("Username must be 3-30 characters")
    .matches(/^[a-zA-Z0-9_]+$/)
    .withMessage("Username can only contain letters, numbers, and underscores"),

  walletAddress: body("walletAddress")
    .optional()
    .matches(/^0x[a-fA-F0-9]{40}$/)
    .withMessage("Invalid Ethereum address format"),

  // Market validation
  marketId: param("marketId").isMongoId().withMessage("Invalid market ID"),

  outcome: body("outcome")
    .isIn(["YES", "NO"])
    .withMessage("Outcome must be YES or NO"),

  amount: body("amount")
    .isFloat({ min: 0.01 })
    .withMessage("Amount must be a positive number"),

  // Trade validation
  tradeAmount: body("amount")
    .isFloat({ min: 1 })
    .withMessage("Trade amount must be at least $1")
    .custom((value) => {
      if (value > 10000) {
        throw new Error("Trade amount cannot exceed $10,000");
      }
      return true;
    }),

  maxSlippage: body("maxSlippage")
    .optional()
    .isFloat({ min: 0.01, max: 0.5 })
    .withMessage("Max slippage must be between 1% and 50%"),

  // Withdrawal validation
  withdrawalAmount: body("amount")
    .isFloat({ min: 10 })
    .withMessage("Minimum withdrawal is $10")
    .custom((value) => {
      if (value > 50000) {
        throw new Error("Maximum withdrawal is $50,000");
      }
      return true;
    }),

  // Pagination
  page: query("page")
    .optional()
    .isInt({ min: 1 })
    .withMessage("Page must be a positive integer"),

  limit: query("limit")
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage("Limit must be between 1 and 100"),

  // Market creation
  question: body("question")
    .isLength({ min: 10, max: 500 })
    .withMessage("Question must be 10-500 characters")
    .trim()
    .escape(),

  description: body("description")
    .optional()
    .isLength({ max: 2000 })
    .withMessage("Description cannot exceed 2000 characters")
    .trim(),

  category: body("category")
    .optional()
    .isIn([
      "politics",
      "world",
      "sports",
      "crypto",
      "entertainment",
      "science",
      "business",
      "other",
    ])
    .withMessage("Invalid category"),

  endDate: body("endDate")
    .isISO8601()
    .withMessage("Invalid date format")
    .custom((value) => {
      if (new Date(value) <= new Date()) {
        throw new Error("End date must be in the future");
      }
      return true;
    }),

  // Liquidity parameter
  liquidityParam: body("b")
    .optional()
    .isInt({ min: 10, max: 10000 })
    .withMessage("Liquidity parameter must be between 10 and 10000"),
};

/**
 * Validation rule sets for endpoints
 */
const validators = {
  register: [rules.email, rules.password, rules.username, validate],
  login: [
    rules.email,
    body("password").notEmpty().withMessage("Password is required"),
    validate,
  ],

  createMarket: [
    rules.question,
    rules.description,
    rules.category,
    rules.endDate,
    rules.liquidityParam,
    validate,
  ],

  trade: [
    rules.marketId,
    rules.outcome,
    rules.tradeAmount,
    rules.maxSlippage,
    validate,
  ],

  withdrawal: [rules.withdrawalAmount, rules.walletAddress, validate],

  updateWallet: [rules.walletAddress, validate],

  pagination: [rules.page, rules.limit, validate],
};

/**
 * Sanitize input to prevent XSS and injection
 */
function sanitize(input) {
  if (typeof input !== "string") return input;

  return input
    .replace(/[<>]/g, "") // Remove angle brackets
    .replace(/javascript:/gi, "") // Remove javascript: protocol
    .replace(/on\w+\s*=/gi, "") // Remove event handlers
    .trim();
}

/**
 * Validate MongoDB ObjectId
 */
function isValidObjectId(id) {
  const objectIdRegex = /^[0-9a-fA-F]{24}$/;
  return objectIdRegex.test(id);
}

module.exports = {
  validate,
  rules,
  validators,
  sanitize,
  isValidObjectId,
};
