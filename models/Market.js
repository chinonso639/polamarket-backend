/**
 * Market Model
 * Prediction market with LMSR-based AMM pricing
 *
 * Key LMSR parameters:
 * - qYes/qNo: Quantity of shares for each outcome
 * - b: Liquidity depth parameter (controls price sensitivity)
 * - Pricing: P(YES) = exp(qYes/b) / (exp(qYes/b) + exp(qNo/b))
 */

const mongoose = require("mongoose");

const marketSchema = new mongoose.Schema(
  {
    // Basic market info
    question: {
      type: String,
      required: [true, "Market question is required"],
      trim: true,
      maxlength: [500, "Question cannot exceed 500 characters"],
    },
    description: {
      type: String,
      trim: true,
      maxlength: [2000, "Description cannot exceed 2000 characters"],
    },
    category: {
      type: String,
      enum: [
        "politics",
        "world",
        "sports",
        "crypto",
        "entertainment",
        "science",
        "business",
        "other",
      ],
      default: "other",
    },
    tags: [
      {
        type: String,
        trim: true,
      },
    ],
    imageUrl: String,

    // LMSR AMM Core Parameters
    // These are the primary pricing system
    qYes: {
      type: Number,
      default: 0,
      min: [0, "qYes cannot be negative"],
    },
    qNo: {
      type: Number,
      default: 0,
      min: [0, "qNo cannot be negative"],
    },
    b: {
      type: Number,
      default: 100, // Liquidity depth parameter
      min: [1, "Liquidity parameter must be at least 1"],
      max: [10000, "Liquidity parameter cannot exceed 10000"],
    },

    // Secondary pool tracking (for UX and liquidity display)
    yesPool: {
      type: Number,
      default: 0,
      min: 0,
    },
    noPool: {
      type: Number,
      default: 0,
      min: 0,
    },
    virtualLiquidityBuffer: {
      type: Number,
      default: 1000, // Stabilizes price movement
      min: 0,
    },

    // Fee configuration
    feeRate: {
      type: Number,
      default: 0.02, // 2% fee
      min: [0, "Fee rate cannot be negative"],
      max: [0.1, "Fee rate cannot exceed 10%"],
    },
    totalFeesCollected: {
      type: Number,
      default: 0,
    },

    // Market resolution
    resolved: {
      type: Boolean,
      default: false,
    },
    outcome: {
      type: String,
      enum: ["YES", "NO", null],
      default: null,
    },
    resolutionSource: {
      type: String,
      trim: true,
    },
    resolvedAt: Date,
    resolvedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },

    // Market timing
    startDate: {
      type: Date,
      default: Date.now,
    },
    endDate: {
      type: Date,
      required: [true, "Market end date is required"],
    },

    // Trading controls
    isTradingActive: {
      type: Boolean,
      default: true,
    },
    tradingPausedReason: String,

    // Safety limits
    maxSlippage: {
      type: Number,
      default: 0.1, // 10% max slippage per trade
      min: 0.01,
      max: 0.5,
    },
    maxPositionPerUser: {
      type: Number,
      default: 5000, // Max position size per user
      min: 100,
    },
    minTradeAmount: {
      type: Number,
      default: 1,
      min: 0.1,
    },
    maxTradeAmount: {
      type: Number,
      default: 10000,
    },
    liquidityFloor: {
      type: Number,
      default: 100, // Minimum liquidity to maintain
      min: 10,
    },

    // Statistics
    totalVolume: {
      type: Number,
      default: 0,
    },
    totalTrades: {
      type: Number,
      default: 0,
    },
    uniqueTraders: {
      type: Number,
      default: 0,
    },

    // Price history (last 24 hours snapshot)
    priceHistory: [
      {
        timestamp: Date,
        yesPrice: Number,
        noPrice: Number,
      },
    ],

    // External market reference (Polymarket/Gamma)
    externalId: String,
    conditionId: String,
    externalSource: {
      type: String,
      enum: ["polymarket", "gamma", "internal", null],
      default: "internal",
    },

    // Dispute handling
    isDisputed: {
      type: Boolean,
      default: false,
    },
    disputeReason: String,
    disputedAt: Date,

    // Settlement info
    settlementPool: {
      type: Number,
      default: 0, // Total funds in the market for settlement
    },

    // Audit trail
    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    lastModifiedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Virtual for current YES price (LMSR formula)
marketSchema.virtual("yesPrice").get(function () {
  const expYes = Math.exp(this.qYes / this.b);
  const expNo = Math.exp(this.qNo / this.b);
  return expYes / (expYes + expNo);
});

// Virtual for current NO price
marketSchema.virtual("noPrice").get(function () {
  return 1 - this.yesPrice;
});

// Virtual for total liquidity
marketSchema.virtual("totalLiquidity").get(function () {
  return this.yesPool + this.noPool + this.virtualLiquidityBuffer;
});

// Virtual for market status
marketSchema.virtual("status").get(function () {
  if (this.resolved) return "resolved";
  if (!this.isTradingActive) return "paused";
  if (new Date() > this.endDate) return "expired";
  if (new Date() < this.startDate) return "upcoming";
  return "active";
});

// Virtual for price change (24h)
marketSchema.virtual("priceChange24h").get(function () {
  if (!this.priceHistory || this.priceHistory.length < 2) return 0;

  const now = Date.now();
  const oneDayAgo = now - 24 * 60 * 60 * 1000;

  // Find the oldest price within 24 hours
  const oldPrice = this.priceHistory.find(
    (p) => new Date(p.timestamp).getTime() >= oneDayAgo,
  );

  if (!oldPrice) return 0;

  const currentPrice = this.yesPrice;
  return ((currentPrice - oldPrice.yesPrice) / oldPrice.yesPrice) * 100;
});

// Indexes for efficient queries
marketSchema.index({ category: 1, isTradingActive: 1 });
marketSchema.index({ resolved: 1 });
marketSchema.index({ endDate: 1 });
marketSchema.index({ totalVolume: -1 });
marketSchema.index({ createdAt: -1 });
marketSchema.index({ externalId: 1 });
marketSchema.index({ conditionId: 1 });
marketSchema.index({ tags: 1 });

// Static method to find active markets
marketSchema.statics.findActive = function () {
  return this.find({
    resolved: false,
    isTradingActive: true,
    startDate: { $lte: new Date() },
    endDate: { $gt: new Date() },
  });
};

// Static method to find trending markets
marketSchema.statics.findTrending = function (limit = 10) {
  return this.find({
    resolved: false,
    isTradingActive: true,
  })
    .sort({ totalVolume: -1, totalTrades: -1 })
    .limit(limit);
};

// Method to check if user can trade
marketSchema.methods.canTrade = function () {
  if (this.resolved) return { allowed: false, reason: "Market is resolved" };
  if (!this.isTradingActive)
    return {
      allowed: false,
      reason: this.tradingPausedReason || "Trading is paused",
    };
  if (new Date() > this.endDate)
    return { allowed: false, reason: "Market has expired" };
  if (new Date() < this.startDate)
    return { allowed: false, reason: "Market not started yet" };
  return { allowed: true };
};

// Method to record price snapshot
marketSchema.methods.recordPriceSnapshot = async function () {
  const snapshot = {
    timestamp: new Date(),
    yesPrice: this.yesPrice,
    noPrice: this.noPrice,
  };

  // Keep only last 288 snapshots (24 hours at 5-minute intervals)
  if (this.priceHistory.length >= 288) {
    this.priceHistory.shift();
  }

  this.priceHistory.push(snapshot);
  await this.save();
};

const Market = mongoose.model("Market", marketSchema);

module.exports = Market;
