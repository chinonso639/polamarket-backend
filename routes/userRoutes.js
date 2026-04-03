/**
 * User Routes
 */

const express = require("express");
const router = express.Router();
const userController = require("../controllers/userController");
const { authenticate: protect } = require("../middleware/auth");
const { api: strictLimiter } = require("../middleware/rateLimiter");

/**
 * @route   GET /api/users/profile
 * @desc    Get user profile
 * @access  Private
 */
router.get("/profile", protect, userController.getProfile);

/**
 * @route   PUT /api/users/profile
 * @desc    Update user profile
 * @access  Private
 */
router.put("/profile", protect, strictLimiter, userController.updateProfile);

/**
 * @route   GET /api/users/balance
 * @desc    Get user balance
 * @access  Private
 */
router.get("/balance", protect, userController.getBalance);

/**
 * @route   GET /api/users/positions
 * @desc    Get user positions
 * @access  Private
 */
router.get("/positions", protect, userController.getPositions);

/**
 * @route   GET /api/users/positions/:marketId
 * @desc    Get position for specific market
 * @access  Private
 */
router.get("/positions/:marketId", protect, userController.getMarketPosition);

/**
 * @route   GET /api/users/bets
 * @desc    Get user bet history
 * @access  Private
 */
router.get("/bets", protect, userController.getBetHistory);

/**
 * @route   GET /api/users/transactions
 * @desc    Get user transactions
 * @access  Private
 */
router.get("/transactions", protect, userController.getTransactions);

/**
 * @route   GET /api/users/stats
 * @desc    Get user trading statistics
 * @access  Private
 */
router.get("/stats", protect, userController.getStats);

/**
 * @route   GET /api/users/notifications
 * @desc    Get user notifications
 * @access  Private
 */
router.get("/notifications", protect, userController.getNotifications);

/**
 * @route   PUT /api/users/notifications/:id/read
 * @desc    Mark notification as read
 * @access  Private
 */
router.put(
  "/notifications/:id/read",
  protect,
  userController.markNotificationRead,
);

/**
 * @route   PUT /api/users/notifications/read-all
 * @desc    Mark all notifications as read
 * @access  Private
 */
router.put(
  "/notifications/read-all",
  protect,
  userController.markAllNotificationsRead,
);

/**
 * @route   GET /api/users/preferences
 * @desc    Get user preferences
 * @access  Private
 */
router.get("/preferences", protect, userController.getPreferences);

/**
 * @route   PUT /api/users/preferences
 * @desc    Update user preferences
 * @access  Private
 */
router.put("/preferences", protect, userController.updatePreferences);

/**
 * @route   GET /api/users/referrals
 * @desc    Get referral info
 * @access  Private
 */
router.get("/referrals", protect, userController.getReferralInfo);

/**
 * @route   GET /api/users/leaderboard
 * @desc    Get leaderboard
 * @access  Public
 */
router.get("/leaderboard", userController.getLeaderboard);

/**
 * @route   GET /api/users/public/:userId
 * @desc    Get public profile
 * @access  Public
 */
router.get("/public/:userId", userController.getPublicProfile);

module.exports = router;
