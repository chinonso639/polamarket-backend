/**
 * Scheduled Jobs
 * Handles periodic tasks: price snapshots, resolution polling, queue processing
 */

const cron = require("node-cron");
const Market = require("../models/Market");
const Transaction = require("../models/Transaction");
const User = require("../models/User");
const { subgraphOracle } = require("../oracles");
const withdrawalService = require("../services/withdrawalService");
const logger = require("../utils/logger");
const { getPrices } = require("../amm/lmsr");
const gammaApi = require("../oracles/gammaApi");
const { setGammaCached } = require("../utils/gammaCache");

/**
 * Price snapshot collection
 * Stores historical price data for charts
 */
async function collectPriceSnapshots() {
  try {
    const markets = await Market.find({
      resolved: false,
      isTradingActive: true,
    }).select("_id qYes qNo b");

    const snapshots = [];
    const now = new Date();

    for (const market of markets) {
      const prices = getPrices(market);

      // Store in price history array (within market doc for simplicity)
      await Market.findByIdAndUpdate(market._id, {
        $push: {
          priceHistory: {
            $each: [
              {
                yesPrice: prices.yesPrice,
                noPrice: prices.noPrice,
                timestamp: now,
              },
            ],
            $slice: -1440, // Keep last 24 hours of minute data
          },
        },
        lastPriceUpdate: now,
      });

      snapshots.push({
        marketId: market._id,
        yesPrice: prices.yesPrice,
        noPrice: prices.noPrice,
      });
    }

    logger.debug(`Collected ${snapshots.length} price snapshots`);
  } catch (error) {
    logger.error("Price snapshot collection failed:", error);
  }
}

/**
 * Resolution polling
 * Checks external sources for market resolution status
 */
async function pollResolutions() {
  try {
    await subgraphOracle.pollResolutions();
  } catch (error) {
    logger.error("Resolution polling failed:", error);
  }
}

/**
 * Process withdrawal queue
 * Processes pending withdrawals
 */
async function processWithdrawalQueue() {
  try {
    await withdrawalService.processWithdrawalQueue();
  } catch (error) {
    logger.error("Withdrawal queue processing failed:", error);
  }
}

/**
 * Cleanup expired sessions/tokens
 */
async function cleanupExpiredData() {
  try {
    // Clean up expired refresh tokens
    await User.updateMany(
      { "refreshTokens.expiresAt": { $lt: new Date() } },
      { $pull: { refreshTokens: { expiresAt: { $lt: new Date() } } } },
    );

    // Clean up old price history (keep last 7 days)
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    await Market.updateMany(
      {},
      { $pull: { priceHistory: { timestamp: { $lt: weekAgo } } } },
    );

    logger.debug("Expired data cleanup completed");
  } catch (error) {
    logger.error("Cleanup job failed:", error);
  }
}

/**
 * Calculate and cache market statistics
 */
async function updateMarketStats() {
  try {
    const markets = await Market.find({ resolved: false });

    for (const market of markets) {
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      // Get 24h volume from transactions
      const volumeResult = await Transaction.aggregate([
        {
          $match: {
            marketId: market._id,
            type: "BET",
            createdAt: { $gte: oneDayAgo },
          },
        },
        {
          $group: {
            _id: null,
            volume: { $sum: "$amount" },
            trades: { $sum: 1 },
          },
        },
      ]);

      const stats = volumeResult[0] || { volume: 0, trades: 0 };

      await Market.findByIdAndUpdate(market._id, {
        "stats.volume24h": stats.volume,
        "stats.trades24h": stats.trades,
        "stats.lastUpdated": new Date(),
      });
    }

    logger.debug("Market stats updated");
  } catch (error) {
    logger.error("Market stats update failed:", error);
  }
}

/**
 * Check for markets approaching resolution deadline
 */
async function checkResolutionDeadlines() {
  try {
    const soon = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    const approachingMarkets = await Market.find({
      resolved: false,
      resolutionTime: { $lte: soon, $gt: new Date() },
    }).select("_id question resolutionTime");

    for (const market of approachingMarkets) {
      logger.info(
        `Market approaching resolution: ${market.question} at ${market.resolutionTime}`,
      );
      // TODO: Send notifications to users with positions
    }
  } catch (error) {
    logger.error("Resolution deadline check failed:", error);
  }
}

/**
 * Retry failed withdrawals
 */
async function retryFailedWithdrawals() {
  try {
    const failedWithdrawals = await Transaction.find({
      type: "WITHDRAWAL",
      status: "FAILED",
      retryCount: { $lt: 3 },
      createdAt: { $gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
    });

    for (const tx of failedWithdrawals) {
      logger.info(`Retrying failed withdrawal: ${tx._id}`);
      await withdrawalService.retryWithdrawal(tx._id);
    }
  } catch (error) {
    logger.error("Retry failed withdrawals job failed:", error);
  }
}

/**
 * Generate daily reports
 */
async function generateDailyReport() {
  try {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // Get daily stats
    const [deposits, withdrawals, bets, newUsers, resolvedMarkets] =
      await Promise.all([
        Transaction.aggregate([
          {
            $match: {
              type: "DEPOSIT",
              status: "COMPLETED",
              createdAt: { $gte: yesterday, $lt: today },
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ]),
        Transaction.aggregate([
          {
            $match: {
              type: "WITHDRAWAL",
              status: "COMPLETED",
              createdAt: { $gte: yesterday, $lt: today },
            },
          },
          {
            $group: {
              _id: null,
              total: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ]),
        Transaction.aggregate([
          {
            $match: { type: "BET", createdAt: { $gte: yesterday, $lt: today } },
          },
          {
            $group: {
              _id: null,
              total: { $sum: "$amount" },
              count: { $sum: 1 },
            },
          },
        ]),
        User.countDocuments({ createdAt: { $gte: yesterday, $lt: today } }),
        Market.countDocuments({ resolvedAt: { $gte: yesterday, $lt: today } }),
      ]);

    const report = {
      date: yesterday.toISOString().split("T")[0],
      deposits: deposits[0] || { total: 0, count: 0 },
      withdrawals: withdrawals[0] || { total: 0, count: 0 },
      bets: bets[0] || { total: 0, count: 0 },
      newUsers,
      resolvedMarkets,
    };

    logger.info("Daily report:", report);

    // TODO: Store report or send to admin
  } catch (error) {
    logger.error("Daily report generation failed:", error);
  }
}

/**
 * Gamma API pre-warm job
 * Fetches trending, markets and categories every 30 seconds so
 * controllers never hit Gamma directly on user requests.
 */
async function syncGammaMarkets() {
  try {
    const axios = require("axios");
    const GAMMA_URL =
      process.env.GAMMA_API_URL || "https://gamma-api.polymarket.com";

    // --- trending: mirror controller logic — fetch from /events ---
    let trendingMarkets = [];
    try {
      const eventsRes = await axios.get(`${GAMMA_URL}/events`, {
        params: {
          limit: 200,
          order: "volume",
          ascending: false,
          active: true,
          closed: false,
        },
        timeout: 15000,
        headers: { Accept: "application/json" },
      });
      const events = Array.isArray(eventsRes.data)
        ? eventsRes.data
        : eventsRes.data.events || [];
      for (const event of events) {
        const eventMarkets = Array.isArray(event.markets) ? event.markets : [];
        const eventTags = Array.isArray(event.tags) ? event.tags : [];
        const active = eventMarkets.filter(
          (m) => !m.closed && m.active !== false,
        );
        trendingMarkets = [
          ...trendingMarkets,
          ...active.map((m) => ({
            ...m,
            tags: [...eventTags, ...(m.tags || [])],
            siblingCount: active.length,
            eventId: event.id,
          })),
        ];
      }
    } catch (err) {
      logger.warn(`[syncGammaMarkets] events fetch failed: ${err.message}`);
    }
    // dedup
    const seenT = new Set();
    trendingMarkets = trendingMarkets.filter((m) => {
      const id = m.id || m.condition_id || m.conditionId;
      if (seenT.has(id)) return false;
      seenT.add(id);
      return true;
    });
    if (trendingMarkets.length > 0) {
      await setGammaCached("gamma:trending:raw", trendingMarkets, 60);
    }

    // --- markets page 0 ---
    try {
      const marketsRes = await gammaApi.fetchMarkets({
        limit: 50,
        offset: 0,
        active: true,
        closed: false,
      });
      const markets = Array.isArray(marketsRes)
        ? marketsRes
        : marketsRes.markets || marketsRes.data || [];
      if (markets.length > 0) {
        await setGammaCached("gamma:markets:0", markets, 60);
      }
    } catch (err) {
      logger.warn(`[syncGammaMarkets] markets fetch failed: ${err.message}`);
    }

    // --- categories: 3 batches → transform → compute counts → cache final ---
    let allForCategories = [];
    for (let i = 0; i < 3; i++) {
      try {
        const batchRes = await gammaApi.fetchMarkets({
          limit: 100,
          offset: i * 100,
          active: true,
          closed: false,
        });
        const batch = Array.isArray(batchRes)
          ? batchRes
          : batchRes.markets || batchRes.data || [];
        allForCategories = allForCategories.concat(batch);
      } catch (err) {
        logger.warn(
          `[syncGammaMarkets] categories batch ${i} failed: ${err.message}`,
        );
      }
    }
    if (allForCategories.length > 0) {
      // dedup
      const seenC = new Set();
      allForCategories = allForCategories.filter((m) => {
        const id = m.id || m.condition_id || m.conditionId;
        if (seenC.has(id)) return false;
        seenC.add(id);
        return true;
      });
      try {
        // arrow wrapper preserves gammaApi module closure for transformMarket
        const transformed = allForCategories.map((m) =>
          gammaApi.transformMarket(m),
        );
        const counts = transformed.reduce((acc, m) => {
          acc[m.category] = (acc[m.category] || 0) + 1;
          return acc;
        }, {});
        const categories = Object.entries(counts)
          .map(([name, count]) => ({ name, count }))
          .sort((a, b) => b.count - a.count);
        await setGammaCached("gamma:categories", categories, 60);
      } catch (err) {
        logger.warn(
          `[syncGammaMarkets] categories transform failed: ${err.message || String(err)}`,
        );
      }
    }

    logger.debug(
      `[syncGammaMarkets] synced trending=${trendingMarkets.length} categories=${allForCategories.length}`,
    );
  } catch (error) {
    logger.warn(
      `[syncGammaMarkets] sync failed: ${error.message || String(error)}`,
    );
  }
}

// Job definitions
const jobs = [];

/**
 * Initialize all scheduled jobs
 */
function initJobs() {
  logger.info("Initializing scheduled jobs...");

  // Price snapshots - every minute
  jobs.push(
    cron.schedule("* * * * *", collectPriceSnapshots, {
      scheduled: true,
      timezone: "UTC",
    }),
  );

  // Resolution polling - every 45 seconds
  jobs.push(
    cron.schedule("*/45 * * * * *", pollResolutions, {
      scheduled: true,
      timezone: "UTC",
    }),
  );

  // Gamma API cache sync - every 30 seconds
  syncGammaMarkets(); // pre-warm immediately on startup
  jobs.push(
    cron.schedule("*/30 * * * * *", syncGammaMarkets, {
      scheduled: true,
      timezone: "UTC",
    }),
  );

  // Withdrawal queue - every 5 minutes
  jobs.push(
    cron.schedule("*/5 * * * *", processWithdrawalQueue, {
      scheduled: true,
      timezone: "UTC",
    }),
  );

  // Market stats update - every 5 minutes
  jobs.push(
    cron.schedule("*/5 * * * *", updateMarketStats, {
      scheduled: true,
      timezone: "UTC",
    }),
  );

  // Cleanup - every hour
  jobs.push(
    cron.schedule("0 * * * *", cleanupExpiredData, {
      scheduled: true,
      timezone: "UTC",
    }),
  );

  // Resolution deadline check - every 6 hours
  jobs.push(
    cron.schedule("0 */6 * * *", checkResolutionDeadlines, {
      scheduled: true,
      timezone: "UTC",
    }),
  );

  // Retry failed withdrawals - every hour
  jobs.push(
    cron.schedule("30 * * * *", retryFailedWithdrawals, {
      scheduled: true,
      timezone: "UTC",
    }),
  );

  // Daily report - at midnight UTC
  jobs.push(
    cron.schedule("0 0 * * *", generateDailyReport, {
      scheduled: true,
      timezone: "UTC",
    }),
  );

  logger.info(`Initialized ${jobs.length} scheduled jobs`);
}

/**
 * Stop all scheduled jobs
 */
function stopJobs() {
  for (const job of jobs) {
    job.stop();
  }
  jobs.length = 0;
  logger.info("All scheduled jobs stopped");
}

module.exports = {
  initJobs,
  initializeJobs: initJobs, // Alias for server.js
  stopJobs,
  collectPriceSnapshots,
  pollResolutions,
  syncGammaMarkets,
  processWithdrawalQueue,
  cleanupExpiredData,
  updateMarketStats,
  checkResolutionDeadlines,
  retryFailedWithdrawals,
  generateDailyReport,
};
