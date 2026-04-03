/**
 * Deposit Routes
 */

const express = require("express");
const router = express.Router();
const depositService = require("../services/depositService");
const { authenticate: protect } = require("../middleware/auth");
const { deposit: strictLimiter } = require("../middleware/rateLimiter");
const { success, error } = require("../utils/response");
const logger = require("../utils/logger");

/**
 * @route   POST /api/deposits/create
 * @desc    Create deposit address/payment
 * @access  Private
 */
router.post("/create", protect, strictLimiter, async (req, res) => {
  try {
    const { amount, currency } = req.body;

    if (!amount || amount < 10) {
      return error(res, "Minimum deposit is $10", 400);
    }

    const payment = await depositService.createDeposit({
      userId: req.user._id,
      amount,
      currency: currency || "USDT",
    });

    success(res, payment, "Deposit address created");
  } catch (err) {
    logger.error("Create deposit error:", err);
    error(res, err.message, 500);
  }
});

/**
 * @route   GET /api/deposits/:paymentId/status
 * @desc    Check deposit status
 * @access  Private
 */
router.get("/:paymentId/status", protect, async (req, res) => {
  try {
    const status = await depositService.getPaymentStatus(req.params.paymentId);
    success(res, status);
  } catch (err) {
    logger.error("Check deposit status error:", err);
    error(res, err.message, 500);
  }
});

/**
 * @route   POST /api/deposits/webhook
 * @desc    NowPayments webhook callback
 * @access  Public (signature verified)
 */
router.post(
  "/webhook",
  express.raw({ type: "application/json" }),
  async (req, res) => {
    try {
      const signature = req.headers["x-nowpayments-sig"];
      const body = req.body;
      let payload;
      let rawBody = req.rawBody;

      if (Buffer.isBuffer(body)) {
        rawBody = body.toString("utf8");
        payload = JSON.parse(rawBody);
      } else if (typeof body === "string") {
        rawBody = body;
        payload = JSON.parse(body);
      } else if (body && typeof body === "object") {
        payload = body;
        rawBody = rawBody || JSON.stringify(body);
      } else {
        throw new Error("Invalid webhook body");
      }

      const result = await depositService.processWebhook(
        payload,
        rawBody,
        signature,
      );

      if (result.success) {
        res.status(200).json({ status: "ok" });
      } else {
        res.status(400).json({ error: result.error });
      }
    } catch (err) {
      logger.error("Webhook processing error:", err);
      res.status(500).json({ error: "Internal error" });
    }
  },
);

/**
 * @route   GET /api/deposits/history
 * @desc    Get deposit history
 * @access  Private
 */
router.get("/history", protect, async (req, res) => {
  try {
    const Transaction = require("../models/Transaction");

    const deposits = await Transaction.find({
      userId: req.user._id,
      type: "DEPOSIT",
    })
      .sort({ createdAt: -1 })
      .limit(50);

    success(res, deposits);
  } catch (err) {
    logger.error("Get deposit history error:", err);
    error(res, err.message, 500);
  }
});

/**
 * @route   GET /api/deposits/currencies
 * @desc    Get supported deposit currencies
 * @access  Public
 */
router.get("/currencies", (req, res) => {
  const currencies = [
    { symbol: "USDT", name: "Tether", networks: ["TRC20", "ERC20", "POLYGON"] },
    { symbol: "USDC", name: "USD Coin", networks: ["ERC20", "POLYGON"] },
    { symbol: "BTC", name: "Bitcoin", networks: ["BTC"] },
    { symbol: "ETH", name: "Ethereum", networks: ["ERC20"] },
    { symbol: "MATIC", name: "Polygon", networks: ["POLYGON"] },
  ];

  success(res, currencies);
});

/**
 * @route   GET /api/deposits/limits
 * @desc    Get deposit limits
 * @access  Public
 */
router.get("/limits", (req, res) => {
  const limits = {
    minimum: 10,
    maximum: 100000,
    daily: 50000,
  };

  success(res, limits);
});

module.exports = router;
