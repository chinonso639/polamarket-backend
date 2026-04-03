/**
 * AMM Risk Manager
 *
 * Advanced risk controls for the LMSR AMM system:
 * - Position limits per user
 * - Liquidity protection
 * - Arbitrage detection
 * - Dynamic fee adjustment
 * - Trade cooldown enforcement
 */

const logger = require("../utils/logger");

/**
 * Risk thresholds configuration
 */
const RISK_CONFIG = {
  // Position limits
  MAX_POSITION_PERCENT: 0.2, // Max 20% of total market liquidity
  MAX_SINGLE_TRADE_PERCENT: 0.1, // Max 10% of liquidity per trade

  // Liquidity protection
  MIN_LIQUIDITY_RATIO: 0.1, // Minimum 10% liquidity must remain
  LIQUIDITY_WARNING_THRESHOLD: 0.2,

  // Arbitrage detection
  RAPID_TRADE_WINDOW_MS: 5000, // 5 second window
  RAPID_TRADE_THRESHOLD: 3, // Max trades in window
  PRICE_REVERSAL_THRESHOLD: 0.05, // 5% price reversal suspicious

  // Fee adjustment
  BASE_FEE_RATE: 0.02,
  HIGH_VOLATILITY_FEE_RATE: 0.05,
  LOW_LIQUIDITY_FEE_RATE: 0.04,

  // Trade cooldown
  DEFAULT_COOLDOWN_MS: 1000, // 1 second between trades
  BOT_DETECTION_COOLDOWN_MS: 60000, // 1 minute if bot detected
};

/**
 * Check if a trade violates position limits
 *
 * @param {Object} params
 * @param {Object} params.user - User object
 * @param {Object} params.market - Market object
 * @param {Object} params.existingPosition - User's current position
 * @param {number} params.tradeAmount - Proposed trade amount
 * @returns {Object} - { allowed, reason }
 */
function checkPositionLimits({ user, market, existingPosition, tradeAmount }) {
  const totalLiquidity =
    market.yesPool + market.noPool + market.virtualLiquidityBuffer;
  const maxPosition = totalLiquidity * RISK_CONFIG.MAX_POSITION_PERCENT;
  const userMaxPosition = user.maxPositionSize || 5000;

  const currentPosition = existingPosition?.amountSpent || 0;
  const newPosition = currentPosition + tradeAmount;

  // Check against user-specific limit
  if (newPosition > userMaxPosition) {
    return {
      allowed: false,
      reason: `Position would exceed your maximum limit of $${userMaxPosition}`,
      code: "USER_POSITION_LIMIT",
    };
  }

  // Check against market-wide limit
  if (newPosition > maxPosition) {
    return {
      allowed: false,
      reason: `Position would exceed market limit of ${(RISK_CONFIG.MAX_POSITION_PERCENT * 100).toFixed(0)}% of liquidity`,
      code: "MARKET_POSITION_LIMIT",
    };
  }

  // Check single trade size
  const maxSingleTrade = totalLiquidity * RISK_CONFIG.MAX_SINGLE_TRADE_PERCENT;
  if (tradeAmount > maxSingleTrade) {
    return {
      allowed: false,
      reason: `Single trade cannot exceed ${(RISK_CONFIG.MAX_SINGLE_TRADE_PERCENT * 100).toFixed(0)}% of market liquidity`,
      code: "SINGLE_TRADE_LIMIT",
    };
  }

  return { allowed: true };
}

/**
 * Check liquidity protection rules
 *
 * @param {Object} market - Market object
 * @param {string} outcome - 'YES' or 'NO'
 * @param {number} shares - Shares being purchased
 * @returns {Object} - { allowed, reason, warning }
 */
function checkLiquidityProtection(market, outcome, shares) {
  const totalLiquidity = market.yesPool + market.noPool;

  // If buying YES, the NO pool effectively decreases in relative terms
  // We need to ensure there's enough liquidity on both sides

  const minLiquidity = totalLiquidity * RISK_CONFIG.MIN_LIQUIDITY_RATIO;
  const warningLiquidity =
    totalLiquidity * RISK_CONFIG.LIQUIDITY_WARNING_THRESHOLD;

  let resultingLiquidity;
  if (outcome === "YES") {
    resultingLiquidity = market.noPool;
  } else {
    resultingLiquidity = market.yesPool;
  }

  if (resultingLiquidity < minLiquidity) {
    return {
      allowed: false,
      reason: "Trade would drain too much liquidity from one side",
      code: "LIQUIDITY_FLOOR_BREACH",
    };
  }

  const warning =
    resultingLiquidity < warningLiquidity
      ? "Warning: Liquidity is getting low on this side"
      : null;

  return { allowed: true, warning };
}

/**
 * Detect potential arbitrage or bot activity
 *
 * @param {Object} params
 * @param {string} params.userId - User ID
 * @param {string} params.marketId - Market ID
 * @param {Array} params.recentTrades - Recent trades by this user
 * @returns {Object} - { suspicious, reason, cooldown }
 */
function detectArbitrage({ userId, marketId, recentTrades }) {
  const now = Date.now();
  const windowStart = now - RISK_CONFIG.RAPID_TRADE_WINDOW_MS;

  // Filter trades in the window
  const tradesInWindow = recentTrades.filter(
    (t) => new Date(t.createdAt).getTime() > windowStart,
  );

  // Check rapid trading
  if (tradesInWindow.length >= RISK_CONFIG.RAPID_TRADE_THRESHOLD) {
    return {
      suspicious: true,
      reason: "Rapid trading detected - possible bot activity",
      cooldown: RISK_CONFIG.BOT_DETECTION_COOLDOWN_MS,
      code: "RAPID_TRADING",
    };
  }

  // Check for price reversal exploitation (quick buy then sell or vice versa)
  if (tradesInWindow.length >= 2) {
    const outcomes = tradesInWindow.map((t) => t.outcome);
    const hasReversal = outcomes.some((o, i) => i > 0 && o !== outcomes[i - 1]);

    if (hasReversal) {
      return {
        suspicious: true,
        reason: "Potential arbitrage pattern detected",
        cooldown: RISK_CONFIG.BOT_DETECTION_COOLDOWN_MS,
        code: "ARBITRAGE_PATTERN",
      };
    }
  }

  return { suspicious: false };
}

/**
 * Calculate dynamic fee based on market conditions
 *
 * @param {Object} market - Market object
 * @param {number} tradeAmount - Proposed trade amount
 * @returns {number} - Adjusted fee rate
 */
function calculateDynamicFee(market, tradeAmount) {
  let feeRate = RISK_CONFIG.BASE_FEE_RATE;

  const totalLiquidity =
    market.yesPool + market.noPool + market.virtualLiquidityBuffer;

  // Increase fee if liquidity is low
  if (totalLiquidity < 1000) {
    feeRate = Math.max(feeRate, RISK_CONFIG.LOW_LIQUIDITY_FEE_RATE);
  }

  // Increase fee for large trades (impact fee)
  const tradePercent = tradeAmount / totalLiquidity;
  if (tradePercent > 0.05) {
    feeRate += tradePercent * 0.1; // Additional 0.1% per 1% of liquidity
  }

  // Check recent price volatility (if available)
  if (market.priceHistory && market.priceHistory.length > 1) {
    const recentPrices = market.priceHistory.slice(-10);
    const priceChanges = recentPrices.map((p, i) => {
      if (i === 0) return 0;
      return Math.abs(p.yesPrice - recentPrices[i - 1].yesPrice);
    });
    const avgVolatility =
      priceChanges.reduce((a, b) => a + b, 0) / priceChanges.length;

    if (avgVolatility > 0.05) {
      feeRate = Math.max(feeRate, RISK_CONFIG.HIGH_VOLATILITY_FEE_RATE);
    }
  }

  // Cap maximum fee at 10%
  return Math.min(feeRate, 0.1);
}

/**
 * Check trade cooldown for a user
 *
 * @param {Object} user - User object
 * @param {Date} lastTradeTime - Time of last trade
 * @returns {Object} - { allowed, waitTime }
 */
function checkTradeCooldown(user, lastTradeTime) {
  if (!lastTradeTime) {
    return { allowed: true };
  }

  const now = Date.now();
  const lastTrade = new Date(lastTradeTime).getTime();
  const elapsed = now - lastTrade;

  const cooldown = user.botFlagged
    ? RISK_CONFIG.BOT_DETECTION_COOLDOWN_MS
    : RISK_CONFIG.DEFAULT_COOLDOWN_MS;

  if (elapsed < cooldown) {
    return {
      allowed: false,
      waitTime: cooldown - elapsed,
      code: "COOLDOWN_ACTIVE",
    };
  }

  return { allowed: true };
}

/**
 * Full risk assessment for a trade
 *
 * @param {Object} params
 * @param {Object} params.user - User object
 * @param {Object} params.market - Market object
 * @param {string} params.outcome - 'YES' or 'NO'
 * @param {number} params.amount - Trade amount
 * @param {Object} params.existingPosition - User's current position
 * @param {Array} params.recentTrades - Recent trades by this user
 * @returns {Object} - Complete risk assessment
 */
function assessTradeRisk({
  user,
  market,
  outcome,
  amount,
  existingPosition,
  recentTrades,
}) {
  const assessment = {
    allowed: true,
    warnings: [],
    adjustments: {},
    riskScore: 0,
  };

  // 1. Check position limits
  const positionCheck = checkPositionLimits({
    user,
    market,
    existingPosition,
    tradeAmount: amount,
  });
  if (!positionCheck.allowed) {
    assessment.allowed = false;
    assessment.reason = positionCheck.reason;
    assessment.code = positionCheck.code;
    return assessment;
  }

  // 2. Check liquidity protection
  const liquidityCheck = checkLiquidityProtection(market, outcome, amount);
  if (!liquidityCheck.allowed) {
    assessment.allowed = false;
    assessment.reason = liquidityCheck.reason;
    assessment.code = liquidityCheck.code;
    return assessment;
  }
  if (liquidityCheck.warning) {
    assessment.warnings.push(liquidityCheck.warning);
    assessment.riskScore += 20;
  }

  // 3. Check for arbitrage
  const arbitrageCheck = detectArbitrage({
    userId: user._id.toString(),
    marketId: market._id.toString(),
    recentTrades,
  });
  if (arbitrageCheck.suspicious) {
    assessment.allowed = false;
    assessment.reason = arbitrageCheck.reason;
    assessment.code = arbitrageCheck.code;
    assessment.cooldown = arbitrageCheck.cooldown;
    return assessment;
  }

  // 4. Check cooldown
  const cooldownCheck = checkTradeCooldown(user, user.lastTradeAt);
  if (!cooldownCheck.allowed) {
    assessment.allowed = false;
    assessment.reason = `Please wait ${Math.ceil(cooldownCheck.waitTime / 1000)} seconds`;
    assessment.code = cooldownCheck.code;
    assessment.waitTime = cooldownCheck.waitTime;
    return assessment;
  }

  // 5. Calculate dynamic fee
  const dynamicFee = calculateDynamicFee(market, amount);
  if (dynamicFee > market.feeRate) {
    assessment.adjustments.feeRate = dynamicFee;
    assessment.warnings.push(
      `Fee adjusted to ${(dynamicFee * 100).toFixed(2)}% due to market conditions`,
    );
    assessment.riskScore += 10;
  }

  // Calculate final risk score
  const tradePercent =
    amount / (market.yesPool + market.noPool + market.virtualLiquidityBuffer);
  assessment.riskScore += Math.floor(tradePercent * 100);

  if (assessment.riskScore > 50) {
    assessment.warnings.push("High-risk trade detected");
  }

  return assessment;
}

/**
 * Log risk event for audit purposes
 *
 * @param {string} eventType - Type of risk event
 * @param {Object} details - Event details
 */
function logRiskEvent(eventType, details) {
  logger.warn("RISK_EVENT", {
    type: eventType,
    timestamp: new Date().toISOString(),
    ...details,
  });
}

module.exports = {
  RISK_CONFIG,
  checkPositionLimits,
  checkLiquidityProtection,
  detectArbitrage,
  calculateDynamicFee,
  checkTradeCooldown,
  assessTradeRisk,
  logRiskEvent,
};
