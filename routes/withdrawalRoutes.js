/**
 * Withdrawal Routes
 */

const express = require("express");
const router = express.Router();
const withdrawalService = require("../services/withdrawalService");
const { authenticate: protect } = require("../middleware/auth");
const { withdrawal: strictLimiter } = require("../middleware/rateLimiter");
const { success, error } = require("../utils/response");
const logger = require("../utils/logger");

/**
 * @route   POST /api/withdrawals/request
 * @desc    Request withdrawal
 * @access  Private
 */
router.post("/request", protect, strictLimiter, async (req, res) => {
  try {
    const { amount, address, currency } = req.body;

    // Validate inputs
    if (!amount || !address) {
      return error(res, "Amount and address are required", 400);
    }

    const result = await withdrawalService.requestWithdrawal(
      req.user._id,
      amount,
      address,
      currency || "USDT",
    );

    if (!result.success) {
      return error(res, result.error, 400);
    }

    success(res, result.data, "Withdrawal request submitted");
  } catch (err) {
    logger.error("Withdrawal request error:", err);
    error(res, err.message, 500);
  }
});

/**
 * @route   GET /api/withdrawals/:id/status
 * @desc    Get withdrawal status
 * @access  Private
 */
router.get("/:id/status", protect, async (req, res) => {
  try {
    const result = await withdrawalService.getWithdrawalStatus(req.params.id);

    if (!result.success) {
      return error(res, result.error, 404);
    }

    success(res, result.data);
  } catch (err) {
    logger.error("Get withdrawal status error:", err);
    error(res, err.message, 500);
  }
});

/**
 * @route   POST /api/withdrawals/:id/cancel
 * @desc    Cancel pending withdrawal
 * @access  Private
 */
router.post("/:id/cancel", protect, async (req, res) => {
  try {
    const result = await withdrawalService.cancelWithdrawal(
      req.params.id,
      req.user._id,
    );

    if (!result.success) {
      return error(res, result.error, 400);
    }

    success(res, result.data, "Withdrawal cancelled");
  } catch (err) {
    logger.error("Cancel withdrawal error:", err);
    error(res, err.message, 500);
  }
});

/**
 * @route   GET /api/withdrawals/history
 * @desc    Get withdrawal history
 * @access  Private
 */
router.get("/history", protect, async (req, res) => {
  try {
    const Transaction = require("../models/Transaction");

    const withdrawals = await Transaction.find({
      userId: req.user._id,
      type: "WITHDRAWAL",
    })
      .sort({ createdAt: -1 })
      .limit(50);

    success(res, withdrawals);
  } catch (err) {
    logger.error("Get withdrawal history error:", err);
    error(res, err.message, 500);
  }
});

/**
 * @route   GET /api/withdrawals/limits
 * @desc    Get withdrawal limits for user
 * @access  Private
 */
router.get("/limits", protect, async (req, res) => {
  try {
    const result = await withdrawalService.getUserWithdrawalLimits(
      req.user._id,
    );

    if (!result.success) {
      return error(res, result.error, 400);
    }

    success(res, result.data);
  } catch (err) {
    logger.error("Get withdrawal limits error:", err);
    error(res, err.message, 500);
  }
});

/**
 * @route   GET /api/withdrawals/check-eligibility
 * @desc    Check if user can withdraw
 * @access  Private
 */
router.get("/check-eligibility", protect, async (req, res) => {
  try {
    const User = require("../models/User");
    const user = await User.findById(req.user._id);

    const cooldownMs = 60 * 60 * 1000; // 1 hour
    const canWithdraw =
      !user.lastWithdrawalAt ||
      Date.now() - user.lastWithdrawalAt.getTime() > cooldownMs;

    const nextWithdrawalAt = user.lastWithdrawalAt
      ? new Date(user.lastWithdrawalAt.getTime() + cooldownMs)
      : null;

    success(res, {
      canWithdraw,
      balance: user.balance,
      nextWithdrawalAt,
      limits: {
        minimum: 10,
        maximum: 50000,
        dailyRemaining: 50000, // TODO: Calculate actual daily remaining
      },
    });
  } catch (err) {
    logger.error("Check withdrawal eligibility error:", err);
    error(res, err.message, 500);
  }
});

/**
 * @route   GET /api/withdrawals/supported-tokens
 * @desc    Get supported withdrawal tokens
 * @access  Public
 */
router.get("/supported-tokens", (req, res) => {
  const tokens = [
    {
      symbol: "USDT",
      name: "Tether",
      network: "Polygon",
      contract:
        process.env.USDT_CONTRACT_ADDRESS ||
        "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
      decimals: 6,
      fee: 0.5,
    },
    {
      symbol: "USDC",
      name: "USD Coin",
      network: "Polygon",
      contract:
        process.env.USDC_CONTRACT_ADDRESS ||
        "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      decimals: 6,
      fee: 0.5,
    },
  ];

  success(res, tokens);
});

module.exports = router;
