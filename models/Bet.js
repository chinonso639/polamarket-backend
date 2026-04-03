/**
 * Bet Model
 * Tracks all user positions in prediction markets
 */

const mongoose = require("mongoose");

const betSchema = new mongoose.Schema(
  {
    // User reference
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: [true, "User ID is required"],
      index: true,
    },

    // Market reference
    marketId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Market",
      required: [true, "Market ID is required"],
      index: true,
    },

    // Position details
    outcome: {
      type: String,
      required: [true, "Outcome is required"],
      trim: true,
    },
    outcomeLabel: {
      type: String,
      trim: true,
    },
    shares: {
      type: Number,
      required: [true, "Shares are required"],
      min: [0.0001, "Shares must be positive"],
    },
    amountSpent: {
      type: Number,
      required: [true, "Amount spent is required"],
      min: [0, "Amount spent must be non-negative"],
    },

    // Price tracking
    avgPrice: {
      type: Number,
      required: true,
      min: [0, "Average price must be non-negative"],
      max: [1, "Average price cannot exceed 1"],
    },
    entryPrice: {
      type: Number,
      required: true,
      min: 0,
      max: 1,
    },

    // Fee tracking
    feePaid: {
      type: Number,
      default: 0,
      min: 0,
    },

    // Settlement
    settled: {
      type: Boolean,
      default: false,
    },
    settledAt: Date,
    payout: {
      type: Number,
      default: 0,
      min: 0,
    },
    profitLoss: {
      type: Number,
      default: 0,
    },
    won: {
      type: Boolean,
      default: null, // null until market is resolved
    },

    // Transaction reference
    transactionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Transaction",
    },

    // Trade execution details
    executionDetails: {
      priceBeforeTrade: Number,
      priceAfterTrade: Number,
      slippage: Number,
      qYesBefore: Number,
      qNoBefore: Number,
      qYesAfter: Number,
      qNoAfter: Number,
      bParameter: Number,
    },
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Compound index for user positions
betSchema.index({ userId: 1, marketId: 1, outcome: 1 });
betSchema.index({ settled: 1 });
betSchema.index({ createdAt: -1 });

// Virtual for current value estimate
betSchema.virtual("currentValue").get(function () {
  // This would need to be populated with current market price
  // For now, return amount spent
  return this.amountSpent;
});

// Static method to get user's position in a market
betSchema.statics.getUserPosition = async function (userId, marketId) {
  const positions = await this.find({ userId, marketId, settled: false });

  const result = {};

  for (const pos of positions) {
    if (!result[pos.outcome]) {
      result[pos.outcome] = { shares: 0, amountSpent: 0, avgPrice: 0 };
    }
    result[pos.outcome].shares += pos.shares;
    result[pos.outcome].amountSpent += pos.amountSpent;
  }

  // Calculate weighted average price
  for (const outcome of Object.keys(result)) {
    if (result[outcome].shares > 0) {
      result[outcome].avgPrice =
        result[outcome].amountSpent / result[outcome].shares;
    }
  }

  return result;
};

// Static method to get all user's active positions
betSchema.statics.getUserActivePositions = async function (userId) {
  return this.find({ userId, settled: false })
    .populate(
      "marketId",
      "question outcome resolved yesPrice noPrice outcomeStates",
    )
    .sort({ createdAt: -1 });
};

// Static method to get market position summary
betSchema.statics.getMarketPositionSummary = async function (marketId) {
  const result = await this.aggregate([
    {
      $match: {
        marketId: new mongoose.Types.ObjectId(marketId),
        settled: false,
      },
    },
    {
      $group: {
        _id: "$outcome",
        totalShares: { $sum: "$shares" },
        totalAmount: { $sum: "$amountSpent" },
        uniqueUsers: { $addToSet: "$userId" },
      },
    },
  ]);

  return result.reduce((acc, item) => {
    acc[item._id] = {
      totalShares: item.totalShares,
      totalAmount: item.totalAmount,
      uniqueTraders: item.uniqueUsers.length,
    };
    return acc;
  }, {});
};

// Method to calculate payout for this bet
betSchema.methods.calculatePayout = function (marketOutcome) {
  if (this.outcome === marketOutcome) {
    // Winner: gets back shares (since each winning share is worth 1)
    return this.shares;
  }
  return 0;
};

const Bet = mongoose.model("Bet", betSchema);

module.exports = Bet;
