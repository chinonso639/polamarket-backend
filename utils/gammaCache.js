/**
 * Gamma Cache Utility
 * Two-tier cache: L1 = NodeCache (in-memory), L2 = MongoDB (persistent)
 * Prevents repeated Polymarket Gamma API calls across user requests.
 */

const GammaCache = require("../models/GammaCache");
const { cache } = require("./cache");

/**
 * Read from L1 (NodeCache) first, fall back to L2 (MongoDB).
 * On L2 hit, re-warms L1 so the next request is served instantly.
 *
 * @param {string} key
 * @returns {Promise<any|null>}
 */
async function getGammaCached(key) {
  // L1 — in-memory
  const l1 = cache.get(key);
  if (l1 !== undefined) return l1;

  // L2 — MongoDB (only return if not yet expired)
  try {
    const doc = await GammaCache.findOne({
      key,
      expiresAt: { $gt: new Date() },
    }).lean();

    if (doc) {
      // Re-warm L1 for the remaining TTL
      const remainingTtl = Math.floor((doc.expiresAt - Date.now()) / 1000);
      if (remainingTtl > 0) {
        cache.set(key, doc.data, remainingTtl);
      }
      return doc.data;
    }
  } catch (_) {
    // MongoDB unavailable — continue to live fetch
  }

  return null;
}

/**
 * Write to both L1 and L2 simultaneously.
 *
 * @param {string} key
 * @param {any} data
 * @param {number} ttlSeconds  default 60
 */
async function setGammaCached(key, data, ttlSeconds = 60) {
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000);

  // L1
  cache.set(key, data, ttlSeconds);

  // L2
  try {
    await GammaCache.findOneAndUpdate(
      { key },
      { data, fetchedAt: new Date(), expiresAt },
      { upsert: true, new: true },
    );
  } catch (_) {
    // Non-fatal — L1 still works
  }
}

module.exports = { getGammaCached, setGammaCached };
