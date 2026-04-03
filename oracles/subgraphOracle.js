/**
 * Polymarket Subgraph Oracle
 * Polls The Graph for market resolution status and outcomes
 */

const axios = require("axios");
const Market = require("../models/Market");
const Bet = require("../models/Bet");
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const logger = require("../utils/logger");
const { emitMarketResolved } = require("../services/socketService");
const gammaApi = require("./gammaApi");

const SUBGRAPH_URL =
  process.env.POLYMARKET_SUBGRAPH_URL ||
  "https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/positions-subgraph/0.0.7/gn";

// Polling interval (30-60 seconds as specified)
const POLL_INTERVAL_MS = 45000;

// Fallback oracle configuration
const FALLBACK_ENABLED = process.env.FALLBACK_ORACLE_ENABLED === "true";
const FALLBACK_API = process.env.FALLBACK_ORACLE_API;

/**
 * Query the subgraph
 *
 * @param {string} query - GraphQL query
 * @param {Object} variables - Query variables
 * @returns {Promise<Object>} - Query result
 */
async function querySubgraph(query, variables = {}) {
  try {
    const response = await axios.post(
      SUBGRAPH_URL,
      {
        query,
        variables,
      },
      {
        headers: {
          "Content-Type": "application/json",
        },
        timeout: 30000,
      },
    );

    if (response.data.errors) {
      throw new Error(response.data.errors[0].message);
    }

    return response.data.data;
  } catch (error) {
    logger.error("Subgraph query failed:", error.message);
    throw error;
  }
}

/**
 * Get market resolution status from subgraph
 *
 * @param {string} conditionId - Market condition ID
 * @returns {Promise<Object>} - Resolution status
 */
async function getResolutionStatus(conditionId) {
  const modernQuery = `
        query GetCondition($conditionId: String!) {
            condition(id: $conditionId) {
                id
                payouts
            }
        }
    `;

  const legacyQuery = `
        query GetCondition($conditionId: String!) {
            condition(id: $conditionId) {
                id
                resolved
                payoutNumerators
                payoutDenominator
                resolvedTimestamp
                oracle
            }
        }
    `;

  let result;
  try {
    result = await querySubgraph(modernQuery, { conditionId });
  } catch (_error) {
    // Fallback for legacy The Graph schema
    result = await querySubgraph(legacyQuery, { conditionId });
  }

  if (!result.condition) {
    return null;
  }

  const condition = result.condition;
  const payoutValues = condition.payouts || condition.payoutNumerators;
  const outcome = decodeOutcomeFromPayouts(payoutValues);
  const resolved = Array.isArray(payoutValues)
    ? payoutValues.some((v) => Number(v) > 0)
    : !!condition.resolved;

  return {
    conditionId: condition.id,
    resolved,
    outcome,
    resolvedAt: condition.resolvedTimestamp
      ? new Date(condition.resolvedTimestamp * 1000)
      : null,
    oracle: condition.oracle,
  };
}

/**
 * Get multiple market resolutions
 *
 * @param {Array<string>} conditionIds - Array of condition IDs
 * @returns {Promise<Array>} - Resolution statuses
 */
async function getBatchResolutions(conditionIds) {
  const modernQuery = `
        query GetConditions($conditionIds: [String!]!) {
            conditions(where: { id_in: $conditionIds }) {
                id
                payouts
            }
        }
    `;

  const legacyQuery = `
        query GetConditions($conditionIds: [String!]!) {
            conditions(where: { id_in: $conditionIds }) {
                id
                resolved
                payoutNumerators
                resolvedTimestamp
            }
        }
    `;

  let result;
  try {
    result = await querySubgraph(modernQuery, { conditionIds });
  } catch (_error) {
    // Fallback for legacy The Graph schema
    result = await querySubgraph(legacyQuery, { conditionIds });
  }

  return (result.conditions || []).map((condition) => {
    const payoutValues = condition.payouts || condition.payoutNumerators;
    const outcome = decodeOutcomeFromPayouts(payoutValues);
    const resolved = Array.isArray(payoutValues)
      ? payoutValues.some((v) => Number(v) > 0)
      : !!condition.resolved;

    return {
      conditionId: condition.id,
      resolved,
      outcome,
      resolvedAt: condition.resolvedTimestamp
        ? new Date(condition.resolvedTimestamp * 1000)
        : null,
    };
  });
}

function decodeOutcomeFromPayouts(payoutValues) {
  if (!Array.isArray(payoutValues) || payoutValues.length < 2) {
    return null;
  }

  const payouts = payoutValues.map(Number);
  if (payouts[0] > payouts[1]) return "YES";
  if (payouts[1] > payouts[0]) return "NO";
  return null;
}

/**
 * Check fallback oracle for resolution
 *
 * @param {string} conditionId - Condition ID
 * @returns {Promise<Object|null>} - Resolution from fallback oracle
 */
async function checkFallbackOracle(conditionId) {
  if (!FALLBACK_ENABLED || !FALLBACK_API) {
    return null;
  }

  try {
    const response = await axios.get(
      `${FALLBACK_API}/resolution/${conditionId}`,
      {
        timeout: 10000,
      },
    );

    if (response.data && response.data.resolved) {
      return {
        conditionId,
        resolved: true,
        outcome: response.data.outcome,
        source: "fallback",
      };
    }
  } catch (error) {
    logger.warn(
      `Fallback oracle check failed for ${conditionId}:`,
      error.message,
    );
  }

  return null;
}

/**
 * Poll and update market resolutions
 * This is the main polling function that runs periodically
 */
async function pollResolutions() {
  try {
    // Only poll markets that currently have unsettled user exposure.
    // This keeps polling load aligned with active positions.
    const activeMarketIds = await Bet.distinct("marketId", {
      settled: false,
      marketId: { $ne: null },
    });

    if (!activeMarketIds.length) {
      logger.debug("Skipping resolution poll: no markets with unsettled bets");
      return;
    }

    // Get unresolved external markets with condition IDs that also have unsettled bets
    const unresolvedMarkets = await Market.find({
      _id: { $in: activeMarketIds },
      resolved: false,
      conditionId: { $exists: true, $ne: null },
      externalSource: { $in: ["polymarket", "gamma"] },
    })
      .select("_id conditionId externalId externalSource question")
      .lean();

    if (unresolvedMarkets.length === 0) {
      logger.debug(
        "Skipping resolution poll: no unresolved external markets with active positions",
      );
      return;
    }

    logger.debug(
      `Polling resolutions for ${unresolvedMarkets.length} markets with unsettled positions`,
    );

    const conditionIds = unresolvedMarkets.map((m) => m.conditionId);

    // Batch query to subgraph (non-fatal: we can fallback to Gamma)
    let resolutions = [];
    try {
      resolutions = await getBatchResolutions(conditionIds);
    } catch (error) {
      logger.warn(
        "Subgraph batch resolution lookup failed, using fallback paths",
      );
    }

    const resolutionMap = new Map(
      resolutions.map((r) => [String(r.conditionId).toLowerCase(), r]),
    );

    for (const market of unresolvedMarkets) {
      let resolution = resolutionMap.get(
        String(market.conditionId).toLowerCase(),
      );

      // Check fallback if primary didn't find resolution
      if (!resolution?.resolved && FALLBACK_ENABLED) {
        resolution = await checkFallbackOracle(market.conditionId);
      }

      // Gamma fallback (useful when subgraph endpoint is unavailable)
      if (!resolution?.resolved) {
        const gammaMarketId = market.externalId || market.conditionId;
        resolution = await checkGammaResolution(gammaMarketId);
      }

      if (resolution?.resolved && resolution?.outcome) {
        // Update market
        await Market.findByIdAndUpdate(market._id, {
          resolved: true,
          outcome: resolution.outcome,
          resolvedAt: resolution.resolvedAt || new Date(),
          isTradingActive: false,
          resolutionSource: resolution.source || "subgraph",
        });

        // Emit event
        emitMarketResolved(market._id.toString(), resolution.outcome);

        // Auto-settle all unresolved bets for this market and credit users.
        // This keeps portfolio and balances in sync immediately after oracle resolution.
        await settleResolvedMarketBets(
          market._id,
          resolution.outcome,
          market.question,
        );

        logger.info(
          `Market resolved: ${market.question} -> ${resolution.outcome}`,
        );
      }
    }
  } catch (error) {
    logger.error("Resolution polling failed:", error.message);
  }
}

/**
 * Check market resolution via Gamma API.
 *
 * @param {string} gammaMarketId
 * @returns {Promise<Object|null>}
 */
async function checkGammaResolution(gammaMarketId) {
  if (!gammaMarketId) return null;

  try {
    const raw = await gammaApi.fetchMarketByCondition(gammaMarketId);
    const market = Array.isArray(raw) ? raw[0] : raw;
    if (!market) return null;

    const isResolved =
      market.resolved === true ||
      market.closed === true ||
      market.archived === true;

    if (!isResolved) return null;

    let outcome = null;

    if (typeof market.outcome === "string") {
      const out = market.outcome.toUpperCase();
      if (out === "YES" || out === "NO") {
        outcome = out;
      }
    }

    if (!outcome && Array.isArray(market.tokens)) {
      const winnerToken = market.tokens.find((t) => t.winner === true);
      const tokenOutcome = winnerToken?.outcome;
      if (typeof tokenOutcome === "string") {
        const out = tokenOutcome.toUpperCase();
        if (out === "YES" || out === "NO") {
          outcome = out;
        }
      }
    }

    if (!outcome) return null;

    return {
      resolved: true,
      outcome,
      resolvedAt: market.resolutionTime
        ? new Date(market.resolutionTime)
        : new Date(),
      source: "gamma",
    };
  } catch (_error) {
    return null;
  }
}

/**
 * Settle all unsettled bets for a resolved market and credit user balances.
 *
 * @param {string|ObjectId} marketId
 * @param {"YES"|"NO"} marketOutcome
 * @param {string} marketQuestion
 */
async function settleResolvedMarketBets(
  marketId,
  marketOutcome,
  marketQuestion,
) {
  const unsettledBets = await Bet.find({
    marketId,
    settled: false,
  }).lean();

  if (unsettledBets.length === 0) {
    return;
  }

  const perUser = new Map();
  const now = new Date();

  for (const bet of unsettledBets) {
    const won = bet.outcome === marketOutcome;
    const payout = won ? bet.shares : 0;
    const profitLoss = payout - (bet.amountSpent || 0);

    await Bet.findByIdAndUpdate(bet._id, {
      settled: true,
      settledAt: now,
      payout,
      profitLoss,
      won,
    });

    const userId = bet.userId.toString();
    const prev = perUser.get(userId) || {
      payout: 0,
      profit: 0,
      betsSettled: 0,
    };
    prev.payout += payout;
    prev.profit += profitLoss;
    prev.betsSettled += 1;
    perUser.set(userId, prev);
  }

  for (const [userId, stats] of perUser.entries()) {
    const inc = {
      balance: stats.payout,
      withdrawable: stats.payout,
    };

    if (stats.profit > 0) {
      inc.totalWon = stats.profit;
    } else if (stats.profit < 0) {
      inc.totalLost = Math.abs(stats.profit);
    }

    const userBefore = await User.findById(userId).select("balance").lean();

    await User.findByIdAndUpdate(userId, {
      $inc: inc,
    });

    await Transaction.create({
      userId,
      type: "payout",
      amount: stats.payout,
      fee: 0,
      netAmount: stats.payout,
      status: "completed",
      marketId,
      balanceBefore: userBefore?.balance || 0,
      balanceAfter: (userBefore?.balance || 0) + stats.payout,
      description: `Auto-settlement payout for ${marketQuestion || "resolved market"}`,
      processedAt: now,
    });
  }

  logger.info(
    `Auto-settled ${unsettledBets.length} bets for market ${marketId} (${marketOutcome})`,
  );
}

/**
 * Flag market for dispute investigation
 *
 * @param {string} marketId - Market ID
 * @param {string} reason - Dispute reason
 * @returns {Promise<Object>} - Updated market
 */
async function flagForDispute(marketId, reason) {
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

  logger.warn(`Market flagged for dispute: ${marketId} - ${reason}`);

  return market;
}

/**
 * Get recent market resolutions
 *
 * @param {number} limit - Number of resolutions to fetch
 * @returns {Promise<Array>} - Recent resolutions
 */
async function getRecentResolutions(limit = 20) {
  const query = `
        query GetRecentResolutions($limit: Int!) {
            conditions(
                first: $limit
                where: { resolved: true }
                orderBy: resolvedTimestamp
                orderDirection: desc
            ) {
                id
                resolved
                payoutNumerators
                resolvedTimestamp
            }
        }
    `;

  const result = await querySubgraph(query, { limit });

  return (result.conditions || []).map((condition) => {
    let outcome = null;
    if (condition.payoutNumerators) {
      const payouts = condition.payoutNumerators.map(Number);
      if (payouts[0] > payouts[1]) outcome = "YES";
      else if (payouts[1] > payouts[0]) outcome = "NO";
    }

    return {
      conditionId: condition.id,
      outcome,
      resolvedAt: new Date(condition.resolvedTimestamp * 1000),
    };
  });
}

// Start polling
let pollingInterval = null;

function startPolling() {
  if (pollingInterval) {
    return;
  }

  logger.info("Starting subgraph polling...");

  // Initial poll
  pollResolutions();

  // Set up interval
  pollingInterval = setInterval(pollResolutions, POLL_INTERVAL_MS);
}

function stopPolling() {
  if (pollingInterval) {
    clearInterval(pollingInterval);
    pollingInterval = null;
    logger.info("Subgraph polling stopped");
  }
}

module.exports = {
  querySubgraph,
  getResolutionStatus,
  getBatchResolutions,
  checkFallbackOracle,
  pollResolutions,
  flagForDispute,
  getRecentResolutions,
  startPolling,
  stopPolling,
};
