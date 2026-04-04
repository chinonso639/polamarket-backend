/**
 * LMSR AMM Engine - Core Module
 *
 * Logarithmic Market Scoring Rule (LMSR) based Automated Market Maker.
 * Supports both legacy binary markets and multi-outcome markets.
 */

const {
  buildCompatibilityFields,
  normalizeOutcomeKey,
  normalizeOutcomeStates,
} = require("../utils/marketState");

const MIN_PRICE = 0.001;
const MAX_PRICE = 0.999;

function clampPrice(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return MIN_PRICE;
  }
  return Math.max(MIN_PRICE, Math.min(MAX_PRICE, num));
}

function getEffectiveLiquidity(market) {
  return Math.max(1, Number(market?.b) || 100);
}

function ensureOutcomeExists(market, outcome) {
  const normalizedOutcome = normalizeOutcomeKey(outcome);
  const states = normalizeOutcomeStates(market);
  const selected = states.find((state) => state.key === normalizedOutcome);

  if (!selected) {
    throw new Error(
      `INVALID_OUTCOME: Outcome ${normalizedOutcome} is not available in this market`,
    );
  }

  return {
    normalizedOutcome,
    states,
    selected,
  };
}

function calculateCost(outcomesOrMarket, maybeB) {
  const states = Array.isArray(outcomesOrMarket)
    ? outcomesOrMarket
    : normalizeOutcomeStates(outcomesOrMarket);
  const b = Array.isArray(outcomesOrMarket)
    ? Math.max(1, Number(maybeB) || 100)
    : getEffectiveLiquidity(outcomesOrMarket);

  const quantities = states.map((state) => Number(state.quantity) || 0);
  const maxQuantity = Math.max(...quantities);
  const sumExp = quantities.reduce((sum, quantity) => {
    return sum + Math.exp((quantity - maxQuantity) / b);
  }, 0);

  return b * (maxQuantity / b + Math.log(sumExp));
}

function calculatePriceMap(outcomeStates, b) {
  const quantities = outcomeStates.map((state) => Number(state.quantity) || 0);
  const maxQuantity = Math.max(...quantities);
  const weights = outcomeStates.map((state) => ({
    key: state.key,
    weight: Math.exp(((Number(state.quantity) || 0) - maxQuantity) / b),
  }));
  const totalWeight = weights.reduce((sum, item) => sum + item.weight, 0) || 1;

  return weights.reduce((accumulator, item) => {
    accumulator[item.key] = clampPrice(item.weight / totalWeight);
    return accumulator;
  }, {});
}

function buildDisplayedOutcomes(outcomeStates, priceMap) {
  return outcomeStates.map((state) => ({
    key: state.key,
    label: state.label,
    price: priceMap[state.key],
    probability: priceMap[state.key],
    volume: 0,
    recentTrades: 0,
    order: state.order,
  }));
}

function getOutcomePrices(market) {
  const outcomeStates = normalizeOutcomeStates(market);
  const b = getEffectiveLiquidity(market);
  return {
    outcomeStates,
    priceMap: calculatePriceMap(outcomeStates, b),
  };
}

function getPrices(market) {
  const { outcomeStates, priceMap } = getOutcomePrices(market);
  const displayedOutcomes = buildDisplayedOutcomes(outcomeStates, priceMap);
  const yesPrice = priceMap.YES ?? null;
  const noPrice = priceMap.NO ?? null;

  return {
    yesPrice,
    noPrice,
    yes: yesPrice,
    no: noPrice,
    outcomePrices: priceMap,
    outcomes: displayedOutcomes,
  };
}

function applySharesDelta(outcomeStates, outcomeKey, shareDelta) {
  return outcomeStates.map((state) => {
    if (state.key !== outcomeKey) {
      return state;
    }

    return {
      ...state,
      quantity: Math.max(0, (Number(state.quantity) || 0) + shareDelta),
    };
  });
}

function applyPoolDelta(outcomeStates, outcomeKey, poolDelta) {
  return outcomeStates.map((state) => {
    if (state.key !== outcomeKey) {
      return state;
    }

    return {
      ...state,
      pool: Math.max(0, (Number(state.pool) || 0) + poolDelta),
    };
  });
}

function buildMarketUpdate(market, outcomeStates) {
  return {
    outcomeStates,
    ...buildCompatibilityFields(market, outcomeStates),
  };
}

function calculateSharesForCost(market, outcome, cost) {
  const { normalizedOutcome, states } = ensureOutcomeExists(market, outcome);
  const b = getEffectiveLiquidity(market);
  const currentCost = calculateCost(states, b);

  let low = 0;
  const entryPrice =
    calculatePriceMap(states, b)[normalizedOutcome] || MIN_PRICE;
  let high = Math.max(cost / entryPrice, cost * 100, 1);
  const tolerance = 0.0001;
  const maxIterations = 120;

  for (let i = 0; i < 20; i += 1) {
    const trialStates = applySharesDelta(states, normalizedOutcome, high);
    const trialCost = calculateCost(trialStates, b) - currentCost;
    if (trialCost >= cost) {
      break;
    }
    high *= 2;
  }

  let shares = 0;
  for (let i = 0; i < maxIterations; i += 1) {
    shares = (low + high) / 2;
    const trialStates = applySharesDelta(states, normalizedOutcome, shares);
    const actualCost = calculateCost(trialStates, b) - currentCost;

    if (Math.abs(actualCost - cost) < tolerance) {
      break;
    }

    if (actualCost < cost) {
      low = shares;
    } else {
      high = shares;
    }
  }

  const updatedStates = applySharesDelta(states, normalizedOutcome, shares);
  const pricesAfter = getPrices({ ...market, outcomeStates: updatedStates });

  return {
    shares,
    outcome: normalizedOutcome,
    updatedStates,
    priceAfter: pricesAfter.outcomePrices[normalizedOutcome],
    pricesAfter,
  };
}

function calculateCostForShares(market, outcome, shares) {
  const { normalizedOutcome, states } = ensureOutcomeExists(market, outcome);
  const b = getEffectiveLiquidity(market);
  const currentCost = calculateCost(states, b);
  const updatedStates = applySharesDelta(states, normalizedOutcome, shares);
  return calculateCost(updatedStates, b) - currentCost;
}

function calculateSlippage(market, outcome, amount) {
  const { normalizedOutcome } = ensureOutcomeExists(market, outcome);
  const pricesBefore = getPrices(market);
  const entryPrice = pricesBefore.outcomePrices[normalizedOutcome];
  const feeRate = market.feeRate || 0.02;
  const amountAfterFee = amount * (1 - feeRate);
  const result = calculateSharesForCost(
    market,
    normalizedOutcome,
    amountAfterFee,
  );
  const avgPrice = amountAfterFee / result.shares;
  const slippage = Math.abs(avgPrice - entryPrice) / entryPrice;
  const priceImpact = Math.abs(result.priceAfter - entryPrice) / entryPrice;

  return {
    slippage,
    priceImpact,
    avgPrice,
    entryPrice,
    exitPrice: result.priceAfter,
  };
}

function validateTradeRequest(market, amount) {
  if (market.resolved) {
    throw new Error("MARKET_RESOLVED: Cannot trade in resolved market");
  }

  if (!market.isTradingActive) {
    throw new Error("TRADING_PAUSED: Trading is currently paused");
  }

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
}

function buyShares(market, outcome, amount, options = {}) {
  const { maxSlippage = 0.1 } = options;
  const { normalizedOutcome } = ensureOutcomeExists(market, outcome);
  validateTradeRequest(market, amount);

  const feeRate = market.feeRate || 0.02;
  const spreadRate = market.spreadRate || 0.005;
  const fee = amount * feeRate;
  const amountAfterFee = amount - fee;
  // Spread is taken from amountAfterFee (additional revenue slice)
  const spreadFee = amountAfterFee * spreadRate;
  const amountForShares = amountAfterFee - spreadFee;

  const pricesBefore = getPrices(market);
  const entryPrice = pricesBefore.outcomePrices[normalizedOutcome];
  const result = calculateSharesForCost(
    market,
    normalizedOutcome,
    amountForShares,
  );
  const avgPrice = amountForShares / result.shares;
  const slippage = Math.abs(avgPrice - entryPrice) / entryPrice;

  if (slippage > maxSlippage) {
    throw new Error(
      `SLIPPAGE_EXCEEDED: Slippage ${(slippage * 100).toFixed(2)}% exceeds maximum ${(maxSlippage * 100).toFixed(2)}%`,
    );
  }

  const updatedStates = applyPoolDelta(
    result.updatedStates,
    normalizedOutcome,
    amountForShares,
  );

  return {
    success: true,
    outcome: normalizedOutcome,
    shares: result.shares,
    amountSpent: amount,
    amountAfterFee: amountForShares,
    fee,
    spreadFee,
    totalFeesPaid: fee + spreadFee,
    feeRate,
    spreadRate,
    avgPrice,
    entryPrice,
    slippage,
    pricesBefore,
    pricesAfter: getPrices({ ...market, outcomeStates: updatedStates }),
    marketUpdate: buildMarketUpdate(market, updatedStates),
  };
}

function buyYes(market, amount, options = {}) {
  return buyShares(market, "YES", amount, options);
}

function buyNo(market, amount, options = {}) {
  return buyShares(market, "NO", amount, options);
}

function sellShares(market, outcome, shares) {
  const { normalizedOutcome, states, selected } = ensureOutcomeExists(
    market,
    outcome,
  );
  const b = getEffectiveLiquidity(market);
  const sellAmount = Number(shares);

  if (!Number.isFinite(sellAmount) || sellAmount <= 0) {
    throw new Error("INVALID_SHARES: Shares must be a positive number");
  }

  if (sellAmount > selected.quantity) {
    throw new Error(
      "INSUFFICIENT_MARKET_SHARES: Cannot sell more shares than currently exist for this outcome",
    );
  }

  const currentCost = calculateCost(states, b);
  const statesAfterSale = applySharesDelta(
    states,
    normalizedOutcome,
    -sellAmount,
  );
  const newCost = calculateCost(statesAfterSale, b);
  const grossProceeds = currentCost - newCost;
  const feeRate = market.feeRate || 0.02;
  const spreadRate = market.spreadRate || 0.005;
  const fee = grossProceeds * feeRate;
  const spreadFee = grossProceeds * spreadRate;
  const netProceeds = grossProceeds - fee - spreadFee;
  const updatedStates = applyPoolDelta(
    statesAfterSale,
    normalizedOutcome,
    -grossProceeds,
  );

  return {
    success: true,
    outcome: normalizedOutcome,
    shares: sellAmount,
    grossProceeds,
    fee,
    spreadFee,
    totalFeesPaid: fee + spreadFee,
    netProceeds,
    pricesAfter: getPrices({ ...market, outcomeStates: updatedStates }),
    marketUpdate: buildMarketUpdate(market, updatedStates),
  };
}

function calculateOptimalB(expectedVolume, volatilityFactor = 0.5) {
  const multiplier = 0.1 + volatilityFactor * 0.4;
  return Math.max(10, Math.min(10000, expectedVolume * multiplier));
}

function normalizeExternalLiquidity(externalLiquidity, externalVolume) {
  const ratio = externalLiquidity / Math.max(externalVolume, 1);
  return Math.max(50, Math.min(5000, ratio * 100));
}

module.exports = {
  buyNo,
  buyShares,
  buyYes,
  calculateCost,
  calculateCostForShares,
  calculateOptimalB,
  calculateSharesForCost,
  calculateSlippage,
  getOutcomePrices,
  getPrices,
  normalizeExternalLiquidity,
  sellShares,
};
