/**
 * Transaction Model
 * Comprehensive audit log for all financial operations
 */

const mongoose = require("mongoose");

const transactionSchema = new mongoose.Schema(
  {
    // User reference
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    // Transaction type
    type: {
      type: String,
      enum: [
        "deposit",
        "withdrawal",
        "trade_buy",
        "trade_sell",
        "payout",
        "fee",
        "refund",
        "adjustment",
      ],
      required: true,
    },

    // Amount details
    amount: {
      type: Number,
      required: true,
    },
    fee: {
      type: Number,
      default: 0,
    },
    netAmount: {
      type: Number,
      required: true,
    },

    // Currency info
    currency: {
      type: String,
      default: "USDC",
    },

    // Status
    status: {
      type: String,
      enum: [
        "pending",
        "processing",
        "completed",
        "failed",
        "cancelled",
        "refunded",
      ],
      default: "pending",
    },

    // Balance tracking
    balanceBefore: Number,
    balanceAfter: Number,

    // Market reference (for trades/payouts)
    marketId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Market",
    },
    betId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Bet",
    },

    // Deposit specific fields (NowPayments)
    depositDetails: {
      paymentId: String,
      paymentStatus: String,
      payAddress: String,
      payCurrency: String,
      payAmount: Number,
      actualAmountReceived: Number,
      priceCurrency: String,
      priceAmount: Number,
      ipnCallbackUrl: String,
      invoiceId: String,
      orderDescription: String,
    },

    // Withdrawal specific fields (ethers.js)
    withdrawalDetails: {
      walletAddress: String,
      txHash: String,
      network: {
        type: String,
        default: "polygon",
      },
      tokenContract: String,
      gasUsed: Number,
      gasFee: Number,
      blockNumber: Number,
      confirmations: Number,
    },

    // Fee breakdown
    spreadFee: {
      type: Number,
      default: 0,
    },
    feeType: {
      type: String,
      enum: ["trading_fee", "spread_fee", "withdrawal_fee", "deposit_fee", "none"],
      default: "none",
    },

    // Trade specific fields
    tradeDetails: {
      outcome: {
        type: String,
      },
      outcomeLabel: String,
      shares: Number,
      pricePerShare: Number,
      slippage: Number,
      qYesBefore: Number,
      qNoBefore: Number,
      qYesAfter: Number,
      qNoAfter: Number,
    },

    // Metadata
    description: String,
    notes: String,

    // Processing info
    processedAt: Date,
    failureReason: String,
    retryCount: {
      type: Number,
      default: 0,
    },

    // Security
    ipAddress: String,
    userAgent: String,
    signature: String, // Signed transaction log

    // External reference
    externalId: String,

    // Request details for audit
    requestData: mongoose.Schema.Types.Mixed,
  },
  {
    timestamps: true,
  },
);

// Indexes for efficient queries
transactionSchema.index({ type: 1, status: 1 });
transactionSchema.index({ "depositDetails.paymentId": 1 });
transactionSchema.index({ "withdrawalDetails.txHash": 1 });
transactionSchema.index({ createdAt: -1 });
transactionSchema.index({ externalId: 1 });

// Pre-save middleware to set netAmount
transactionSchema.pre("save", function (next) {
  if (this.isModified("amount") || this.isModified("fee")) {
    this.netAmount = this.amount - this.fee;
  }
  next();
});

// Static method to find by payment ID (for NowPayments webhook)
transactionSchema.statics.findByPaymentId = function (paymentId) {
  return this.findOne({ "depositDetails.paymentId": paymentId });
};

// Static method to find pending withdrawals
transactionSchema.statics.findPendingWithdrawals = function () {
  return this.find({
    type: "withdrawal",
    status: { $in: ["pending", "processing"] },
  }).populate("userId", "email walletAddress");
};

// Static method to get user transaction history
transactionSchema.statics.getUserHistory = function (userId, options = {}) {
  const query = { userId };

  if (options.type) {
    query.type = options.type;
  }

  if (options.status) {
    query.status = options.status;
  }

  return this.find(query)
    .sort({ createdAt: -1 })
    .limit(options.limit || 50)
    .skip(options.skip || 0);
};

// Method to mark as completed
transactionSchema.methods.complete = async function (additionalData = {}) {
  this.status = "completed";
  this.processedAt = new Date();
  Object.assign(this, additionalData);
  return this.save();
};

// Method to mark as failed
transactionSchema.methods.fail = async function (reason) {
  this.status = "failed";
  this.failureReason = reason;
  this.processedAt = new Date();
  return this.save();
};

const Transaction = mongoose.model("Transaction", transactionSchema);

module.exports = Transaction;
