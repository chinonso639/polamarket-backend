/**
 * Gamma API Integration
 * Fetches markets from Polymarket's Gamma API
 */

const axios = require("axios");
const Market = require("../models/Market");
const logger = require("../utils/logger");
const { normalizeExternalLiquidity } = require("../amm/lmsr");

const GAMMA_API_URL =
  process.env.GAMMA_API_URL || "https://gamma-api.polymarket.com";

// Create axios instance
const api = axios.create({
  baseURL: GAMMA_API_URL,
  timeout: 30000,
  headers: {
    Accept: "application/json",
  },
});

/**
 * Fetch markets from Gamma API
 *
 * @param {Object} params - Query parameters
 * @returns {Promise<Array>} - Markets
 */
async function fetchMarkets(params = {}) {
  try {
    const response = await api.get("/markets", {
      params: {
        limit: params.limit || 100,
        offset: params.offset || 0,
        active: params.active !== false,
        closed: params.closed || false,
        ...params,
      },
    });

    return response.data;
  } catch (error) {
    logger.error("Failed to fetch markets from Gamma:", error.message);
    throw error;
  }
}

/**
 * Fetch single market details
 *
 * @param {string} conditionId - Market condition ID
 * @returns {Promise<Object>} - Market details
 */
async function fetchMarketByCondition(conditionId) {
  try {
    const response = await api.get(`/markets/${conditionId}`);
    return response.data;
  } catch (error) {
    logger.error(`Failed to fetch market ${conditionId}:`, error.message);
    throw error;
  }
}

/**
 * Fetch market events (bets/trades)
 *
 * @param {string} conditionId - Market condition ID
 * @returns {Promise<Array>} - Events
 */
async function fetchMarketEvents(conditionId) {
  try {
    const response = await api.get(`/markets/${conditionId}/events`);
    return response.data;
  } catch (error) {
    logger.error(`Failed to fetch events for ${conditionId}:`, error.message);
    throw error;
  }
}

/**
 * Transform Gamma market to internal format
 *
 * @param {Object} gammaMarket - Market from Gamma API
 * @returns {Object} - Internal market format
 */
function transformMarket(gammaMarket) {
  // Gamma API returns outcomes as a stringified JSON array in some responses
  let rawOutcomes = gammaMarket.outcomes || [];
  if (typeof rawOutcomes === "string") {
    try {
      rawOutcomes = JSON.parse(rawOutcomes);
    } catch {
      rawOutcomes = [];
    }
  }
  if (!Array.isArray(rawOutcomes)) rawOutcomes = [];

  // Normalise: Gamma sometimes returns plain strings ["Yes","No"] instead of objects
  const outcomes = rawOutcomes.map((o) =>
    typeof o === "string" ? { name: o, outcome: o, price: 0.5 } : o,
  );

  const yesOutcome = outcomes.find(
    (o) => o.name === "Yes" || o.outcome === "Yes",
  );
  const noOutcome = outcomes.find((o) => o.name === "No" || o.outcome === "No");

  // Calculate initial q values from prices
  const yesPrice = yesOutcome?.price || 0.5;
  const noPrice = noOutcome?.price || 0.5;

  // Normalize external liquidity to internal b parameter
  const liquidity = gammaMarket.liquidity || 10000;
  const volume = gammaMarket.volume || 1000;
  const b = normalizeExternalLiquidity(liquidity, volume);

  // Calculate q values from prices: P(YES) = exp(qYes/b) / (exp(qYes/b) + exp(qNo/b))
  // For simplicity, we set qNo = 0 and solve for qYes
  const qYes =
    yesPrice > 0 && yesPrice < 1 ? b * Math.log(yesPrice / (1 - yesPrice)) : 0;

  return {
    question: gammaMarket.question || gammaMarket.title,
    description: gammaMarket.description,
    category: mapCategory(gammaMarket.category),
    endDate: new Date(gammaMarket.endDate || gammaMarket.resolution_time),
    qYes: Math.max(0, qYes),
    qNo: 0,
    b,
    yesPool: liquidity * yesPrice,
    noPool: liquidity * noPrice,
    virtualLiquidityBuffer: liquidity * 0.2,
    feeRate: 0.02,
    totalVolume: volume,
    externalId: gammaMarket.id,
    conditionId: gammaMarket.conditionId || gammaMarket.condition_id,
    externalSource: "polymarket",
    imageUrl: gammaMarket.image || gammaMarket.icon,
    tags: gammaMarket.tags || [],
  };
}

/**
 * Map external category to internal categories
 *
 * @param {string} externalCategory - External category
 * @returns {string} - Internal category
 */
function mapCategory(externalCategory) {
  const categoryMap = {
    politics: "politics",
    political: "politics",
    world: "world",
    global: "world",
    sports: "sports",
    sport: "sports",
    crypto: "crypto",
    cryptocurrency: "crypto",
    entertainment: "entertainment",
    "pop culture": "entertainment",
    science: "science",
    tech: "science",
    business: "business",
    finance: "business",
    economics: "business",
  };

  const lowerCategory = (externalCategory || "").toLowerCase();
  return categoryMap[lowerCategory] || "other";
}

/**
 * Sync markets from Gamma API
 *
 * @param {Object} options - Sync options
 * @returns {Promise<Object>} - Sync results
 */
async function syncMarkets(options = {}) {
  logger.info("Starting Gamma market sync...");

  const results = {
    fetched: 0,
    created: 0,
    updated: 0,
    errors: [],
  };

  try {
    let offset = 0;
    const limit = 50;
    let hasMore = true;

    while (hasMore) {
      const markets = await fetchMarkets({
        limit,
        offset,
        active: options.includeInactive ? undefined : true,
      });

      results.fetched += markets.length;

      for (const gammaMarket of markets) {
        try {
          const marketData = transformMarket(gammaMarket);

          // Check if market exists
          const existing = await Market.findOne({
            conditionId: marketData.conditionId,
          });

          if (existing) {
            // Update if volume changed significantly
            if (Math.abs(existing.totalVolume - marketData.totalVolume) > 100) {
              await Market.findByIdAndUpdate(existing._id, {
                totalVolume: marketData.totalVolume,
                yesPool: marketData.yesPool,
                noPool: marketData.noPool,
              });
              results.updated++;
            }
          } else {
            // Create new market
            const market = new Market(marketData);
            await market.save();
            results.created++;
          }
        } catch (error) {
          results.errors.push({
            marketId: gammaMarket.id,
            error: error.message,
          });
        }
      }

      offset += limit;
      hasMore = markets.length === limit;

      // Rate limiting
      if (hasMore) {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

    logger.info(
      `Gamma sync complete: ${results.created} created, ${results.updated} updated`,
    );
  } catch (error) {
    logger.error("Gamma sync failed:", error);
    results.errors.push({ error: error.message });
  }

  return results;
}

/**
 * Get trending markets from Gamma
 *
 * @param {number} limit - Number of markets
 * @returns {Promise<Array>} - Trending markets
 */
async function getTrendingMarkets(limit = 10) {
  try {
    const response = await api.get("/markets/trending", {
      params: { limit },
    });
    return response.data.map(transformMarket);
  } catch (error) {
    logger.error("Failed to get trending markets:", error.message);
    throw error;
  }
}

module.exports = {
  fetchMarkets,
  fetchMarketByCondition,
  fetchMarketEvents,
  transformMarket,
  syncMarkets,
  getTrendingMarkets,
};
