/**
 * User Controller
 * Handles user profile, balance, and positions
 */

const User = require("../models/User");
const Bet = require("../models/Bet");
const Transaction = require("../models/Transaction");
const { getPrices } = require("../amm/lmsr");
const response = require("../utils/response");
const logger = require("../utils/logger");
const { asyncHandler } = require("../middleware/errorHandler");

/**
 * GET /api/users/profile
 * Get user profile
 */
const getProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId);

  if (!user) {
    return response.notFound(res, "User");
  }

  return response.success(res, {
    user: user.toSafeObject(),
  });
});

/**
 * PUT /api/users/profile
 * Update user profile
 */
const updateProfile = asyncHandler(async (req, res) => {
  const allowedFields = ["username", "displayName", "avatar", "preferences"];
  const updates = {};

  allowedFields.forEach((field) => {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field];
    }
  });

  const user = await User.findByIdAndUpdate(req.userId, updates, {
    new: true,
    runValidators: true,
  });

  if (!user) {
    return response.notFound(res, "User");
  }

  logger.info(`User profile updated: ${user.email}`);

  return response.success(
    res,
    { user: user.toSafeObject() },
    "Profile updated",
  );
});

/**
 * GET /api/users/balance
 * Get user balance details
 */
const getBalance = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId).select(
    "balance withdrawable lockedBalance",
  );

  if (!user) {
    return response.notFound(res, "User");
  }

  return response.success(res, {
    balance: user.balance,
    withdrawable: user.withdrawable,
    lockedBalance: user.lockedBalance,
    available: user.balance - user.lockedBalance,
  });
});

/**
 * GET /api/users/positions
 * Get all user positions across markets
 */
const getPositions = asyncHandler(async (req, res) => {
  const { status = "active" } = req.query;

  const query = { userId: req.userId };

  if (status === "active") {
    query.settled = false;
  } else if (status === "settled") {
    query.settled = true;
  }

  const positions = await Bet.find(query)
    .populate(
      "marketId",
      "question category outcome resolved qYes qNo b endDate outcomeStates slug externalId conditionId",
    )
    .sort({ createdAt: -1 })
    .lean();

  // Add current value to each position
  const positionsWithValue = positions.map((pos) => {
    if (pos.marketId) {
      const prices = getPrices(pos.marketId);
      const currentPrice = prices.outcomePrices?.[pos.outcome] ?? 0;

      return {
        ...pos,
        currentPrice,
        currentValue: pos.shares * currentPrice,
        unrealizedPnL: pos.shares * currentPrice - pos.amountSpent,
      };
    }
    return pos;
  });

  // Calculate totals
  const totals = positionsWithValue.reduce(
    (acc, pos) => {
      acc.totalInvested += pos.amountSpent || 0;
      acc.totalCurrentValue += pos.currentValue || 0;
      return acc;
    },
    { totalInvested: 0, totalCurrentValue: 0 },
  );

  totals.totalUnrealizedPnL = totals.totalCurrentValue - totals.totalInvested;

  return response.success(res, {
    positions: positionsWithValue,
    totals,
  });
});

/**
 * GET /api/users/positions/:marketId
 * Get user position in a specific market
 */
const getPositionInMarket = asyncHandler(async (req, res) => {
  const { marketId } = req.params;

  const position = await Bet.getUserPosition(req.userId, marketId);

  return response.success(res, position);
});

/**
 * GET /api/users/transactions
 * Get user transaction history
 */
const getTransactions = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, type, status } = req.query;

  const options = {
    limit: parseInt(limit),
    skip: (parseInt(page) - 1) * parseInt(limit),
  };

  if (type) options.type = type;
  if (status) options.status = status;

  const [transactions, total] = await Promise.all([
    Transaction.getUserHistory(req.userId, options),
    Transaction.countDocuments({
      userId: req.userId,
      ...(type && { type }),
      ...(status && { status }),
    }),
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
 * GET /api/users/stats
 * Get user trading statistics
 */
const getStats = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId).select(
    "totalDeposited totalWithdrawn totalWagered totalWon totalLost tradesCount",
  );

  if (!user) {
    return response.notFound(res, "User");
  }

  // Get additional stats from bets
  const betStats = await Bet.aggregate([
    { $match: { userId: user._id } },
    {
      $group: {
        _id: null,
        totalBets: { $sum: 1 },
        activeBets: {
          $sum: { $cond: [{ $eq: ["$settled", false] }, 1, 0] },
        },
        settledBets: {
          $sum: { $cond: [{ $eq: ["$settled", true] }, 1, 0] },
        },
        totalShares: { $sum: "$shares" },
        avgBetSize: { $avg: "$amountSpent" },
      },
    },
  ]);

  const stats = betStats[0] || {
    totalBets: 0,
    activeBets: 0,
    settledBets: 0,
    totalShares: 0,
    avgBetSize: 0,
  };

  return response.success(res, {
    ...user.toObject(),
    profitLoss: user.totalWon - user.totalLost,
    winRate:
      user.totalWon + user.totalLost > 0
        ? (user.totalWon / (user.totalWon + user.totalLost)) * 100
        : 0,
    ...stats,
  });
});

/**
 * GET /api/users/leaderboard
 * Get trading leaderboard
 */
const getLeaderboard = asyncHandler(async (req, res) => {
  const { period = "all", limit = 100 } = req.query;

  let dateFilter = {};

  switch (period) {
    case "day":
      dateFilter = {
        createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
      };
      break;
    case "week":
      dateFilter = {
        createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      };
      break;
    case "month":
      dateFilter = {
        createdAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      };
      break;
  }

  const leaderboard = await User.find({
    isActive: true,
    isBanned: false,
    totalWagered: { $gt: 0 },
  })
    .select("username totalWagered totalWon totalLost tradesCount")
    .sort({ totalWon: -1 })
    .limit(parseInt(limit))
    .lean();

  const ranked = leaderboard.map((user, index) => ({
    rank: index + 1,
    username: user.username || `User${user._id.toString().slice(-6)}`,
    totalWagered: user.totalWagered,
    profitLoss: user.totalWon - user.totalLost,
    tradesCount: user.tradesCount,
    winRate:
      user.totalWon + user.totalLost > 0
        ? ((user.totalWon / (user.totalWon + user.totalLost)) * 100).toFixed(2)
        : 0,
  }));

  return response.success(res, ranked);
});

/**
 * GET /api/users/positions/:marketId
 * Alias for getPositionInMarket
 */
const getMarketPosition = getPositionInMarket;

/**
 * GET /api/users/bets
 * Get user bet history
 */
const getBetHistory = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;

  const bets = await Bet.find({ userId: req.userId })
    .populate("marketId", "question category status")
    .sort({ createdAt: -1 })
    .skip((page - 1) * limit)
    .limit(parseInt(limit))
    .lean();

  const total = await Bet.countDocuments({ userId: req.userId });

  return response.paginated(res, bets, parseInt(page), parseInt(limit), total);
});

/**
 * GET /api/users/notifications
 * Get user notifications (stub)
 */
const getNotifications = asyncHandler(async (req, res) => {
  // TODO: Implement notifications collection
  return response.success(res, { notifications: [], unreadCount: 0 });
});

/**
 * PUT /api/users/notifications/:id/read
 * Mark notification as read (stub)
 */
const markNotificationRead = asyncHandler(async (req, res) => {
  // TODO: Implement
  return response.success(res, null, "Notification marked as read");
});

/**
 * PUT /api/users/notifications/read-all
 * Mark all notifications as read (stub)
 */
const markAllNotificationsRead = asyncHandler(async (req, res) => {
  // TODO: Implement
  return response.success(res, null, "All notifications marked as read");
});

/**
 * GET /api/users/preferences
 * Get user preferences
 */
const getPreferences = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId).select("preferences");

  if (!user) {
    return response.notFound(res, "User");
  }

  return response.success(res, { preferences: user.preferences || {} });
});

/**
 * PUT /api/users/preferences
 * Update user preferences
 */
const updatePreferences = asyncHandler(async (req, res) => {
  const user = await User.findByIdAndUpdate(
    req.userId,
    { preferences: req.body },
    { new: true },
  ).select("preferences");

  if (!user) {
    return response.notFound(res, "User");
  }

  return response.success(
    res,
    { preferences: user.preferences },
    "Preferences updated",
  );
});

/**
 * GET /api/users/referrals
 * Get referral info
 */
const getReferralInfo = asyncHandler(async (req, res) => {
  const user = await User.findById(req.userId).select(
    "referralCode referredBy",
  );

  if (!user) {
    return response.notFound(res, "User");
  }

  // Count referrals
  const referralCount = await User.countDocuments({ referredBy: user._id });

  return response.success(res, {
    referralCode:
      user.referralCode || user._id.toString().slice(-8).toUpperCase(),
    referralCount,
    referralRewards: 0, // TODO: Calculate actual rewards
  });
});

/**
 * GET /api/users/public/:userId
 * Get public profile
 */
const getPublicProfile = asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.userId)
    .select(
      "username avatar totalWagered totalWon totalLost tradesCount createdAt",
    )
    .lean();

  if (!user || user.isActive === false) {
    return response.notFound(res, "User");
  }

  return response.success(res, {
    username: user.username || `User${user._id.toString().slice(-6)}`,
    avatar: user.avatar,
    stats: {
      totalWagered: user.totalWagered || 0,
      profitLoss: (user.totalWon || 0) - (user.totalLost || 0),
      tradesCount: user.tradesCount || 0,
    },
    joinedAt: user.createdAt,
  });
});

/**
 * PUT /api/users/wallet
 * Update user wallet address
 */
const updateWallet = asyncHandler(async (req, res) => {
  const { walletAddress } = req.body;

  // Validate Ethereum address format
  if (!/^0x[a-fA-F0-9]{40}$/.test(walletAddress)) {
    return response.error(res, "Invalid wallet address format", 400);
  }

  const user = await User.findByIdAndUpdate(
    req.userId,
    { walletAddress },
    { new: true },
  );

  if (!user) {
    return response.notFound(res, "User");
  }

  logger.info(`User updated wallet: ${user.email} -> ${walletAddress}`);

  return response.success(
    res,
    {
      walletAddress: user.walletAddress,
    },
    "Wallet address updated",
  );
});

module.exports = {
  getProfile,
  updateProfile,
  getBalance,
  getPositions,
  getPositionInMarket,
  getMarketPosition,
  getBetHistory,
  getTransactions,
  getStats,
  getNotifications,
  markNotificationRead,
  markAllNotificationsRead,
  getPreferences,
  updatePreferences,
  getReferralInfo,
  getPublicProfile,
  getLeaderboard,
  updateWallet,
};
