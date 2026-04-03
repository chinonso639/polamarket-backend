/**
 * Market Routes
 */

const express = require("express");
const router = express.Router();
const marketController = require("../controllers/marketController");
const {
  authenticate: protect,
  optionalAuth,
  requireAdmin,
} = require("../middleware/auth");
const {
  trade: tradeLimiter,
  api: strictLimiter,
} = require("../middleware/rateLimiter");

/**
 * @route   GET /api/markets
 * @desc    Get all active markets
 * @access  Public
 */
router.get("/", marketController.getAllMarkets);

/**
 * @route   GET /api/markets/featured
 * @desc    Get featured markets
 * @access  Public
 */
router.get("/featured", marketController.getFeaturedMarkets);

/**
 * @route   GET /api/markets/trending
 * @desc    Get trending markets
 * @access  Public
 */
router.get("/trending", marketController.getTrendingMarkets);

/**
 * @route   GET /api/markets/categories
 * @desc    Get available categories
 * @access  Public
 */
router.get("/categories", marketController.getCategories);

/**
 * @route   GET /api/markets/search
 * @desc    Search markets
 * @access  Public
 */
router.get("/search", marketController.searchMarkets);

/**
 * @route   GET /api/markets/:id
 * @desc    Get market by ID
 * @access  Public
 */
router.get("/:id", marketController.getMarket);

/**
 * @route   GET /api/markets/:id/prices
 * @desc    Get current prices
 * @access  Public
 */
router.get("/:id/prices", marketController.getMarketPrices);

/**
 * @route   GET /api/markets/:id/history
 * @desc    Get price history
 * @access  Public
 */
router.get("/:id/history", marketController.getPriceHistory);

/**
 * @route   GET /api/markets/:id/orderbook
 * @desc    Get order book depth
 * @access  Public
 */
router.get("/:id/orderbook", marketController.getOrderBook);

/**
 * @route   GET /api/markets/:id/trades
 * @desc    Get recent trades
 * @access  Public
 */
router.get("/:id/trades", marketController.getRecentTrades);

/**
 * @route   POST /api/markets/:id/quote
 * @desc    Get trade quote (without executing)
 * @access  Public (optional auth for user-specific limits)
 */
router.post("/:id/quote", optionalAuth, marketController.getQuote);

/**
 * @route   POST /api/markets/:id/trade
 * @desc    Execute trade
 * @access  Private
 */
router.post("/:id/trade", protect, tradeLimiter, marketController.executeTrade);

/**
 * @route   POST /api/markets/:id/sell
 * @desc    Sell shares
 * @access  Private
 */
router.post("/:id/sell", protect, tradeLimiter, marketController.sellShares);

/**
 * @route   POST /api/markets
 * @desc    Create new market
 * @access  Private/Admin
 */
router.post(
  "/",
  protect,
  requireAdmin,
  strictLimiter,
  marketController.createMarket,
);

/**
 * @route   PUT /api/markets/:id
 * @desc    Update market
 * @access  Private/Admin
 */
router.put("/:id", protect, requireAdmin, marketController.updateMarket);

/**
 * @route   POST /api/markets/:id/resolve
 * @desc    Resolve market
 * @access  Private/Admin
 */
router.post(
  "/:id/resolve",
  protect,
  requireAdmin,
  marketController.resolveMarket,
);

/**
 * @route   POST /api/markets/:id/pause
 * @desc    Pause/unpause trading
 * @access  Private/Admin
 */
router.post(
  "/:id/pause",
  protect,
  requireAdmin,
  marketController.toggleTradingPause,
);

module.exports = router;
