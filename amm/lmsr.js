/**
 * LMSR AMM Engine - Core Module
 *
 * Logarithmic Market Scoring Rule (LMSR) based Automated Market Maker
 * This is the PRIMARY pricing system for the prediction market.
 *
 * Key Features:
 * - Bounded pricing curve (prevents liquidity drain)
 * - Exponential price adjustment (anti-arbitrage)
 * - Configurable liquidity parameter 'b'
 * - Fee structure with slippage protection
 *
 * LMSR Formulas:
 * - Price: P(outcome) = exp(q_outcome / b) / Σ exp(q_i / b)
 * - Cost: C(q) = b * log(Σ exp(q_i / b))
 *
 * @author Polamarket Team
 */

/**
 * Calculate the LMSR cost function
 * C(q) = b * ln(exp(qYes/b) + exp(qNo/b))
 *
 * @param {number} qYes - Quantity of YES shares
 * @param {number} qNo - Quantity of NO shares
 * @param {number} b - Liquidity parameter
 * @returns {number} - Market cost
 */
function calculateCost(qYes, qNo, b) {
  // Use log-sum-exp trick for numerical stability
  const maxQ = Math.max(qYes, qNo);
  const scaledYes = (qYes - maxQ) / b;
  const scaledNo = (qNo - maxQ) / b;

  return b * (maxQ / b + Math.log(Math.exp(scaledYes) + Math.exp(scaledNo)));
}

/**
 * Calculate LMSR prices for both outcomes
 * P(YES) = exp(qYes/b) / (exp(qYes/b) + exp(qNo/b))
 *
 * @param {Object} market - Market object with qYes, qNo, and b parameters
 * @returns {Object} - { yesPrice, noPrice }
 */
function getPrices(market) {
  const { qYes, qNo, b } = market;

  // Use log-sum-exp trick for numerical stability with large values
  const maxQ = Math.max(qYes, qNo);
  const expYesNorm = Math.exp((qYes - maxQ) / b);
  const expNoNorm = Math.exp((qNo - maxQ) / b);
  const sumExp = expYesNorm + expNoNorm;

  const yesPrice = expYesNorm / sumExp;
  const noPrice = expNoNorm / sumExp;

  return {
    yesPrice: Math.max(0.001, Math.min(0.999, yesPrice)), // Clamp to avoid 0 or 1
    noPrice: Math.max(0.001, Math.min(0.999, noPrice)),
  };
}

/**
 * Calculate the number of shares for a given cost using LMSR
 * Uses numerical approximation (binary search) for accuracy
 *
 * @param {Object} market - Market object
 * @param {string} outcome - 'YES' or 'NO'
 * @param {number} cost - Amount to spend (after fees)
 * @returns {Object} - { shares, newQYes, newQNo, priceAfter }
 */
function calculateSharesForCost(market, outcome, cost) {
  const { qYes, qNo, b } = market;

  // Current cost
  const currentCost = calculateCost(qYes, qNo, b);

  // Target cost after purchase
  const targetCost = currentCost + cost;

  // Binary search to find the number of shares
  let low = 0;
  let high = cost * 100; // Upper bound estimate
  let shares = 0;
  const tolerance = 0.0001;
  const maxIterations = 100;

  for (let i = 0; i < maxIterations; i++) {
    shares = (low + high) / 2;

    let newQYes = qYes;
    let newQNo = qNo;

    if (outcome === "YES") {
      newQYes = qYes + shares;
    } else {
      newQNo = qNo + shares;
    }

    const newCost = calculateCost(newQYes, newQNo, b);
    const actualCost = newCost - currentCost;

    if (Math.abs(actualCost - cost) < tolerance) {
      break;
    }

    if (actualCost < cost) {
      low = shares;
    } else {
      high = shares;
    }
  }

  // Calculate final state
  let newQYes = qYes;
  let newQNo = qNo;

  if (outcome === "YES") {
    newQYes = qYes + shares;
  } else {
    newQNo = qNo + shares;
  }

  const pricesAfter = getPrices({ qYes: newQYes, qNo: newQNo, b });

  return {
    shares,
    newQYes,
    newQNo,
    priceAfter: outcome === "YES" ? pricesAfter.yesPrice : pricesAfter.noPrice,
  };
}

/**
 * Calculate the cost to buy a specific number of shares
 *
 * @param {Object} market - Market object
 * @param {string} outcome - 'YES' or 'NO'
 * @param {number} shares - Number of shares to buy
 * @returns {number} - Cost to buy the shares
 */
function calculateCostForShares(market, outcome, shares) {
  const { qYes, qNo, b } = market;

  const currentCost = calculateCost(qYes, qNo, b);

  let newQYes = qYes;
  let newQNo = qNo;

  if (outcome === "YES") {
    newQYes = qYes + shares;
  } else {
    newQNo = qNo + shares;
  }

  const newCost = calculateCost(newQYes, newQNo, b);

  return newCost - currentCost;
}

/**
 * Calculate slippage for a trade
 *
 * @param {Object} market - Market object
 * @param {string} outcome - 'YES' or 'NO'
 * @param {number} amount - Trade amount
 * @returns {Object} - { slippage, priceImpact, avgPrice }
 */
function calculateSlippage(market, outcome, amount) {
  const pricesBefore = getPrices(market);
  const entryPrice =
    outcome === "YES" ? pricesBefore.yesPrice : pricesBefore.noPrice;

  // Apply fee
  const feeRate = market.feeRate || 0.02;
  const amountAfterFee = amount * (1 - feeRate);

  // Calculate shares and new price
  const result = calculateSharesForCost(market, outcome, amountAfterFee);

  // Average price paid
  const avgPrice = amountAfterFee / result.shares;

  // Slippage = (avgPrice - entryPrice) / entryPrice
  const slippage = Math.abs(avgPrice - entryPrice) / entryPrice;

  // Price impact = (priceAfter - priceBefore) / priceBefore
  const priceImpact = Math.abs(result.priceAfter - entryPrice) / entryPrice;

  return {
    slippage,
    priceImpact,
    avgPrice,
    entryPrice,
    exitPrice: result.priceAfter,
  };
}

/**
 * Execute a BUY YES trade with all safety checks
 *
 * @param {Object} market - Market object
 * @param {number} amount - Amount to spend
 * @param {Object} options - { maxSlippage, userId }
 * @returns {Object} - Trade result
 */
function buyYes(market, amount, options = {}) {
  const { maxSlippage = 0.1 } = options;

  // Validate market state
  if (market.resolved) {
    throw new Error("MARKET_RESOLVED: Cannot trade in resolved market");
  }

  if (!market.isTradingActive) {
    throw new Error("TRADING_PAUSED: Trading is currently paused");
  }

  // Validate amount
  if (amount < (market.minTradeAmount || 1)) {
    throw new Error(
      `MIN_TRADE: Minimum trade amount is ${market.minTradeAmount || 1}`,
    );
  }

  if (amount > (market.maxTradeAmount || 10000)) {
    throw new Error(
      `MAX_TRADE: Maximum trade amount is ${market.maxTradeAmount || 10000}`,
    );
  }

  // Calculate fee
  const feeRate = market.feeRate || 0.02;
  const fee = amount * feeRate;
  const amountAfterFee = amount - fee;

  // Get current prices
  const pricesBefore = getPrices(market);

  // Calculate shares
  const result = calculateSharesForCost(market, "YES", amountAfterFee);

  // Calculate slippage
  const avgPrice = amountAfterFee / result.shares;
  const slippage =
    Math.abs(avgPrice - pricesBefore.yesPrice) / pricesBefore.yesPrice;

  // Check slippage limit
  if (slippage > maxSlippage) {
    throw new Error(
      `SLIPPAGE_EXCEEDED: Slippage ${(slippage * 100).toFixed(2)}% exceeds maximum ${(maxSlippage * 100).toFixed(2)}%`,
    );
  }

  // Check liquidity floor
  const liquidityFloor = market.liquidityFloor || 100;
  if (
    market.noPool - result.shares < liquidityFloor &&
    result.shares > market.noPool
  ) {
    throw new Error("LIQUIDITY_FLOOR: Trade would breach liquidity floor");
  }

  // Calculate new prices
  const pricesAfter = getPrices({
    qYes: result.newQYes,
    qNo: result.newQNo,
    b: market.b,
  });

  return {
    success: true,
    outcome: "YES",
    shares: result.shares,
    amountSpent: amount,
    amountAfterFee,
    fee,
    feeRate,
    avgPrice,
    entryPrice: pricesBefore.yesPrice,
    slippage,
    pricesBefore,
    pricesAfter,
    marketUpdate: {
      qYes: result.newQYes,
      qNo: result.newQNo,
      yesPool: market.yesPool + amountAfterFee,
      totalFeesCollected: (market.totalFeesCollected || 0) + fee,
      totalVolume: (market.totalVolume || 0) + amount,
      totalTrades: (market.totalTrades || 0) + 1,
    },
  };
}

/**
 * Execute a BUY NO trade with all safety checks
 *
 * @param {Object} market - Market object
 * @param {number} amount - Amount to spend
 * @param {Object} options - { maxSlippage, userId }
 * @returns {Object} - Trade result
 */
function buyNo(market, amount, options = {}) {
  const { maxSlippage = 0.1 } = options;

  // Validate market state
  if (market.resolved) {
    throw new Error("MARKET_RESOLVED: Cannot trade in resolved market");
  }

  if (!market.isTradingActive) {
    throw new Error("TRADING_PAUSED: Trading is currently paused");
  }

  // Validate amount
  if (amount < (market.minTradeAmount || 1)) {
    throw new Error(
      `MIN_TRADE: Minimum trade amount is ${market.minTradeAmount || 1}`,
    );
  }

  if (amount > (market.maxTradeAmount || 10000)) {
    throw new Error(
      `MAX_TRADE: Maximum trade amount is ${market.maxTradeAmount || 10000}`,
    );
  }

  // Calculate fee
  const feeRate = market.feeRate || 0.02;
  const fee = amount * feeRate;
  const amountAfterFee = amount - fee;

  // Get current prices
  const pricesBefore = getPrices(market);

  // Calculate shares
  const result = calculateSharesForCost(market, "NO", amountAfterFee);

  // Calculate slippage
  const avgPrice = amountAfterFee / result.shares;
  const slippage =
    Math.abs(avgPrice - pricesBefore.noPrice) / pricesBefore.noPrice;

  // Check slippage limit
  if (slippage > maxSlippage) {
    throw new Error(
      `SLIPPAGE_EXCEEDED: Slippage ${(slippage * 100).toFixed(2)}% exceeds maximum ${(maxSlippage * 100).toFixed(2)}%`,
    );
  }

  // Check liquidity floor
  const liquidityFloor = market.liquidityFloor || 100;
  if (
    market.yesPool - result.shares < liquidityFloor &&
    result.shares > market.yesPool
  ) {
    throw new Error("LIQUIDITY_FLOOR: Trade would breach liquidity floor");
  }

  // Calculate new prices
  const pricesAfter = getPrices({
    qYes: result.newQYes,
    qNo: result.newQNo,
    b: market.b,
  });

  return {
    success: true,
    outcome: "NO",
    shares: result.shares,
    amountSpent: amount,
    amountAfterFee,
    fee,
    feeRate,
    avgPrice,
    entryPrice: pricesBefore.noPrice,
    slippage,
    pricesBefore,
    pricesAfter,
    marketUpdate: {
      qYes: result.newQYes,
      qNo: result.newQNo,
      noPool: market.noPool + amountAfterFee,
      totalFeesCollected: (market.totalFeesCollected || 0) + fee,
      totalVolume: (market.totalVolume || 0) + amount,
      totalTrades: (market.totalTrades || 0) + 1,
    },
  };
}

/**
 * Calculate sell proceeds (redeeming shares)
 *
 * @param {Object} market - Market object
 * @param {string} outcome - 'YES' or 'NO'
 * @param {number} shares - Shares to sell
 * @returns {Object} - Sell result
 */
function sellShares(market, outcome, shares) {
  const { qYes, qNo, b } = market;

  // Current cost
  const currentCost = calculateCost(qYes, qNo, b);

  // New quantities after selling
  let newQYes = qYes;
  let newQNo = qNo;

  if (outcome === "YES") {
    newQYes = Math.max(0, qYes - shares);
  } else {
    newQNo = Math.max(0, qNo - shares);
  }

  // New cost
  const newCost = calculateCost(newQYes, newQNo, b);

  // Proceeds = cost reduction (minus fees)
  const grossProceeds = currentCost - newCost;
  const feeRate = market.feeRate || 0.02;
  const fee = grossProceeds * feeRate;
  const netProceeds = grossProceeds - fee;

  const pricesAfter = getPrices({ qYes: newQYes, qNo: newQNo, b });

  return {
    success: true,
    outcome,
    shares,
    grossProceeds,
    fee,
    netProceeds,
    pricesAfter,
    marketUpdate: {
      qYes: newQYes,
      qNo: newQNo,
    },
  };
}

/**
 * Calculate optimal liquidity parameter 'b' based on expected volume
 * Higher 'b' = more liquidity = less price slippage
 * Lower 'b' = less liquidity = more responsive prices
 *
 * @param {number} expectedVolume - Expected total trading volume
 * @param {number} volatilityFactor - Market volatility (0-1)
 * @returns {number} - Recommended 'b' parameter
 */
function calculateOptimalB(expectedVolume, volatilityFactor = 0.5) {
  // Base formula: b = expectedVolume * (0.1 to 0.5) based on volatility
  // Higher volatility = higher b for more stability
  const multiplier = 0.1 + volatilityFactor * 0.4;
  return Math.max(10, Math.min(10000, expectedVolume * multiplier));
}

/**
 * Normalize external market liquidity to internal 'b' parameter
 * Used for Polymarket/Gamma integration
 *
 * @param {number} externalLiquidity - External market liquidity
 * @param {number} externalVolume - External market volume
 * @returns {number} - Normalized 'b' parameter
 */
function normalizeExternalLiquidity(externalLiquidity, externalVolume) {
  // Estimate b based on liquidity to volume ratio
  const ratio = externalLiquidity / Math.max(externalVolume, 1);
  return Math.max(50, Math.min(5000, ratio * 100));
}

module.exports = {
  calculateCost,
  getPrices,
  calculateSharesForCost,
  calculateCostForShares,
  calculateSlippage,
  buyYes,
  buyNo,
  sellShares,
  calculateOptimalB,
  normalizeExternalLiquidity,
};
