/**
 * Bet Controller
 * Handles bet queries and settlement
 */

const Bet = require("../models/Bet");
const Market = require("../models/Market");
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const response = require("../utils/response");
const logger = require("../utils/logger");
const { asyncHandler } = require("../middleware/errorHandler");
const { signTransactionLog } = require("../utils/crypto");

/**
 * GET /api/bets
 * Get user's bets with filters
 */
const getUserBets = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, marketId, outcome, settled } = req.query;

  const query = { userId: req.userId };

  if (marketId) query.marketId = marketId;
  if (outcome) query.outcome = outcome;
  if (settled !== undefined) query.settled = settled === "true";

  const [bets, total] = await Promise.all([
    Bet.find(query)
      .populate("marketId", "question category outcome resolved")
      .sort({ createdAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean(),
    Bet.countDocuments(query),
  ]);

  return response.paginated(res, bets, parseInt(page), parseInt(limit), total);
});

/**
 * GET /api/bets/:betId
 * Get single bet details
 */
const getBet = asyncHandler(async (req, res) => {
  const { betId } = req.params;

  const bet = await Bet.findOne({ _id: betId, userId: req.userId })
    .populate("marketId")
    .populate("transactionId");

  if (!bet) {
    return response.notFound(res, "Bet");
  }

  return response.success(res, bet);
});

/**
 * POST /api/bets/claim/:marketId
 * Claim payout for all winning positions in a resolved market
 */
const claimPayout = asyncHandler(async (req, res) => {
  const { marketId } = req.params;
  const userId = req.userId;

  // Get market
  const market = await Market.findById(marketId);

  if (!market) {
    return response.notFound(res, "Market");
  }

  if (!market.resolved) {
    return response.error(res, "Market is not yet resolved", 400);
  }

  // Get user's unsettled bets in this market
  const bets = await Bet.find({
    userId,
    marketId,
    settled: false,
  });

  if (bets.length === 0) {
    return response.error(res, "No unsettled positions in this market", 400);
  }

  // Calculate total payout
  let totalPayout = 0;
  let totalProfit = 0;
  const settledBets = [];

  for (const bet of bets) {
    const won = bet.outcome === market.outcome;
    // Winners get shares value (1 per share), losers get 0
    const payout = won ? bet.shares : 0;
    const profitLoss = payout - bet.amountSpent;

    bet.settled = true;
    bet.settledAt = new Date();
    bet.payout = payout;
    bet.profitLoss = profitLoss;
    bet.won = won;

    await bet.save();

    totalPayout += payout;
    totalProfit += profitLoss;

    settledBets.push({
      betId: bet._id,
      outcome: bet.outcome,
      shares: bet.shares,
      amountSpent: bet.amountSpent,
      payout,
      profitLoss,
      won,
    });
  }

  // Update user balance and stats
  const user = await User.findById(userId);

  const updates = {
    $inc: {
      balance: totalPayout,
      withdrawable: totalPayout,
    },
  };

  if (totalProfit > 0) {
    updates.$inc.totalWon = totalProfit;
  } else {
    updates.$inc.totalLost = Math.abs(totalProfit);
  }

  await User.findByIdAndUpdate(userId, updates);

  // Create payout transaction
  const transaction = new Transaction({
    userId,
    type: "payout",
    amount: totalPayout,
    fee: 0,
    netAmount: totalPayout,
    status: "completed",
    marketId,
    balanceBefore: user.balance,
    balanceAfter: user.balance + totalPayout,
    description: `Payout for ${market.question}`,
    signature: signTransactionLog({
      userId,
      marketId,
      totalPayout,
      betsSettled: settledBets.length,
    }),
  });

  await transaction.save();

  logger.info(
    `Payout claimed: ${userId} received $${totalPayout} from market ${marketId}`,
  );

  return response.success(
    res,
    {
      totalPayout,
      totalProfit,
      settledBets,
      newBalance: user.balance + totalPayout,
    },
    "Payout claimed successfully",
  );
});

/**
 * GET /api/bets/settled
 * Get user's settlement history
 */
const getSettlementHistory = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;

  const [bets, total] = await Promise.all([
    Bet.find({ userId: req.userId, settled: true })
      .populate("marketId", "question category outcome resolvedAt")
      .sort({ settledAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean(),
    Bet.countDocuments({ userId: req.userId, settled: true }),
  ]);

  // Calculate summary
  const summary = bets.reduce(
    (acc, bet) => {
      acc.totalPayout += bet.payout || 0;
      acc.totalSpent += bet.amountSpent || 0;
      acc.wins += bet.won ? 1 : 0;
      acc.losses += !bet.won ? 1 : 0;
      return acc;
    },
    { totalPayout: 0, totalSpent: 0, wins: 0, losses: 0 },
  );

  summary.netProfit = summary.totalPayout - summary.totalSpent;
  summary.winRate = (summary.wins / (summary.wins + summary.losses)) * 100 || 0;

  return response.paginated(
    res,
    { bets, summary },
    parseInt(page),
    parseInt(limit),
    total,
  );
});

/**
 * GET /api/bets/pending-payouts
 * Get markets with unclaimed payouts
 */
const getPendingPayouts = asyncHandler(async (req, res) => {
  // Find resolved markets where user has unsettled bets
  const pendingBets = await Bet.aggregate([
    {
      $match: {
        userId: req.user._id,
        settled: false,
      },
    },
    {
      $lookup: {
        from: "markets",
        localField: "marketId",
        foreignField: "_id",
        as: "market",
      },
    },
    { $unwind: "$market" },
    {
      $match: { "market.resolved": true },
    },
    {
      $group: {
        _id: "$marketId",
        market: { $first: "$market" },
        totalShares: { $sum: "$shares" },
        totalSpent: { $sum: "$amountSpent" },
        betsCount: { $sum: 1 },
      },
    },
  ]);

  // Calculate potential payouts
  const pendingPayouts = pendingBets.map((item) => {
    const userBets = {
      YES: { shares: 0 },
      NO: { shares: 0 },
    };

    // This is simplified - in real implementation you'd need to track per-outcome
    const estimatedPayout =
      item.market.outcome === "YES" || item.market.outcome === "NO"
        ? item.totalShares // Assuming all bets are on the winning side for simplicity
        : 0;

    return {
      marketId: item._id,
      question: item.market.question,
      outcome: item.market.outcome,
      resolvedAt: item.market.resolvedAt,
      totalShares: item.totalShares,
      totalSpent: item.totalSpent,
      betsCount: item.betsCount,
      estimatedPayout,
    };
  });

  return response.success(res, pendingPayouts);
});

/**
 * GET /api/bets/market/:marketId
 * Get user's bets for specific market
 */
const getMarketBets = asyncHandler(async (req, res) => {
  const { marketId } = req.params;

  const bets = await Bet.find({
    userId: req.user._id,
    marketId,
  })
    .populate("marketId", "question outcome resolved")
    .sort({ createdAt: -1 })
    .lean();

  return response.success(res, bets);
});

/**
 * GET /api/bets/status/active
 * Get active (unresolved) bets
 */
const getActiveBets = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;

  const bets = await Bet.aggregate([
    { $match: { userId: req.user._id, settled: false } },
    {
      $lookup: {
        from: "markets",
        localField: "marketId",
        foreignField: "_id",
        as: "market",
      },
    },
    { $unwind: "$market" },
    { $match: { "market.resolved": false } },
    { $sort: { createdAt: -1 } },
    { $skip: (parseInt(page) - 1) * parseInt(limit) },
    { $limit: parseInt(limit) },
  ]);

  return response.success(res, bets);
});

/**
 * GET /api/bets/status/settled
 * Get settled bets
 */
const getSettledBets = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;

  const [bets, total] = await Promise.all([
    Bet.find({ userId: req.user._id, settled: true })
      .populate("marketId", "question category outcome")
      .sort({ settledAt: -1 })
      .skip((parseInt(page) - 1) * parseInt(limit))
      .limit(parseInt(limit))
      .lean(),
    Bet.countDocuments({ userId: req.user._id, settled: true }),
  ]);

  return response.paginated(res, bets, parseInt(page), parseInt(limit), total);
});

/**
 * GET /api/bets/status/won
 * Get winning bets
 */
const getWinningBets = asyncHandler(async (req, res) => {
  const bets = await Bet.find({
    userId: req.user._id,
    settled: true,
    won: true,
  })
    .populate("marketId", "question category outcome")
    .sort({ settledAt: -1 })
    .limit(50)
    .lean();

  const totalWinnings = bets.reduce(
    (sum, bet) => sum + (bet.profitLoss || 0),
    0,
  );

  return response.success(res, { bets, totalWinnings });
});

/**
 * GET /api/bets/status/lost
 * Get losing bets
 */
const getLosingBets = asyncHandler(async (req, res) => {
  const bets = await Bet.find({
    userId: req.user._id,
    settled: true,
    won: false,
  })
    .populate("marketId", "question category outcome")
    .sort({ settledAt: -1 })
    .limit(50)
    .lean();

  const totalLost = bets.reduce(
    (sum, bet) => sum + Math.abs(bet.profitLoss || 0),
    0,
  );

  return response.success(res, { bets, totalLost });
});

/**
 * POST /api/bets/:id/claim
 * Claim winnings from specific bet
 */
const claimWinnings = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const bet = await Bet.findOne({ _id: id, userId: req.user._id });

  if (!bet) {
    return response.notFound(res, "Bet");
  }

  if (bet.settled) {
    return response.error(res, "Bet already settled", 400);
  }

  const market = await Market.findById(bet.marketId);

  if (!market.resolved) {
    return response.error(res, "Market not yet resolved", 400);
  }

  const won = bet.outcome === market.outcome;
  const payout = won ? bet.shares : 0;
  const profitLoss = payout - bet.amountSpent;

  bet.settled = true;
  bet.settledAt = new Date();
  bet.payout = payout;
  bet.profitLoss = profitLoss;
  bet.won = won;
  await bet.save();

  // Update user balance
  if (payout > 0) {
    await User.findByIdAndUpdate(req.user._id, {
      $inc: {
        balance: payout,
        withdrawable: payout,
        totalWon: profitLoss > 0 ? profitLoss : 0,
      },
    });
  }

  return response.success(
    res,
    {
      bet,
      payout,
      profitLoss,
      won,
    },
    "Winnings claimed",
  );
});

/**
 * POST /api/bets/claim-all
 * Claim all available winnings
 */
const claimAllWinnings = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  // Find all unsettled bets in resolved markets
  const unsettledBets = await Bet.aggregate([
    { $match: { userId, settled: false } },
    {
      $lookup: {
        from: "markets",
        localField: "marketId",
        foreignField: "_id",
        as: "market",
      },
    },
    { $unwind: "$market" },
    { $match: { "market.resolved": true } },
  ]);

  if (unsettledBets.length === 0) {
    return response.error(res, "No winnings to claim", 400);
  }

  let totalPayout = 0;
  let totalProfit = 0;
  const settled = [];

  for (const betData of unsettledBets) {
    const won = betData.outcome === betData.market.outcome;
    const payout = won ? betData.shares : 0;
    const profitLoss = payout - betData.amountSpent;

    await Bet.findByIdAndUpdate(betData._id, {
      settled: true,
      settledAt: new Date(),
      payout,
      profitLoss,
      won,
    });

    totalPayout += payout;
    totalProfit += profitLoss;
    settled.push({
      betId: betData._id,
      marketId: betData.marketId,
      won,
      payout,
    });
  }

  // Update user balance
  await User.findByIdAndUpdate(userId, {
    $inc: {
      balance: totalPayout,
      withdrawable: totalPayout,
      totalWon: totalProfit > 0 ? totalProfit : 0,
    },
  });

  return response.success(
    res,
    {
      totalPayout,
      totalProfit,
      betsSettled: settled.length,
      settled,
    },
    "All winnings claimed",
  );
});

/**
 * GET /api/bets/stats/summary
 * Get betting summary/statistics
 */
const getBettingSummary = asyncHandler(async (req, res) => {
  const userId = req.user._id;

  const stats = await Bet.aggregate([
    { $match: { userId } },
    {
      $group: {
        _id: null,
        totalBets: { $sum: 1 },
        totalSpent: { $sum: "$amountSpent" },
        totalShares: { $sum: "$shares" },
        settledCount: { $sum: { $cond: ["$settled", 1, 0] } },
        winsCount: { $sum: { $cond: ["$won", 1, 0] } },
        totalPayout: { $sum: { $cond: ["$settled", "$payout", 0] } },
        totalProfit: { $sum: { $cond: ["$settled", "$profitLoss", 0] } },
      },
    },
  ]);

  const summary = stats[0] || {
    totalBets: 0,
    totalSpent: 0,
    totalShares: 0,
    settledCount: 0,
    winsCount: 0,
    totalPayout: 0,
    totalProfit: 0,
  };

  summary.winRate =
    summary.settledCount > 0
      ? ((summary.winsCount / summary.settledCount) * 100).toFixed(2)
      : 0;
  summary.avgBetSize =
    summary.totalBets > 0
      ? (summary.totalSpent / summary.totalBets).toFixed(2)
      : 0;
  summary.roi =
    summary.totalSpent > 0
      ? ((summary.totalProfit / summary.totalSpent) * 100).toFixed(2)
      : 0;

  return response.success(res, summary);
});

module.exports = {
  getUserBets,
  getBet,
  getMarketBets,
  getActiveBets,
  getSettledBets,
  getWinningBets,
  getLosingBets,
  claimWinnings,
  claimAllWinnings,
  claimPayout,
  getSettlementHistory,
  getPendingPayouts,
  getBettingSummary,
};
