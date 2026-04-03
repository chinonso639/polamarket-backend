/**
 * Market Controller
 * Handles market CRUD operations and AMM trading
 */

const Market = require("../models/Market");
const Bet = require("../models/Bet");
const Transaction = require("../models/Transaction");
const User = require("../models/User");
const axios = require("axios");
const {
  getPrices,
  buyYes,
  buyNo,
  calculateSlippage,
  calculateSharesForCost,
  calculateCostForShares,
  sellShares: lmsrSellShares,
  normalizeExternalLiquidity,
} = require("../amm/lmsr");
const { assessTradeRisk } = require("../amm/riskManager");
const response = require("../utils/response");
const logger = require("../utils/logger");
const { asyncHandler } = require("../middleware/errorHandler");
const { cache, CACHE_KEYS, invalidateMarket } = require("../utils/cache");
const { recordTrade } = require("../middleware/rateLimiter");
const {
  signTransactionLog,
  generateTransactionId,
} = require("../utils/crypto");
const {
  emitPriceUpdate,
  emitTrade,
  emitMarketUpdate,
  emitMarketResolved,
} = require("../services/socketService");

/**
 * GET /api/markets
 * Get all active markets with pagination and filters
 */
const getMarkets = asyncHandler(async (req, res) => {
  const {
    page = 1,
    limit = 20,
    category,
    status,
    sortBy = "totalVolume",
    sortOrder = "desc",
  } = req.query;

  // Build query
  const query = {};

  if (category) {
    query.category = category;
  }

  if (status) {
    switch (status) {
      case "active":
        query.resolved = false;
        query.isTradingActive = true;
        query.endDate = { $gt: new Date() };
        break;
      case "resolved":
        query.resolved = true;
        break;
      case "expired":
        query.resolved = false;
        query.endDate = { $lte: new Date() };
        break;
    }
  }

  // Get total count and markets
  const [total, markets] = await Promise.all([
    Market.countDocuments(query),
    Market.find(query)
      .sort({ [sortBy]: sortOrder === "desc" ? -1 : 1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean(),
  ]);

  // Add computed prices to each market
  const marketsWithPrices = markets.map((market) => ({
    ...market,
    ...getPrices(market),
  }));

  return response.paginated(
    res,
    marketsWithPrices,
    parseInt(page),
    parseInt(limit),
    total,
  );
});

/**
 * GET /api/markets/trending
 * Get trending markets by volume
 */
const getTrendingMarkets = asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 10;

  const markets = await Market.findTrending(limit).lean();

  const marketsWithPrices = markets.map((market) => ({
    ...market,
    ...getPrices(market),
  }));

  return response.success(res, marketsWithPrices);
});

/**
 * GET /api/markets/:marketId
 * Get single market details with prices
 */
const getMarket = asyncHandler(async (req, res) => {
  const { id: marketId } = req.params;

  const market = await Market.findById(marketId).lean();

  if (!market) {
    return response.notFound(res, "Market");
  }

  // Get position summary
  const positionSummary = await Bet.getMarketPositionSummary(marketId);

  // Calculate prices
  const prices = getPrices(market);

  return response.success(res, {
    ...market,
    ...prices,
    positionSummary,
  });
});

/**
 * GET /api/markets/:marketId/prices
 * Get current market prices (cached)
 */
const getMarketPrices = asyncHandler(async (req, res) => {
  const { id: marketId } = req.params;

  const market = await Market.findById(marketId).select("qYes qNo b").lean();

  if (!market) {
    return response.notFound(res, "Market");
  }

  const prices = getPrices(market);

  return response.success(res, prices);
});

/**
 * POST /api/markets
 * Create a new market (admin only)
 */
const createMarket = asyncHandler(async (req, res) => {
  const {
    question,
    description,
    category,
    endDate,
    b,
    feeRate,
    imageUrl,
    tags,
  } = req.body;

  // Calculate initial liquidity parameter if not provided
  const liquidityParam =
    b || parseInt(process.env.DEFAULT_LIQUIDITY_PARAMETER) || 100;

  const market = new Market({
    question,
    description,
    category,
    endDate,
    b: liquidityParam,
    feeRate: feeRate || 0.02,
    imageUrl,
    tags,
    createdBy: req.userId,
    virtualLiquidityBuffer: liquidityParam * 10, // Initial virtual liquidity
  });

  await market.save();

  logger.info(`Market created: ${market.question} by ${req.userId}`);

  return response.created(
    res,
    {
      ...market.toObject(),
      ...getPrices(market),
    },
    "Market created successfully",
  );
});

/**
 * POST /api/markets/:marketId/trade
 * Execute a trade (buy YES or NO shares)
 */

const GAMMA_API_URL =
  process.env.GAMMA_API_URL || "https://gamma-api.polymarket.com";

/**
 * Returns a local Market document, auto-creating one from Gamma data if needed.
 * Lookup order:
 *   1. MongoDB by _id (works for locally-created markets)
 *   2. MongoDB by externalId (Gamma markets already imported)
 *   3. Gamma API fetch → create local AMM market with LMSR params seeded from Gamma prices
 */
const ensureMarket = async (marketId) => {
  // 1. Try direct ObjectId lookup (throws if invalid ObjectId format)
  try {
    const m = await Market.findById(marketId);
    if (m) return m;
  } catch (_) {
    // Not a valid ObjectId — continue to external lookups
  }

  // 2. Already imported from Gamma?
  const existing = await Market.findOne({ externalId: marketId });
  if (existing) return existing;

  // 3. Fetch from Gamma and auto-create
  const { data: raw } = await axios.get(
    `${GAMMA_API_URL}/markets/${marketId}`,
    {
      timeout: 10000,
    },
  );
  // Gamma may return a single object or an array
  const gm = Array.isArray(raw) ? raw[0] : raw;
  if (!gm || !gm.question) return null;

  // Resolve prices from Gamma tokens or outcomePrices
  let yesPrice = 0.5;
  let noPrice = 0.5;
  const tokens = gm.tokens || [];
  if (tokens.length >= 2) {
    const yT = tokens.find((t) => t.outcome === "Yes");
    const nT = tokens.find((t) => t.outcome === "No");
    yesPrice = parseFloat(yT?.price ?? 0.5);
    noPrice = parseFloat(nT?.price ?? 0.5);
  } else if (gm.outcomePrices) {
    try {
      const p = JSON.parse(gm.outcomePrices);
      yesPrice = parseFloat(p[0]) || 0.5;
      noPrice = parseFloat(p[1]) || 0.5;
    } catch (_) {}
  }
  // Normalise so they sum to 1
  const total = yesPrice + noPrice || 1;
  yesPrice = Math.max(0.01, Math.min(0.99, yesPrice / total));
  noPrice = Math.max(0.01, Math.min(0.99, noPrice / total));

  // Derive LMSR 'b' from Gamma liquidity/volume
  const extLiq = parseFloat(gm.liquidity || gm.liquidityNum || 10000);
  const extVol = parseFloat(gm.volume || gm.volumeNum || 1000);
  const b = Math.max(
    50,
    Math.min(5000, normalizeExternalLiquidity(extLiq, extVol)),
  );

  // Initialise qYes / qNo so LMSR produces the correct Gamma prices.
  // Shift so the smaller value = 0 (both stay >= 0, satisfying schema min:0).
  const minP = Math.min(yesPrice, noPrice);
  const qYes = b * Math.log(yesPrice / minP); // >= 0
  const qNo = b * Math.log(noPrice / minP); // >= 0 (one will be 0)

  // Always use a future endDate for our local AMM — Gamma's resolution dates
  // are often in the past, which would make canTrade() return "expired".
  const endDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

  const tagList = (gm.tags || [])
    .map((t) => (typeof t === "string" ? t : t.label || t.name || ""))
    .filter(Boolean);

  const newMarket = await Market.create({
    question: gm.question || gm.title || "Market",
    description: gm.description || "",
    category: "other",
    endDate,
    qYes,
    qNo,
    b,
    yesPool: extLiq * yesPrice,
    noPool: extLiq * noPrice,
    virtualLiquidityBuffer: b * 10,
    totalVolume: extVol,
    externalId: gm.id || gm.condition_id || marketId,
    conditionId: gm.conditionId || gm.condition_id || "",
    externalSource: "gamma",
    imageUrl: gm.image || gm.icon || null,
    tags: tagList,
  });

  logger.info(
    `Auto-created local market for Gamma ID ${marketId}: ${newMarket._id}`,
  );
  return newMarket;
};

const executeTrade = asyncHandler(async (req, res) => {
  const { id: marketId } = req.params;
  const { outcome, amount, maxSlippage = 0.1 } = req.body;
  const userId = req.userId;

  // Get market (auto-create from Gamma if it doesn't exist locally) and user
  const [market, user] = await Promise.all([
    ensureMarket(marketId),
    User.findById(userId),
  ]);

  if (!market) {
    return response.notFound(res, "Market");
  }

  // Use the actual MongoDB _id for all subsequent operations
  const localMarketId = market._id;

  // Check if market allows trading
  const canTrade = market.canTrade();
  if (!canTrade.allowed) {
    return response.error(res, canTrade.reason, 400);
  }

  // Check user balance
  if (user.balance < amount) {
    return response.error(res, "Insufficient balance", 400);
  }

  // Get user's existing position
  const existingPosition = await Bet.getUserPosition(userId, localMarketId);

  // Get recent trades for risk assessment
  const recentTrades = await Bet.find({
    userId,
    marketId: localMarketId,
    createdAt: { $gt: new Date(Date.now() - 60000) }, // Last minute
  }).lean();

  // Assess trade risk
  const riskAssessment = assessTradeRisk({
    user,
    market,
    outcome,
    amount,
    existingPosition: existingPosition[outcome],
    recentTrades,
  });

  if (!riskAssessment.allowed) {
    return response.error(res, riskAssessment.reason, 400, {
      code: riskAssessment.code,
      waitTime: riskAssessment.waitTime,
    });
  }

  // Apply dynamic fee if adjusted
  const effectiveFeeRate = riskAssessment.adjustments.feeRate || market.feeRate;
  const marketWithFee = { ...market.toObject(), feeRate: effectiveFeeRate };

  // Execute trade based on outcome
  let tradeResult;
  try {
    if (outcome === "YES") {
      tradeResult = buyYes(marketWithFee, amount, { maxSlippage });
    } else {
      tradeResult = buyNo(marketWithFee, amount, { maxSlippage });
    }
  } catch (error) {
    return response.error(res, error.message, 400);
  }

  const persistTrade = async (session = null) => {
    const updateOptions = session ? { session } : {};

    // Update market state
    await Market.findByIdAndUpdate(
      localMarketId,
      {
        $set: {
          qYes: tradeResult.marketUpdate.qYes,
          qNo: tradeResult.marketUpdate.qNo,
          yesPool: tradeResult.marketUpdate.yesPool || market.yesPool,
          noPool: tradeResult.marketUpdate.noPool || market.noPool,
        },
        $inc: {
          totalFeesCollected: tradeResult.fee,
          totalVolume: amount,
          totalTrades: 1,
          settlementPool: tradeResult.amountAfterFee,
        },
      },
      updateOptions,
    );

    // Deduct from user balance
    await User.findByIdAndUpdate(
      userId,
      {
        $inc: {
          balance: -amount,
          totalWagered: amount,
        },
        $set: { lastTradeAt: new Date() },
      },
      updateOptions,
    );

    // Create bet record
    const bet = new Bet({
      userId,
      marketId: localMarketId,
      outcome,
      shares: tradeResult.shares,
      amountSpent: amount,
      avgPrice: tradeResult.avgPrice,
      entryPrice: tradeResult.entryPrice,
      feePaid: tradeResult.fee,
      executionDetails: {
        priceBeforeTrade:
          tradeResult.pricesBefore[outcome.toLowerCase() + "Price"],
        priceAfterTrade:
          tradeResult.pricesAfter[outcome.toLowerCase() + "Price"],
        slippage: tradeResult.slippage,
        qYesBefore: market.qYes,
        qNoBefore: market.qNo,
        qYesAfter: tradeResult.marketUpdate.qYes,
        qNoAfter: tradeResult.marketUpdate.qNo,
        bParameter: market.b,
      },
    });
    if (session) {
      await bet.save({ session });
    } else {
      await bet.save();
    }

    // Create transaction record
    const transaction = new Transaction({
      userId,
      type: "trade_buy",
      amount,
      fee: tradeResult.fee,
      netAmount: tradeResult.amountAfterFee,
      status: "completed",
      marketId: localMarketId,
      betId: bet._id,
      balanceBefore: user.balance,
      balanceAfter: user.balance - amount,
      tradeDetails: {
        outcome,
        shares: tradeResult.shares,
        pricePerShare: tradeResult.avgPrice,
        slippage: tradeResult.slippage,
        qYesBefore: market.qYes,
        qNoBefore: market.qNo,
        qYesAfter: tradeResult.marketUpdate.qYes,
        qNoAfter: tradeResult.marketUpdate.qNo,
      },
      ipAddress: req.ip,
      userAgent: req.headers["user-agent"],
      signature: signTransactionLog({
        userId,
        marketId: localMarketId,
        outcome,
        amount,
        shares: tradeResult.shares,
      }),
    });
    if (session) {
      await transaction.save({ session });
    } else {
      await transaction.save();
    }
  };

  let session;
  try {
    session = await Market.startSession();
    await session.withTransaction(async () => {
      await persistTrade(session);
    });
  } catch (error) {
    const message = error?.message || "";
    const transactionsUnsupported =
      message.includes("replica set member") ||
      message.includes("Transaction numbers are only allowed") ||
      message.includes("Standalone servers do not support transactions");

    if (!transactionsUnsupported) {
      logger.error("Trade execution failed:", error);
      throw error;
    }

    logger.warn(
      "MongoDB transactions unavailable; retrying trade execution without transaction",
    );
    await persistTrade(null);
  } finally {
    if (session) {
      session.endSession();
    }
  }

  try {
    // Record trade for cooldown
    recordTrade(userId);

    // Invalidate cache
    invalidateMarket(localMarketId);

    // Emit Socket.io events (to both individual market room and all markets room)
    emitPriceUpdate(localMarketId, {
      yesPrice: tradeResult.pricesAfter.yes,
      noPrice: tradeResult.pricesAfter.no,
      volume: market.totalVolume + amount,
    });

    emitTrade(localMarketId, {
      outcome,
      amount,
      shares: tradeResult.shares,
      newPrices: tradeResult.pricesAfter,
    });

    logger.info(
      `Trade executed: ${userId} bought ${tradeResult.shares.toFixed(4)} ${outcome} for $${amount}`,
    );

    return response.tradeSuccess(res, {
      ...tradeResult,
      warnings: riskAssessment.warnings,
    });
  } catch (error) {
    logger.error("Trade execution failed:", error);
    throw error;
  }
});

/**
 * GET /api/markets/:marketId/slippage
 * Preview slippage for a trade
 */
const previewSlippage = asyncHandler(async (req, res) => {
  const { id: marketId } = req.params;
  const { outcome, amount } = req.query;

  const market = await Market.findById(marketId).lean();

  if (!market) {
    return response.notFound(res, "Market");
  }

  const slippageInfo = calculateSlippage(market, outcome, parseFloat(amount));

  return response.success(res, slippageInfo);
});

/**
 * POST /api/markets/:marketId/resolve
 * Resolve a market (admin only)
 */
const resolveMarket = asyncHandler(async (req, res) => {
  const { id: marketId } = req.params;
  const { outcome, resolutionSource } = req.body;

  if (!["YES", "NO"].includes(outcome)) {
    return response.error(res, "Outcome must be YES or NO", 400);
  }

  const market = await Market.findById(marketId);

  if (!market) {
    return response.notFound(res, "Market");
  }

  if (market.resolved) {
    return response.error(res, "Market already resolved", 400);
  }

  // Freeze trading immediately
  market.isTradingActive = false;
  market.resolved = true;
  market.outcome = outcome;
  market.resolutionSource = resolutionSource;
  market.resolvedAt = new Date();
  market.resolvedBy = req.userId;

  await market.save();

  // Emit resolution event (to both individual market room and all markets room)
  emitMarketResolved(marketId, outcome);

  logger.info(`Market resolved: ${marketId} -> ${outcome}`);

  // Invalidate cache
  invalidateMarket(marketId);

  return response.success(res, market, "Market resolved successfully");
});

/**
 * PUT /api/markets/:marketId
 * Update market (admin only)
 */
const updateMarket = asyncHandler(async (req, res) => {
  const { id: marketId } = req.params;
  const allowedUpdates = [
    "description",
    "category",
    "endDate",
    "imageUrl",
    "tags",
    "isTradingActive",
  ];

  const updates = {};
  for (const field of allowedUpdates) {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field];
    }
  }

  const market = await Market.findByIdAndUpdate(
    marketId,
    { $set: updates, lastModifiedBy: req.userId },
    { new: true, runValidators: true },
  );

  if (!market) {
    return response.notFound(res, "Market");
  }

  invalidateMarket(marketId);

  return response.success(
    res,
    {
      ...market.toObject(),
      ...getPrices(market),
    },
    "Market updated",
  );
});

/**
 * GET /api/markets/featured
 * Get featured markets
 */
const getFeaturedMarkets = asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 6;

  const markets = await Market.find({
    resolved: false,
    isTradingActive: true,
    isFeatured: true,
    endDate: { $gt: new Date() },
  })
    .sort({ totalVolume: -1 })
    .limit(limit)
    .lean();

  const marketsWithPrices = markets.map((market) => ({
    ...market,
    ...getPrices(market),
  }));

  return response.success(res, marketsWithPrices);
});

/**
 * GET /api/markets/categories
 * Get available categories
 */
const getCategories = asyncHandler(async (req, res) => {
  const categories = await Market.aggregate([
    { $match: { resolved: false } },
    { $group: { _id: "$category", count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);

  const formatted = categories.map((c) => ({
    name: c._id,
    count: c.count,
  }));

  return response.success(res, formatted);
});

/**
 * GET /api/markets/search
 * Search markets
 */
const searchMarkets = asyncHandler(async (req, res) => {
  const { q, page = 1, limit = 20 } = req.query;

  if (!q || q.length < 2) {
    return response.error(
      res,
      "Search query must be at least 2 characters",
      400,
    );
  }

  const query = {
    $or: [
      { question: { $regex: q, $options: "i" } },
      { description: { $regex: q, $options: "i" } },
      { tags: { $in: [new RegExp(q, "i")] } },
    ],
  };

  const [markets, total] = await Promise.all([
    Market.find(query)
      .sort({ totalVolume: -1 })
      .skip((page - 1) * limit)
      .limit(parseInt(limit))
      .lean(),
    Market.countDocuments(query),
  ]);

  const marketsWithPrices = markets.map((market) => ({
    ...market,
    ...getPrices(market),
  }));

  return response.paginated(
    res,
    marketsWithPrices,
    parseInt(page),
    parseInt(limit),
    total,
  );
});

/**
 * GET /api/markets/:id/history
 * Get price history
 */
const getPriceHistory = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { period = "24h" } = req.query;

  const market = await Market.findById(id)
    .select("priceHistory question")
    .lean();

  if (!market) {
    return response.notFound(res, "Market");
  }

  // Filter based on period
  let cutoff = new Date();
  switch (period) {
    case "1h":
      cutoff.setHours(cutoff.getHours() - 1);
      break;
    case "24h":
      cutoff.setHours(cutoff.getHours() - 24);
      break;
    case "7d":
      cutoff.setDate(cutoff.getDate() - 7);
      break;
    case "30d":
      cutoff.setDate(cutoff.getDate() - 30);
      break;
    default:
      cutoff.setHours(cutoff.getHours() - 24);
  }

  const history = (market.priceHistory || []).filter(
    (h) => new Date(h.timestamp) >= cutoff,
  );

  return response.success(res, history);
});

/**
 * GET /api/markets/:id/orderbook
 * Get order book depth (simulated for AMM)
 */
const getOrderBook = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const market = await Market.findById(id).select("qYes qNo b").lean();

  if (!market) {
    return response.notFound(res, "Market");
  }

  const currentPrices = getPrices(market);

  // Generate simulated order book depth
  const depths = [10, 50, 100, 500, 1000];
  const bids = [];
  const asks = [];

  for (const amount of depths) {
    // Calculate price impact for YES buys (asks)
    const yesCost = calculateCostForShares(market, "YES", amount);
    const avgYesPrice = yesCost / amount;
    asks.push({ price: avgYesPrice.toFixed(4), size: amount });

    // Calculate price impact for NO buys (bids for YES)
    const noCost = calculateCostForShares(market, "NO", amount);
    const impliedYesBid = 1 - noCost / amount;
    bids.push({ price: Math.max(0, impliedYesBid).toFixed(4), size: amount });
  }

  return response.success(res, {
    currentPrice: currentPrices.yesPrice,
    bids: bids.reverse(),
    asks,
  });
});

/**
 * GET /api/markets/:id/trades
 * Get recent trades
 */
const getRecentTrades = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const limit = parseInt(req.query.limit) || 50;

  const trades = await Transaction.find({
    marketId: id,
    type: "BET",
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .select("amount outcome shares avgPrice createdAt")
    .lean();

  return response.success(res, trades);
});

/**
 * POST /api/markets/:id/quote
 * Get trade quote without executing
 */
const getQuote = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { outcome, amount } = req.body;

  if (!outcome || !amount) {
    return response.error(res, "Outcome and amount required", 400);
  }

  const market = await ensureMarket(id);

  if (!market) {
    return response.notFound(res, "Market");
  }

  const pricesBefore = getPrices(market);
  const feeRate = market.feeRate || 0.02;
  const amt = parseFloat(amount);
  const amountAfterFee = amt * (1 - feeRate);
  const { shares } = calculateSharesForCost(market, outcome, amountAfterFee);
  const fee = amt * feeRate;
  const avgPrice = amountAfterFee / shares;
  const slippageInfo = calculateSlippage(market, outcome, amt);

  return response.success(res, {
    outcome,
    shares,
    cost: amountAfterFee,
    fee,
    total: amt,
    avgPrice,
    slippage: slippageInfo.slippage,
    priceImpact: slippageInfo.priceImpact,
    currentPrice:
      outcome === "YES" ? pricesBefore.yesPrice : pricesBefore.noPrice,
    potentialReturn: shares,
    potentialProfit: shares - amt,
  });
});

/**
 * POST /api/markets/:id/sell
 * Sell shares
 */
const sellShares = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { outcome, shares } = req.body;
  const userId = req.userId;
  const normalizedOutcome = String(outcome || "").toUpperCase();
  const sellSharesAmount = parseFloat(shares);

  if (
    !["YES", "NO"].includes(normalizedOutcome) ||
    !sellSharesAmount ||
    sellSharesAmount <= 0
  ) {
    return response.error(res, "Valid outcome and shares required", 400);
  }

  const market = await Market.findById(id);

  if (!market || !market.isTradingActive || market.resolved) {
    return response.error(res, "Market not available for trading", 400);
  }

  // Check user's open lots for the selected outcome
  const openBets = await Bet.find({
    userId,
    marketId: market._id,
    outcome: normalizedOutcome,
    settled: false,
  }).sort({ createdAt: 1 });

  const availableShares = openBets.reduce(
    (sum, bet) => sum + (bet.shares || 0),
    0,
  );

  if (sellSharesAmount > availableShares) {
    return response.error(
      res,
      `Insufficient shares. Available: ${availableShares}`,
      400,
    );
  }

  // Calculate sell proceeds with LMSR helper
  const qYesBefore = market.qYes;
  const qNoBefore = market.qNo;
  const sellResult = lmsrSellShares(
    market,
    normalizedOutcome,
    sellSharesAmount,
  );
  const fee = sellResult.fee;
  const netProceeds = sellResult.netProceeds;
  const exitNetPrice = netProceeds / sellSharesAmount;

  // Update market state and accounting
  market.qYes = sellResult.marketUpdate.qYes;
  market.qNo = sellResult.marketUpdate.qNo;
  market.totalFeesCollected = (market.totalFeesCollected || 0) + fee;
  market.totalTrades = (market.totalTrades || 0) + 1;
  market.settlementPool = Math.max(
    0,
    (market.settlementPool || 0) - sellResult.grossProceeds,
  );

  await market.save();

  // Reduce user open lots FIFO and realize PnL
  let remainingToClose = sellSharesAmount;
  let realizedPnL = 0;

  for (const bet of openBets) {
    if (remainingToClose <= 0) break;

    const closeShares = Math.min(remainingToClose, bet.shares);
    const costPerShare = bet.shares > 0 ? bet.amountSpent / bet.shares : 0;
    const closedCostBasis = costPerShare * closeShares;
    const closedProceeds = exitNetPrice * closeShares;
    realizedPnL += closedProceeds - closedCostBasis;

    if (closeShares >= bet.shares) {
      await Bet.findByIdAndDelete(bet._id);
    } else {
      const nextShares = bet.shares - closeShares;
      const nextAmountSpent = Math.max(0, bet.amountSpent - closedCostBasis);
      bet.shares = nextShares;
      bet.amountSpent = nextAmountSpent;
      bet.avgPrice =
        nextShares > 0 ? nextAmountSpent / nextShares : bet.avgPrice;
      await bet.save();
    }

    remainingToClose -= closeShares;
  }

  const user = await User.findById(userId).select("balance");

  // Update user balance
  const userIncrements = {
    balance: netProceeds,
    withdrawable: netProceeds,
  };
  if (realizedPnL > 0) {
    userIncrements.totalWon = realizedPnL;
  } else if (realizedPnL < 0) {
    userIncrements.totalLost = Math.abs(realizedPnL);
  }

  await User.findByIdAndUpdate(userId, { $inc: userIncrements });

  // Record the sell
  const transaction = new Transaction({
    userId,
    type: "trade_sell",
    amount: sellResult.grossProceeds,
    fee,
    netAmount: netProceeds,
    marketId: id,
    balanceBefore: user?.balance || 0,
    balanceAfter: (user?.balance || 0) + netProceeds,
    status: "completed",
    tradeDetails: {
      outcome: normalizedOutcome,
      shares: sellSharesAmount,
      pricePerShare: sellResult.grossProceeds / sellSharesAmount,
      slippage: 0,
      qYesBefore,
      qNoBefore,
      qYesAfter: sellResult.marketUpdate.qYes,
      qNoAfter: sellResult.marketUpdate.qNo,
    },
    description: `Sold ${sellSharesAmount} ${normalizedOutcome} shares`,
  });

  await transaction.save();

  logger.info(
    `Sell: User ${userId} sold ${sellSharesAmount} ${normalizedOutcome} shares for $${netProceeds}`,
  );

  return response.success(
    res,
    {
      shares: sellSharesAmount,
      proceeds: sellResult.grossProceeds,
      fee,
      netProceeds,
      realizedPnL,
      newPrices: getPrices(market),
    },
    "Shares sold successfully",
  );
});

/**
 * POST /api/markets/:id/pause
 * Toggle trading pause
 */
const toggleTradingPause = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const market = await Market.findById(id);

  if (!market) {
    return response.notFound(res, "Market");
  }

  market.isTradingActive = !market.isTradingActive;
  await market.save();

  invalidateMarket(id);

  logger.info(
    `Market ${id} trading ${market.isTradingActive ? "resumed" : "paused"}`,
  );

  return response.success(
    res,
    {
      isTradingActive: market.isTradingActive,
    },
    `Trading ${market.isTradingActive ? "resumed" : "paused"}`,
  );
});

module.exports = {
  getAllMarkets: getMarkets,
  getMarkets,
  getFeaturedMarkets,
  getTrendingMarkets,
  getCategories,
  searchMarkets,
  getMarket,
  getMarketPrices,
  getPriceHistory,
  getOrderBook,
  getRecentTrades,
  getQuote,
  createMarket,
  executeTrade,
  sellShares,
  previewSlippage,
  resolveMarket,
  updateMarket,
  toggleTradingPause,
};
