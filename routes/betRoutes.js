/**
 * Bet Routes
 */

const express = require("express");
const router = express.Router();
const betController = require("../controllers/betController");
const { authenticate: protect } = require("../middleware/auth");

/**
 * @route   GET /api/bets
 * @desc    Get user's bets
 * @access  Private
 */
router.get("/", protect, betController.getUserBets);

/**
 * @route   GET /api/bets/:id
 * @desc    Get bet by ID
 * @access  Private
 */
router.get("/:id", protect, betController.getBet);

/**
 * @route   GET /api/bets/market/:marketId
 * @desc    Get user's bets for specific market
 * @access  Private
 */
router.get("/market/:marketId", protect, betController.getMarketBets);

/**
 * @route   GET /api/bets/active
 * @desc    Get active (unresolved) bets
 * @access  Private
 */
router.get("/status/active", protect, betController.getActiveBets);

/**
 * @route   GET /api/bets/settled
 * @desc    Get settled bets
 * @access  Private
 */
router.get("/status/settled", protect, betController.getSettledBets);

/**
 * @route   GET /api/bets/won
 * @desc    Get winning bets
 * @access  Private
 */
router.get("/status/won", protect, betController.getWinningBets);

/**
 * @route   GET /api/bets/lost
 * @desc    Get losing bets
 * @access  Private
 */
router.get("/status/lost", protect, betController.getLosingBets);

/**
 * @route   POST /api/bets/:id/claim
 * @desc    Claim winnings from bet
 * @access  Private
 */
router.post("/:id/claim", protect, betController.claimWinnings);

/**
 * @route   POST /api/bets/claim-all
 * @desc    Claim all available winnings
 * @access  Private
 */
router.post("/claim-all", protect, betController.claimAllWinnings);

/**
 * @route   GET /api/bets/summary
 * @desc    Get betting summary/statistics
 * @access  Private
 */
router.get("/stats/summary", protect, betController.getBettingSummary);

module.exports = router;
