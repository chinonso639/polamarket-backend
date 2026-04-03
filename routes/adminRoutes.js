/**
 * Admin Routes
 */

const express = require("express");
const router = express.Router();
const adminController = require("../controllers/adminController");
const { authenticate: protect, requireAdmin } = require("../middleware/auth");
const { api: strictLimiter } = require("../middleware/rateLimiter");

// All admin routes require authentication and admin role
router.use(protect);
router.use(requireAdmin);

/**
 * Dashboard & Analytics
 */

/**
 * @route   GET /api/admin/dashboard
 * @desc    Get admin dashboard stats
 * @access  Private/Admin
 */
router.get("/dashboard", adminController.getDashboard);

/**
 * @route   GET /api/admin/analytics
 * @desc    Get platform analytics
 * @access  Private/Admin
 */
router.get("/analytics", adminController.getAnalytics);

/**
 * @route   GET /api/admin/revenue
 * @desc    Get revenue breakdown
 * @access  Private/Admin
 */
router.get("/revenue", adminController.getRevenue);

/**
 * User Management
 */

/**
 * @route   GET /api/admin/users
 * @desc    Get all users
 * @access  Private/Admin
 */
router.get("/users", adminController.getUsers);

/**
 * @route   GET /api/admin/users/:id
 * @desc    Get user details
 * @access  Private/Admin
 */
router.get("/users/:id", adminController.getUserDetails);

/**
 * @route   PUT /api/admin/users/:id
 * @desc    Update user
 * @access  Private/Admin
 */
router.put("/users/:id", strictLimiter, adminController.updateUser);

/**
 * @route   POST /api/admin/users/:id/suspend
 * @desc    Suspend user
 * @access  Private/Admin
 */
router.post("/users/:id/suspend", strictLimiter, adminController.suspendUser);

/**
 * @route   POST /api/admin/users/:id/unsuspend
 * @desc    Unsuspend user
 * @access  Private/Admin
 */
router.post(
  "/users/:id/unsuspend",
  strictLimiter,
  adminController.unsuspendUser,
);

/**
 * @route   PUT /api/admin/users/:id/balance
 * @desc    Adjust user balance (manual)
 * @access  Private/Admin
 */
router.put("/users/:id/balance", strictLimiter, adminController.adjustBalance);

/**
 * Market Management
 */

/**
 * @route   GET /api/admin/markets
 * @desc    Get all markets (including inactive)
 * @access  Private/Admin
 */
router.get("/markets", adminController.getAllMarkets);

/**
 * @route   POST /api/admin/markets
 * @desc    Create market
 * @access  Private/Admin
 */
router.post("/markets", strictLimiter, adminController.createMarket);

/**
 * @route   PUT /api/admin/markets/:id
 * @desc    Update market
 * @access  Private/Admin
 */
router.put("/markets/:id", strictLimiter, adminController.updateMarket);

/**
 * @route   POST /api/admin/markets/:id/resolve
 * @desc    Resolve market
 * @access  Private/Admin
 */
router.post(
  "/markets/:id/resolve",
  strictLimiter,
  adminController.resolveMarket,
);

/**
 * @route   POST /api/admin/markets/:id/pause
 * @desc    Pause market trading
 * @access  Private/Admin
 */
router.post("/markets/:id/pause", adminController.pauseMarket);

/**
 * @route   POST /api/admin/markets/:id/unpause
 * @desc    Unpause market trading
 * @access  Private/Admin
 */
router.post("/markets/:id/unpause", adminController.unpauseMarket);

/**
 * @route   DELETE /api/admin/markets/:id
 * @desc    Delete market (soft delete)
 * @access  Private/Admin
 */
router.delete("/markets/:id", strictLimiter, adminController.deleteMarket);

/**
 * @route   POST /api/admin/markets/:id/add-liquidity
 * @desc    Add liquidity to market
 * @access  Private/Admin
 */
router.post(
  "/markets/:id/add-liquidity",
  strictLimiter,
  adminController.addLiquidity,
);

/**
 * Transaction & Withdrawal Management
 */

/**
 * @route   GET /api/admin/transactions
 * @desc    Get all transactions
 * @access  Private/Admin
 */
router.get("/transactions", adminController.getTransactions);

/**
 * @route   GET /api/admin/withdrawals/pending
 * @desc    Get pending withdrawals
 * @access  Private/Admin
 */
router.get("/withdrawals/pending", adminController.getPendingWithdrawals);

/**
 * @route   POST /api/admin/withdrawals/:id/approve
 * @desc    Approve withdrawal
 * @access  Private/Admin
 */
router.post(
  "/withdrawals/:id/approve",
  strictLimiter,
  adminController.approveWithdrawal,
);

/**
 * @route   POST /api/admin/withdrawals/:id/reject
 * @desc    Reject withdrawal
 * @access  Private/Admin
 */
router.post(
  "/withdrawals/:id/reject",
  strictLimiter,
  adminController.rejectWithdrawal,
);

/**
 * Risk Management
 */

/**
 * @route   GET /api/admin/risk/alerts
 * @desc    Get risk alerts
 * @access  Private/Admin
 */
router.get("/risk/alerts", adminController.getRiskAlerts);

/**
 * @route   GET /api/admin/risk/exposure
 * @desc    Get platform exposure
 * @access  Private/Admin
 */
router.get("/risk/exposure", adminController.getPlatformExposure);

/**
 * @route   GET /api/admin/risk/suspicious
 * @desc    Get suspicious activity
 * @access  Private/Admin
 */
router.get("/risk/suspicious", adminController.getSuspiciousActivity);

/**
 * System Settings
 */

/**
 * @route   GET /api/admin/settings
 * @desc    Get system settings
 * @access  Private/Admin
 */
router.get("/settings", adminController.getSettings);

/**
 * @route   PUT /api/admin/settings
 * @desc    Update system settings
 * @access  Private/Admin
 */
router.put("/settings", strictLimiter, adminController.updateSettings);

/**
 * @route   GET /api/admin/logs
 * @desc    Get system logs
 * @access  Private/Admin
 */
router.get("/logs", adminController.getLogs);

/**
 * Oracle & Sync
 */

/**
 * @route   POST /api/admin/sync/markets
 * @desc    Manually sync markets from external sources
 * @access  Private/Admin
 */
router.post("/sync/markets", strictLimiter, adminController.syncMarkets);

/**
 * @route   POST /api/admin/sync/resolutions
 * @desc    Manually check for resolutions
 * @access  Private/Admin
 */
router.post(
  "/sync/resolutions",
  strictLimiter,
  adminController.syncResolutions,
);

module.exports = router;
