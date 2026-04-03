/**
 * Socket.IO Service
 * Real-time updates for price changes, trades, and market events
 */

const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const logger = require("../utils/logger");

let io = null;

/**
 * Initialize Socket.IO server
 *
 * @param {Object} httpServer - HTTP server instance
 * @returns {Object} - Socket.IO instance
 */
function initializeSocketIO(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: process.env.CORS_ORIGIN || "*",
      methods: ["GET", "POST"],
      credentials: true,
    },
    pingTimeout: 60000,
    pingInterval: 25000,
  });

  // Authentication middleware
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token || socket.handshake.query.token;

      if (token) {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        socket.userId = decoded.userId;
      }

      next();
    } catch (error) {
      // Allow connection without auth for public market data
      next();
    }
  });

  // Connection handler
  io.on("connection", (socket) => {
    logger.debug(
      `Socket connected: ${socket.id} (User: ${socket.userId || "anonymous"})`,
    );

    // Join user's personal room if authenticated
    if (socket.userId) {
      socket.join(`user:${socket.userId}`);
    }

    // Subscribe to market updates
    socket.on("subscribe:market", (marketId) => {
      socket.join(`market:${marketId}`);
      logger.debug(`Socket ${socket.id} subscribed to market:${marketId}`);
    });

    // Unsubscribe from market
    socket.on("unsubscribe:market", (marketId) => {
      socket.leave(`market:${marketId}`);
      logger.debug(`Socket ${socket.id} unsubscribed from market:${marketId}`);
    });

    // Subscribe to all markets (for homepage)
    socket.on("subscribe:allMarkets", () => {
      socket.join("markets:all");
    });

    // Unsubscribe from all markets
    socket.on("unsubscribe:allMarkets", () => {
      socket.leave("markets:all");
    });

    // Subscribe to user updates (requires auth)
    socket.on("subscribe:user", () => {
      if (socket.userId) {
        socket.join(`user:${socket.userId}`);
      }
    });

    // Ping/pong for connection health
    socket.on("ping", (callback) => {
      if (typeof callback === "function") {
        callback({ timestamp: Date.now() });
      }
    });

    // Disconnect handler
    socket.on("disconnect", (reason) => {
      logger.debug(`Socket disconnected: ${socket.id} - ${reason}`);
    });

    // Error handler
    socket.on("error", (error) => {
      logger.error(`Socket error: ${socket.id}`, error);
    });
  });

  logger.info("Socket.IO initialized");

  return io;
}

/**
 * Get Socket.IO instance
 *
 * @returns {Object} - Socket.IO instance
 */
function getIO() {
  if (!io) {
    throw new Error("Socket.IO not initialized");
  }
  return io;
}

/**
 * Emit market price update
 *
 * @param {string} marketId - Market ID
 * @param {Object} prices - { yesPrice, noPrice }
 */
function emitPriceUpdate(marketId, prices) {
  if (!io) return;

  io.to(`market:${marketId}`).emit("priceUpdate", {
    marketId,
    ...prices,
    timestamp: new Date(),
  });

  // Also emit to all markets room
  io.to("markets:all").emit("priceUpdate", {
    marketId,
    ...prices,
    timestamp: new Date(),
  });
}

/**
 * Emit trade event
 *
 * @param {string} marketId - Market ID
 * @param {Object} trade - Trade details
 */
function emitTrade(marketId, trade) {
  if (!io) return;

  io.to(`market:${marketId}`).emit("trade", {
    marketId,
    ...trade,
    timestamp: new Date(),
  });
}

/**
 * Emit market resolution
 *
 * @param {string} marketId - Market ID
 * @param {string} outcome - 'YES' or 'NO'
 */
function emitMarketResolved(marketId, outcome) {
  if (!io) return;

  io.to(`market:${marketId}`).emit("marketResolved", {
    marketId,
    outcome,
    timestamp: new Date(),
  });

  io.to("markets:all").emit("marketResolved", {
    marketId,
    outcome,
    timestamp: new Date(),
  });
}

/**
 * Emit market update (volume, liquidity, etc.)
 *
 * @param {string} marketId - Market ID
 * @param {Object} updates - Updated fields
 */
function emitMarketUpdate(marketId, updates) {
  if (!io) return;

  io.to(`market:${marketId}`).emit("marketUpdate", {
    marketId,
    ...updates,
    timestamp: new Date(),
  });

  io.to("markets:all").emit("marketUpdate", {
    marketId,
    ...updates,
    timestamp: new Date(),
  });
}

/**
 * Emit new market created
 *
 * @param {Object} market - Full market object
 */
function emitNewMarket(market) {
  if (!io) return;

  io.to("markets:all").emit("newMarket", market);
}

/**
 * Emit trading paused/resumed
 *
 * @param {string} marketId - Market ID
 * @param {boolean} paused - Whether trading is paused
 * @param {string} reason - Reason for pause
 */
function emitTradingStatus(marketId, paused, reason = null) {
  if (!io) return;

  const event = paused ? "tradingPaused" : "tradingResumed";

  io.to(`market:${marketId}`).emit(event, {
    marketId,
    reason,
    timestamp: new Date(),
  });
}

/**
 * Emit user balance update (private)
 *
 * @param {string} userId - User ID
 * @param {Object} balance - Balance details
 */
function emitBalanceUpdate(userId, balance) {
  if (!io) return;

  io.to(`user:${userId}`).emit("balanceUpdate", {
    ...balance,
    timestamp: new Date(),
  });
}

/**
 * Emit user position update (private)
 *
 * @param {string} userId - User ID
 * @param {Object} position - Position details
 */
function emitPositionUpdate(userId, position) {
  if (!io) return;

  io.to(`user:${userId}`).emit("positionUpdate", {
    ...position,
    timestamp: new Date(),
  });
}

/**
 * Emit deposit received (private)
 *
 * @param {string} userId - User ID
 * @param {Object} deposit - Deposit details
 */
function emitDepositReceived(userId, deposit) {
  if (!io) return;

  io.to(`user:${userId}`).emit("depositReceived", {
    ...deposit,
    timestamp: new Date(),
  });
}

/**
 * Emit withdrawal processed (private)
 *
 * @param {string} userId - User ID
 * @param {Object} withdrawal - Withdrawal details
 */
function emitWithdrawalProcessed(userId, withdrawal) {
  if (!io) return;

  io.to(`user:${userId}`).emit("withdrawalProcessed", {
    ...withdrawal,
    timestamp: new Date(),
  });
}

/**
 * Broadcast system message
 *
 * @param {string} message - System message
 * @param {string} type - Message type ('info', 'warning', 'error')
 */
function broadcastSystemMessage(message, type = "info") {
  if (!io) return;

  io.emit("systemMessage", {
    message,
    type,
    timestamp: new Date(),
  });
}

/**
 * Get connection statistics
 *
 * @returns {Object} - Connection stats
 */
async function getConnectionStats() {
  if (!io) return { connected: 0 };

  const sockets = await io.fetchSockets();

  const stats = {
    totalConnections: sockets.length,
    authenticatedUsers: sockets.filter((s) => s.userId).length,
    marketRooms: {},
    userRooms: sockets.filter((s) => s.userId).map((s) => s.userId),
  };

  // Count users per market room
  for (const socket of sockets) {
    for (const room of socket.rooms) {
      if (room.startsWith("market:")) {
        const marketId = room.split(":")[1];
        stats.marketRooms[marketId] = (stats.marketRooms[marketId] || 0) + 1;
      }
    }
  }

  return stats;
}

module.exports = {
  initializeSocketIO,
  getIO,
  emitPriceUpdate,
  emitTrade,
  emitMarketResolved,
  emitMarketUpdate,
  emitNewMarket,
  emitTradingStatus,
  emitBalanceUpdate,
  emitPositionUpdate,
  emitDepositReceived,
  emitWithdrawalProcessed,
  broadcastSystemMessage,
  getConnectionStats,
};
