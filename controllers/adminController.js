/**
 * Admin Controller
 * Administrative functions for managing the platform
 */

const User = require("../models/User");
const Market = require("../models/Market");
const Bet = require("../models/Bet");
const Transaction = require("../models/Transaction");
const response = require("../utils/response");
const logger = require("../utils/logger");
const { asyncHandler } = require("../middleware/errorHandler");

/**
 * GET /api/admin/dashboard
 * Get admin dashboard
 */
const getDashboard = asyncHandler(async (req, res) => {
  const [totalUsers, totalMarkets, totalBets, recentUsers, recentMarkets] =
    await Promise.all([
      User.countDocuments(),
      Market.countDocuments(),
      Bet.countDocuments(),
      User.find()
        .sort({ createdAt: -1 })
        .limit(5)
        .select("username email createdAt")
        .lean(),
      Market.find()
        .sort({ createdAt: -1 })
        .limit(5)
        .select("question status createdAt")
        .lean(),
    ]);

  return response.success(res, {
    stats: { totalUsers, totalMarkets, totalBets },
    recentUsers,
    recentMarkets,
  });
});

/**
 * GET /api/admin/analytics
 * Get platform analytics
 */
const getAnalytics = asyncHandler(async (req, res) => {
  const { period = "7d" } = req.query;

  // Placeholder analytics
  return response.success(res, {
    period,
    users: { new: 0, active: 0 },
    volume: { total: 0, daily: [] },
    markets: { created: 0, resolved: 0 },
  });
});

/**
 * GET /api/admin/revenue
 * Get revenue breakdown
 */
const getRevenue = asyncHandler(async (req, res) => {
  const totalFees = await Market.aggregate([
    { $group: { _id: null, total: { $sum: "$totalFeesCollected" } } },
  ]);

  return response.success(res, {
    totalFees: totalFees[0]?.total || 0,
    breakdown: {
      tradingFees: 0,
      withdrawalFees: 0,
    },
  });
});

/**
 * GET /api/admin/users/:id
 * Get user details
 */
const getUserDetails = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id);

  if (!user) {
    return response.notFound(res, "User");
  }

  return response.success(res, { user });
});

/**
 * PUT /api/admin/users/:id
 * Update user
 */
const updateUser = asyncHandler(async (req, res) => {
  const user = await User.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });

  if (!user) {
    return response.notFound(res, "User");
  }

  logger.info(`Admin updated user: ${user.email}`);
  return response.success(res, { user }, "User updated");
});

/**
 * POST /api/admin/users/:id/suspend
 * Suspend user (alias for banUser)
 */
const suspendUser = asyncHandler(async (req, res) => {
  const { reason } = req.body;

  const user = await User.findByIdAndUpdate(
    req.params.id,
    { isBanned: true, banReason: reason || "Suspended by admin" },
    { new: true },
  );

  if (!user) {
    return response.notFound(res, "User");
  }

  logger.info(`Admin suspended user: ${user.email}`);
  return response.success(res, { user }, "User suspended");
});

/**
 * POST /api/admin/users/:id/unsuspend
 * Unsuspend user (alias for unbanUser)
 */
const unsuspendUser = asyncHandler(async (req, res) => {
  const user = await User.findByIdAndUpdate(
    req.params.id,
    { isBanned: false, banReason: null },
    { new: true },
  );

  if (!user) {
    return response.notFound(res, "User");
  }

  logger.info(`Admin unsuspended user: ${user.email}`);
  return response.success(res, { user }, "User unsuspended");
});

/**
 * POST /api/admin/markets
 * Create market
 */
const createMarket = asyncHandler(async (req, res) => {
  const market = new Market(req.body);
  await market.save();

  logger.info(`Admin created market: ${market.question}`);
  return response.created(res, { market }, "Market created");
});

/**
 * PUT /api/admin/markets/:id
 * Update market
 */
const updateMarket = asyncHandler(async (req, res) => {
  const market = await Market.findByIdAndUpdate(req.params.id, req.body, {
    new: true,
  });

  if (!market) {
    return response.notFound(res, "Market");
  }

  logger.info(`Admin updated market: ${market.question}`);
  return response.success(res, { market }, "Market updated");
});

/**
 * POST /api/admin/markets/:id/resolve
 * Resolve market
 */
const resolveMarket = asyncHandler(async (req, res) => {
  const { outcome } = req.body;

  const market = await Market.findByIdAndUpdate(
    req.params.id,
    { resolved: true, resolvedOutcome: outcome, resolvedAt: new Date() },
    { new: true },
  );

  if (!market) {
    return response.notFound(res, "Market");
  }

  logger.info(`Admin resolved market: ${market.question} -> ${outcome}`);
  return response.success(res, { market }, "Market resolved");
});

/**
 * POST /api/admin/markets/:id/unpause
 * Unpause market (alias for resumeMarket)
 */
const unpauseMarket = asyncHandler(async (req, res) => {
  const market = await Market.findByIdAndUpdate(
    req.params.id,
    { isTradingActive: true },
    { new: true },
  );

  if (!market) {
    return response.notFound(res, "Market");
  }

  return response.success(res, { market }, "Market trading resumed");
});

/**
 * DELETE /api/admin/markets/:id
 * Delete market
 */
const deleteMarket = asyncHandler(async (req, res) => {
  const market = await Market.findByIdAndDelete(req.params.id);

  if (!market) {
    return response.notFound(res, "Market");
  }

  logger.info(`Admin deleted market: ${market.question}`);
  return response.success(res, null, "Market deleted");
});

/**
 * POST /api/admin/markets/:id/liquidity
 * Add liquidity to market
 */
const addLiquidity = asyncHandler(async (req, res) => {
  const { amount } = req.body;

  const market = await Market.findByIdAndUpdate(
    req.params.id,
    { $inc: { liquidity: amount } },
    { new: true },
  );

  if (!market) {
    return response.notFound(res, "Market");
  }

  logger.info(`Admin added ${amount} liquidity to market: ${market.question}`);
  return response.success(res, { market }, "Liquidity added");
});

/**
 * GET /api/admin/withdrawals/pending
 * Get pending withdrawals
 */
const getPendingWithdrawals = asyncHandler(async (req, res) => {
  const withdrawals = await Transaction.find({
    type: "withdrawal",
    status: "pending",
  })
    .populate("userId", "username email walletAddress")
    .sort({ createdAt: 1 })
    .lean();

  return response.success(res, { withdrawals });
});

/**
 * POST /api/admin/withdrawals/:id/approve
 * Approve withdrawal
 */
const approveWithdrawal = asyncHandler(async (req, res) => {
  const withdrawal = await Transaction.findByIdAndUpdate(
    req.params.id,
    { status: "completed", processedAt: new Date() },
    { new: true },
  );

  if (!withdrawal) {
    return response.notFound(res, "Withdrawal");
  }

  logger.info(`Admin approved withdrawal: ${withdrawal._id}`);
  return response.success(res, { withdrawal }, "Withdrawal approved");
});

/**
 * POST /api/admin/withdrawals/:id/reject
 * Reject withdrawal
 */
const rejectWithdrawal = asyncHandler(async (req, res) => {
  const { reason } = req.body;

  const withdrawal = await Transaction.findByIdAndUpdate(
    req.params.id,
    { status: "rejected", rejectionReason: reason, processedAt: new Date() },
    { new: true },
  );

  if (!withdrawal) {
    return response.notFound(res, "Withdrawal");
  }

  // Refund the amount to user's balance
  await User.findByIdAndUpdate(withdrawal.userId, {
    $inc: { balance: withdrawal.amount, withdrawable: withdrawal.amount },
  });

  logger.info(`Admin rejected withdrawal: ${withdrawal._id}`);
  return response.success(res, { withdrawal }, "Withdrawal rejected");
});

/**
 * GET /api/admin/stats
 * Get platform statistics
 */
const getPlatformStats = asyncHandler(async (req, res) => {
  const [
    totalUsers,
    activeUsers,
    totalMarkets,
    activeMarkets,
    totalBets,
    totalVolume,
    totalFees,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({
      isActive: true,
      lastLoginAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    }),
    Market.countDocuments(),
    Market.countDocuments({ resolved: false, isTradingActive: true }),
    Bet.countDocuments(),
    Market.aggregate([
      { $group: { _id: null, total: { $sum: "$totalVolume" } } },
    ]),
    Market.aggregate([
      { $group: { _id: null, total: { $sum: "$totalFeesCollected" } } },
    ]),
  ]);

  return response.success(res, {
    users: {
      total: totalUsers,
      active: activeUsers,
    },
    markets: {
      total: totalMarkets,
      active: activeMarkets,
    },
    trading: {
      totalBets,
      totalVolume: totalVolume[0]?.total || 0,
      totalFees: totalFees[0]?.total || 0,
    },
  });
});

/**
 * GET /api/admin/users
 * Get all users with pagination
 */
const getUsers = asyncHandler(async (req, res) => {
  const { page = 1, limit = 50, search, status } = req.query;

  const query = {};

  if (search) {
    query.$or = [
      { email: { $regex: search, $options: "i" } },
      { username: { $regex: search, $options: "i" } },
    ];
  }

  if (status === "active") query.isActive = true;
  if (status === "banned") query.isBanned = true;
  if (status === "inactive") query.isActive = false;

  const [users, total] = await Promise.all([
    User.find(query)
      .select("-password -twoFactorSecret -apiKey")
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean(),
    User.countDocuments(query),
  ]);

  return response.paginated(res, users, parseInt(page), parseInt(limit), total);
});

/**
 * PUT /api/admin/users/:userId/ban
 * Ban a user
 */
const banUser = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { reason } = req.body;

  const user = await User.findByIdAndUpdate(
    userId,
    { isBanned: true, banReason: reason },
    { new: true },
  );

  if (!user) {
    return response.notFound(res, "User");
  }

  logger.warn(`User banned: ${user.email} - Reason: ${reason}`);

  return response.success(res, user.toSafeObject(), "User banned");
});

/**
 * PUT /api/admin/users/:userId/unban
 * Unban a user
 */
const unbanUser = asyncHandler(async (req, res) => {
  const { userId } = req.params;

  const user = await User.findByIdAndUpdate(
    userId,
    { isBanned: false, banReason: null },
    { new: true },
  );

  if (!user) {
    return response.notFound(res, "User");
  }

  logger.info(`User unbanned: ${user.email}`);

  return response.success(res, user.toSafeObject(), "User unbanned");
});

/**
 * PUT /api/admin/users/:userId/balance
 * Adjust user balance (for corrections/bonuses)
 */
const adjustBalance = asyncHandler(async (req, res) => {
  const { userId } = req.params;
  const { amount, reason } = req.body;

  const user = await User.findById(userId);

  if (!user) {
    return response.notFound(res, "User");
  }

  const newBalance = user.balance + amount;

  if (newBalance < 0) {
    return response.error(
      res,
      "Adjustment would result in negative balance",
      400,
    );
  }

  // Update balance
  user.balance = newBalance;
  if (amount > 0) {
    user.withdrawable += amount;
  }
  await user.save();

  // Create adjustment transaction
  const transaction = new Transaction({
    userId,
    type: "adjustment",
    amount: Math.abs(amount),
    fee: 0,
    netAmount: amount,
    status: "completed",
    balanceBefore: user.balance - amount,
    balanceAfter: user.balance,
    description: reason || "Admin balance adjustment",
  });

  await transaction.save();

  logger.info(
    `Balance adjustment: ${user.email} ${amount > 0 ? "+" : ""}${amount} - ${reason}`,
  );

  return response.success(
    res,
    {
      userId,
      previousBalance: user.balance - amount,
      adjustment: amount,
      newBalance: user.balance,
    },
    "Balance adjusted",
  );
});

/**
 * GET /api/admin/markets
 * Get all markets with admin details
 */
const getAllMarkets = asyncHandler(async (req, res) => {
  const { page = 1, limit = 50, status } = req.query;

  const query = {};

  if (status === "active") {
    query.resolved = false;
    query.isTradingActive = true;
  } else if (status === "resolved") {
    query.resolved = true;
  } else if (status === "disputed") {
    query.isDisputed = true;
  }

  const [markets, total] = await Promise.all([
    Market.find(query)
      .populate("createdBy", "email username")
      .populate("resolvedBy", "email username")
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean(),
    Market.countDocuments(query),
  ]);

  return response.paginated(
    res,
    markets,
    parseInt(page),
    parseInt(limit),
    total,
  );
});

/**
 * PUT /api/admin/markets/:marketId/pause
 * Pause trading on a market
 */
const pauseMarket = asyncHandler(async (req, res) => {
  const { marketId } = req.params;
  const { reason } = req.body;

  const market = await Market.findByIdAndUpdate(
    marketId,
    { isTradingActive: false, tradingPausedReason: reason },
    { new: true },
  );

  if (!market) {
    return response.notFound(res, "Market");
  }

  // Emit pause event
  const io = req.app.get("io");
  if (io) {
    io.to(`market:${marketId}`).emit("tradingPaused", { marketId, reason });
  }

  logger.warn(`Market paused: ${marketId} - ${reason}`);

  return response.success(res, market, "Market trading paused");
});

/**
 * PUT /api/admin/markets/:marketId/resume
 * Resume trading on a market
 */
const resumeMarket = asyncHandler(async (req, res) => {
  const { marketId } = req.params;

  const market = await Market.findByIdAndUpdate(
    marketId,
    { isTradingActive: true, tradingPausedReason: null },
    { new: true },
  );

  if (!market) {
    return response.notFound(res, "Market");
  }

  // Emit resume event
  const io = req.app.get("io");
  if (io) {
    io.to(`market:${marketId}`).emit("tradingResumed", { marketId });
  }

  logger.info(`Market resumed: ${marketId}`);

  return response.success(res, market, "Market trading resumed");
});

/**
 * POST /api/admin/markets/:marketId/dispute
 * Flag a market resolution as disputed
 */
const disputeMarket = asyncHandler(async (req, res) => {
  const { marketId } = req.params;
  const { reason } = req.body;

  const market = await Market.findByIdAndUpdate(
    marketId,
    {
      isDisputed: true,
      disputeReason: reason,
      disputedAt: new Date(),
      isTradingActive: false,
    },
    { new: true },
  );

  if (!market) {
    return response.notFound(res, "Market");
  }

  logger.warn(`Market disputed: ${marketId} - ${reason}`);

  return response.success(res, market, "Market marked as disputed");
});

/**
 * GET /api/admin/transactions
 * Get all transactions with filters
 */
const getTransactions = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 50,
    type,
    status,
    userId,
    startDate,
    endDate,
  } = req.query;

  const query = {};

  if (type) query.type = type;
  if (status) query.status = status;
  if (userId) query.userId = userId;

  if (startDate || endDate) {
    query.createdAt = {};
    if (startDate) query.createdAt.$gte = new Date(startDate);
    if (endDate) query.createdAt.$lte = new Date(endDate);
  }

  const [transactions, total] = await Promise.all([
    Transaction.find(query)
      .populate("userId", "email username")
      .populate("marketId", "question")
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean(),
    Transaction.countDocuments(query),
  ]);

  return response.paginated(
    res,
    transactions,
    parseInt(page),
    parseInt(limit),
    total,
  );
});

/**
 * GET /api/admin/audit-log
 * Get audit log of admin actions
 */
const getAuditLog = asyncHandler(async (req, res) => {
  const { page = 1, limit = 50 } = req.query;

  // Get adjustment and admin-related transactions
  const [logs, total] = await Promise.all([
    Transaction.find({ type: "adjustment" })
      .populate("userId", "email username")
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean(),
    Transaction.countDocuments({ type: "adjustment" }),
  ]);

  return response.paginated(res, logs, parseInt(page), parseInt(limit), total);
});

/**
 * GET /api/admin/risk/alerts
 * Get risk alerts
 */
const getRiskAlerts = asyncHandler(async (req, res) => {
  // TODO: Implement risk monitoring
  return response.success(res, { alerts: [] });
});

/**
 * GET /api/admin/risk/exposure
 * Get platform exposure
 */
const getPlatformExposure = asyncHandler(async (req, res) => {
  const markets = await Market.find({ resolved: false })
    .select("question outcomes liquidity")
    .lean();

  const totalExposure = markets.reduce((sum, m) => sum + (m.liquidity || 0), 0);

  return response.success(res, {
    totalExposure,
    marketCount: markets.length,
    markets: markets.slice(0, 10), // Top 10
  });
});

/**
 * GET /api/admin/risk/suspicious
 * Get suspicious activity
 */
const getSuspiciousActivity = asyncHandler(async (req, res) => {
  // TODO: Implement fraud detection
  return response.success(res, { suspicious: [] });
});

/**
 * GET /api/admin/settings
 * Get system settings
 */
const getSettings = asyncHandler(async (req, res) => {
  return response.success(res, {
    minBet: parseFloat(process.env.MIN_BET_AMOUNT) || 0.1,
    maxBet: parseFloat(process.env.MAX_BET_AMOUNT) || 10000,
    tradingFee: parseFloat(process.env.TRADING_FEE_PERCENT) || 2,
    withdrawalFee: parseFloat(process.env.WITHDRAWAL_FEE_PERCENT) || 0.5,
    minWithdrawal: parseFloat(process.env.MIN_WITHDRAWAL_AMOUNT) || 10,
    maxWithdrawal: parseFloat(process.env.MAX_WITHDRAWAL_AMOUNT) || 50000,
  });
});

/**
 * PUT /api/admin/settings
 * Update system settings (stub - would need env file or config update)
 */
const updateSettings = asyncHandler(async (req, res) => {
  // In production, this would update a config in database or file
  logger.info("Admin updated settings:", req.body);
  return response.success(res, req.body, "Settings updated (requires restart)");
});

/**
 * GET /api/admin/logs
 * Get system logs
 */
const getLogs = asyncHandler(async (req, res) => {
  // This would typically read from a logging service
  return response.success(res, {
    logs: [],
    message: "Log viewing not implemented",
  });
});

/**
 * POST /api/admin/sync/markets
 * Sync markets from external sources
 */
const syncMarkets = asyncHandler(async (req, res) => {
  // This would call the oracle/gamma API
  logger.info("Admin triggered market sync");
  return response.success(res, null, "Market sync initiated");
});

/**
 * POST /api/admin/sync/resolutions
 * Sync resolutions from external sources
 */
const syncResolutions = asyncHandler(async (req, res) => {
  // This would check for resolved markets in external sources
  logger.info("Admin triggered resolution sync");
  return response.success(res, null, "Resolution sync initiated");
});

module.exports = {
  getDashboard,
  getAnalytics,
  getRevenue,
  getPlatformStats,
  getUsers,
  getUserDetails,
  updateUser,
  suspendUser,
  unsuspendUser,
  banUser,
  unbanUser,
  adjustBalance,
  getAllMarkets,
  createMarket,
  updateMarket,
  resolveMarket,
  pauseMarket,
  unpauseMarket,
  resumeMarket,
  deleteMarket,
  addLiquidity,
  disputeMarket,
  getTransactions,
  getPendingWithdrawals,
  approveWithdrawal,
  rejectWithdrawal,
  getAuditLog,
  getRiskAlerts,
  getPlatformExposure,
  getSuspiciousActivity,
  getSettings,
  updateSettings,
  getLogs,
  syncMarkets,
  syncResolutions,
};
