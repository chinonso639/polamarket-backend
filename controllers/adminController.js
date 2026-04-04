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
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const [
    totalUsers,
    activeUsers,
    totalMarkets,
    activeMarkets,
    totalBets,
    pendingWithdrawals,
    totalVolumeAgg,
    revenueByType,
    todayRevenue,
    topMarkets,
    recentTransactions,
  ] = await Promise.all([
    User.countDocuments(),
    User.countDocuments({
      lastLogin: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
    }),
    Market.countDocuments(),
    Market.countDocuments({ resolved: false, paused: false }),
    Bet.countDocuments(),
    Transaction.countDocuments({ type: "withdrawal", status: "pending" }),
    Transaction.aggregate([
      {
        $match: {
          status: "completed",
          type: { $in: ["trade_buy", "trade_sell"] },
        },
      },
      { $group: { _id: null, total: { $sum: { $ifNull: ["$amount", 0] } } } },
    ]),
    Transaction.aggregate([
      {
        $match: {
          status: "completed",
          feeType: { $in: ["trading_fee", "withdrawal_fee", "deposit_fee"] },
        },
      },
      {
        $group: {
          _id: null,
          tradingFees: {
            $sum: {
              $cond: [
                { $eq: ["$feeType", "trading_fee"] },
                { $ifNull: ["$fee", 0] },
                0,
              ],
            },
          },
          spreadFees: { $sum: { $ifNull: ["$spreadFee", 0] } },
          withdrawalFees: {
            $sum: {
              $cond: [
                { $eq: ["$feeType", "withdrawal_fee"] },
                { $ifNull: ["$fee", 0] },
                0,
              ],
            },
          },
        },
      },
    ]),
    Transaction.aggregate([
      { $match: { status: "completed", createdAt: { $gte: todayStart } } },
      {
        $group: {
          _id: null,
          revenue: {
            $sum: {
              $add: [{ $ifNull: ["$fee", 0] }, { $ifNull: ["$spreadFee", 0] }],
            },
          },
          volume: { $sum: { $ifNull: ["$amount", 0] } },
        },
      },
    ]),
    Market.find()
      .sort({ totalFeesCollected: -1 })
      .limit(10)
      .select(
        "question totalFeesCollected totalSpreadCollected liquidity resolved",
      )
      .lean(),
    Transaction.find({ status: "completed" })
      .sort({ createdAt: -1 })
      .limit(15)
      .populate("userId", "username email")
      .select("type amount fee spreadFee netAmount feeType createdAt")
      .lean(),
  ]);

  const revenueAgg = revenueByType[0] || {
    tradingFees: 0,
    spreadFees: 0,
    withdrawalFees: 0,
  };
  const tradingFees = revenueAgg.tradingFees;
  const spreadFees = revenueAgg.spreadFees;
  const withdrawalFees = revenueAgg.withdrawalFees;
  const totalRevenue = tradingFees + spreadFees + withdrawalFees;
  const totalVolume = totalVolumeAgg[0]?.total || 0;

  const todayData = todayRevenue[0] || { revenue: 0, volume: 0 };

  return response.success(res, {
    stats: {
      users: { total: totalUsers, active: activeUsers },
      markets: { total: totalMarkets, active: activeMarkets },
      trading: { totalBets, totalVolume },
      pendingWithdrawals,
      totalRevenue,
      todayVolume: todayData.volume,
    },
    revenue: {
      total: totalRevenue,
      tradingFees,
      spreadFees,
      withdrawalFees,
      today: todayData.revenue,
      todayVolume: todayData.volume,
    },
    topMarkets,
    recentTransactions,
  });
});

/**
 * GET /api/admin/analytics
 * Get platform analytics
 */
const getAnalytics = asyncHandler(async (req, res) => {
  const { period = "30d" } = req.query;
  const days = period === "7d" ? 7 : period === "14d" ? 14 : 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  const [dailyRevenue, dailyUsers, dailyVolume, newMarkets, resolvedMarkets] =
    await Promise.all([
      Transaction.aggregate([
        { $match: { status: "completed", createdAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            revenue: {
              $sum: {
                $add: [
                  { $ifNull: ["$fee", 0] },
                  { $ifNull: ["$spreadFee", 0] },
                ],
              },
            },
            volume: { $sum: { $ifNull: ["$amount", 0] } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      User.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Bet.aggregate([
        { $match: { createdAt: { $gte: since } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            volume: { $sum: "$amount" },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      Market.countDocuments({ createdAt: { $gte: since } }),
      Market.countDocuments({ resolved: true, updatedAt: { $gte: since } }),
    ]);

  const totalRevenue = dailyRevenue.reduce((s, d) => s + d.revenue, 0);
  const totalVolume = dailyVolume.reduce((s, d) => s + d.volume, 0);
  const totalNewUsers = dailyUsers.reduce((s, d) => s + d.count, 0);

  return response.success(res, {
    period,
    revenue: { total: totalRevenue, daily: dailyRevenue },
    users: { new: totalNewUsers, daily: dailyUsers },
    volume: { total: totalVolume, daily: dailyVolume },
    markets: { created: newMarkets, resolved: resolvedMarkets },
  });
});

/**
 * GET /api/admin/revenue
 * Get revenue breakdown
 */
const getRevenue = asyncHandler(async (req, res) => {
  const { period = "30d" } = req.query;
  const days =
    period === "7d" ? 7 : period === "14d" ? 14 : period === "90d" ? 90 : 30;
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [periodAgg, dailySeries, todayData, allTimeAgg] = await Promise.all([
    Transaction.aggregate([
      {
        $match: {
          status: "completed",
          createdAt: { $gte: since },
          feeType: { $ne: "none" },
        },
      },
      {
        $group: {
          _id: null,
          tradingFees: {
            $sum: {
              $cond: [
                { $eq: ["$feeType", "trading_fee"] },
                { $ifNull: ["$fee", 0] },
                0,
              ],
            },
          },
          spreadFees: { $sum: { $ifNull: ["$spreadFee", 0] } },
          withdrawalFees: {
            $sum: {
              $cond: [
                { $eq: ["$feeType", "withdrawal_fee"] },
                { $ifNull: ["$fee", 0] },
                0,
              ],
            },
          },
        },
      },
    ]),
    Transaction.aggregate([
      { $match: { status: "completed", createdAt: { $gte: since } } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
          revenue: {
            $sum: {
              $add: [{ $ifNull: ["$fee", 0] }, { $ifNull: ["$spreadFee", 0] }],
            },
          },
          tradingFees: {
            $sum: {
              $cond: [
                { $eq: ["$feeType", "trading_fee"] },
                { $ifNull: ["$fee", 0] },
                0,
              ],
            },
          },
          spreadFees: { $sum: { $ifNull: ["$spreadFee", 0] } },
          withdrawalFees: {
            $sum: {
              $cond: [
                { $eq: ["$feeType", "withdrawal_fee"] },
                { $ifNull: ["$fee", 0] },
                0,
              ],
            },
          },
          volume: { $sum: { $ifNull: ["$amount", 0] } },
        },
      },
      { $sort: { _id: 1 } },
    ]),
    Transaction.aggregate([
      { $match: { status: "completed", createdAt: { $gte: todayStart } } },
      {
        $group: {
          _id: null,
          tradingFees: {
            $sum: {
              $cond: [
                { $eq: ["$feeType", "trading_fee"] },
                { $ifNull: ["$fee", 0] },
                0,
              ],
            },
          },
          spreadFees: { $sum: { $ifNull: ["$spreadFee", 0] } },
          withdrawalFees: {
            $sum: {
              $cond: [
                { $eq: ["$feeType", "withdrawal_fee"] },
                { $ifNull: ["$fee", 0] },
                0,
              ],
            },
          },
          volume: { $sum: { $ifNull: ["$amount", 0] } },
        },
      },
    ]),
    Transaction.aggregate([
      { $match: { status: "completed", feeType: { $ne: "none" } } },
      {
        $group: {
          _id: null,
          tradingFees: {
            $sum: {
              $cond: [
                { $eq: ["$feeType", "trading_fee"] },
                { $ifNull: ["$fee", 0] },
                0,
              ],
            },
          },
          spreadFees: { $sum: { $ifNull: ["$spreadFee", 0] } },
          withdrawalFees: {
            $sum: {
              $cond: [
                { $eq: ["$feeType", "withdrawal_fee"] },
                { $ifNull: ["$fee", 0] },
                0,
              ],
            },
          },
        },
      },
    ]),
  ]);

  const p = periodAgg[0] || {
    tradingFees: 0,
    spreadFees: 0,
    withdrawalFees: 0,
  };
  const a = allTimeAgg[0] || {
    tradingFees: 0,
    spreadFees: 0,
    withdrawalFees: 0,
  };

  const periodTotal = p.tradingFees + p.spreadFees + p.withdrawalFees;
  const allTimeTotal = a.tradingFees + a.spreadFees + a.withdrawalFees;

  const t = todayData[0] || {
    tradingFees: 0,
    spreadFees: 0,
    withdrawalFees: 0,
    volume: 0,
  };

  return response.success(res, {
    period,
    total: periodTotal,
    tradingFees: p.tradingFees,
    spreadFees: p.spreadFees,
    withdrawalFees: p.withdrawalFees,
    today: {
      total: t.tradingFees + t.spreadFees + t.withdrawalFees,
      tradingFees: t.tradingFees,
      spreadFees: t.spreadFees,
      withdrawalFees: t.withdrawalFees,
    },
    todayVolume: t.volume,
    allTime: {
      total: allTimeTotal,
      tradingFees: a.tradingFees,
      spreadFees: a.spreadFees,
      withdrawalFees: a.withdrawalFees,
    },
    daily: dailySeries,
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
 * Resolve market and settle all open bets
 */
const resolveMarket = asyncHandler(async (req, res) => {
  const { outcome } = req.body;
  if (!outcome || !["YES", "NO"].includes(outcome.toUpperCase())) {
    return response.error(res, "outcome must be YES or NO", 400);
  }
  const upperOutcome = outcome.toUpperCase();

  const market = await Market.findByIdAndUpdate(
    req.params.id,
    {
      resolved: true,
      outcome: upperOutcome,
      resolvedAt: new Date(),
      isTradingActive: false,
      resolutionSource: "admin",
    },
    { new: true },
  );

  if (!market) {
    return response.notFound(res, "Market");
  }

  // Settle all open bets and credit users
  const { settleResolvedMarketBets } = require("../oracles/subgraphOracle");
  await settleResolvedMarketBets(market._id, upperOutcome, market.question);

  logger.info(`Admin resolved market: ${market.question} -> ${upperOutcome}`);
  return response.success(res, { market }, "Market resolved and bets settled");
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
