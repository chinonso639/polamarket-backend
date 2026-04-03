/**
 * Cache Utility
 * In-memory caching with TTL for market prices and frequently accessed data
 */

const NodeCache = require("node-cache");

// Create cache instance with default TTL of 30 seconds
const cache = new NodeCache({
  stdTTL: parseInt(process.env.CACHE_TTL_SECONDS) || 30,
  checkperiod: 60, // Check for expired keys every 60 seconds
  useClones: false, // Store references for better performance
});

/**
 * Get cached value or fetch and cache it
 *
 * @param {string} key - Cache key
 * @param {Function} fetchFn - Function to fetch data if not cached
 * @param {number} ttl - Time to live in seconds (optional)
 * @returns {Promise<any>} - Cached or fetched data
 */
async function getOrSet(key, fetchFn, ttl = null) {
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const data = await fetchFn();
  if (ttl) {
    cache.set(key, data, ttl);
  } else {
    cache.set(key, data);
  }

  return data;
}

/**
 * Cache keys for different data types
 */
const CACHE_KEYS = {
  MARKET_PRICES: (marketId) => `market:prices:${marketId}`,
  MARKET_DETAILS: (marketId) => `market:details:${marketId}`,
  USER_POSITIONS: (userId, marketId) => `user:positions:${userId}:${marketId}`,
  TRENDING_MARKETS: "markets:trending",
  ACTIVE_MARKETS: "markets:active",
  USER_BALANCE: (userId) => `user:balance:${userId}`,
};

/**
 * Invalidate cache entries matching a pattern
 *
 * @param {string} pattern - Pattern to match (prefix)
 */
function invalidatePattern(pattern) {
  const keys = cache.keys();
  const matchingKeys = keys.filter((key) => key.startsWith(pattern));
  cache.del(matchingKeys);
}

/**
 * Clear all cache entries for a market
 *
 * @param {string} marketId - Market ID
 */
function invalidateMarket(marketId) {
  invalidatePattern(`market:prices:${marketId}`);
  invalidatePattern(`market:details:${marketId}`);
  cache.del(CACHE_KEYS.TRENDING_MARKETS);
  cache.del(CACHE_KEYS.ACTIVE_MARKETS);
}

/**
 * Clear all cache entries for a user
 *
 * @param {string} userId - User ID
 */
function invalidateUser(userId) {
  invalidatePattern(`user:positions:${userId}`);
  cache.del(CACHE_KEYS.USER_BALANCE(userId));
}

/**
 * Get cache statistics
 */
function getStats() {
  return {
    keys: cache.keys().length,
    hits: cache.getStats().hits,
    misses: cache.getStats().misses,
    ksize: cache.getStats().ksize,
    vsize: cache.getStats().vsize,
  };
}

module.exports = {
  cache,
  getOrSet,
  CACHE_KEYS,
  invalidatePattern,
  invalidateMarket,
  invalidateUser,
  getStats,
};
