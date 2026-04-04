/**
 * Polymarket Proxy Routes
 * Routes for proxying requests to Polymarket APIs
 */

const express = require("express");
const router = express.Router();
const polymarketController = require("../controllers/polymarketController");

/**
 * @route   GET /api/polymarket/markets
 * @desc    Get markets from Polymarket
 * @access  Public
 */
router.get("/markets", polymarketController.getMarkets);

/**
 * @route   GET /api/polymarket/trending
 * @desc    Get trending markets
 * @access  Public
 */
router.get("/trending", polymarketController.getTrendingMarkets);

/**
 * @route   GET /api/polymarket/sports/live
 * @desc    Get live sports-style matchup feed from Gamma
 * @access  Public
 */
router.get("/sports/live", polymarketController.getLiveSportsMatches);
router.get("/sports/match", polymarketController.getSportsMatch);
router.post("/sports/explain", polymarketController.explainContract);

/**
 * @route   GET /api/polymarket/search
 * @desc    Search markets
 * @access  Public
 */
router.get("/search", polymarketController.searchMarkets);

/**
 * @route   GET /api/polymarket/categories
 * @desc    Get categories with counts
 * @access  Public
 */
router.get("/categories", polymarketController.getCategories);

/**
 * @route   GET /api/polymarket/markets/:id
 * @desc    Get market by ID
 * @access  Public
 */
router.get("/markets/:id", polymarketController.getMarketById);

/**
 * @route   GET /api/polymarket/trades/:conditionId
 * @desc    Get trades for a market
 * @access  Public
 */
router.get("/trades/:conditionId", polymarketController.getTrades);

/**
 * @route   GET /api/polymarket/prices/:conditionId
 * @desc    Get price history
 * @access  Public
 */
router.get("/prices/:conditionId", polymarketController.getPriceHistory);

module.exports = router;
