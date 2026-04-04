/**
 * User Model
 * Handles user accounts, balances, and wallet information
 */

const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: [true, "Email is required"],
      unique: true,
      lowercase: true,
      trim: true,
      match: [
        /^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/,
        "Invalid email format",
      ],
    },
    password: {
      type: String,
      required: [true, "Password is required"],
      minlength: [8, "Password must be at least 8 characters"],
      select: false, // Don't include password in queries by default
    },
    username: {
      type: String,
      unique: true,
      sparse: true, // Allow null values while maintaining uniqueness
      trim: true,
      minlength: [3, "Username must be at least 3 characters"],
      maxlength: [30, "Username cannot exceed 30 characters"],
    },

    // Financial balances
    balance: {
      type: Number,
      default: 0,
      min: [0, "Balance cannot be negative"],
    },
    withdrawable: {
      type: Number,
      default: 0,
      min: [0, "Withdrawable amount cannot be negative"],
    },
    lockedBalance: {
      type: Number,
      default: 0,
      min: [0, "Locked balance cannot be negative"],
    },

    // Crypto wallet
    walletAddress: {
      type: String,
      trim: true,
      match: [/^0x[a-fA-F0-9]{40}$/, "Invalid Ethereum address format"],
    },

    // Risk management
    riskLevel: {
      type: String,
      enum: ["low", "medium", "high"],
      default: "medium",
    },
    maxPositionSize: {
      type: Number,
      default: 1000, // Maximum position size per market
    },

    // Account status
    isVerified: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
    isBanned: {
      type: Boolean,
      default: false,
    },
    banReason: String,
    role: {
      type: String,
      enum: ["user", "admin"],
      default: "user",
    },

    // Trading statistics
    totalDeposited: {
      type: Number,
      default: 0,
    },
    totalWithdrawn: {
      type: Number,
      default: 0,
    },
    totalWagered: {
      type: Number,
      default: 0,
    },
    totalWon: {
      type: Number,
      default: 0,
    },
    totalLost: {
      type: Number,
      default: 0,
    },
    tradesCount: {
      type: Number,
      default: 0,
    },

    // Rate limiting and security
    lastTradeAt: Date,
    lastWithdrawalAt: Date,
    lastLoginAt: Date,
    loginAttempts: {
      type: Number,
      default: 0,
    },
    lockUntil: Date,

    // Two-factor authentication
    twoFactorEnabled: {
      type: Boolean,
      default: false,
    },
    twoFactorSecret: {
      type: String,
      select: false,
    },

    // API keys for programmatic access
    apiKey: {
      type: String,
      select: false,
    },
    apiKeyLastUsed: Date,
  },
  {
    timestamps: true,
    toJSON: { virtuals: true },
    toObject: { virtuals: true },
  },
);

// Virtual for total profit/loss
userSchema.virtual("profitLoss").get(function () {
  return this.totalWon - this.totalLost;
});

// Virtual for win rate
userSchema.virtual("winRate").get(function () {
  if (this.tradesCount === 0) return 0;
  return (this.totalWon / (this.totalWon + this.totalLost)) * 100;
});

// Index for efficient queries
userSchema.index({ email: 1 });
userSchema.index({ username: 1 });
userSchema.index({ walletAddress: 1 });
userSchema.index({ createdAt: -1 });

// Pre-save middleware to hash password
userSchema.pre("save", async function (next) {
  // Only hash password if it's modified
  if (!this.isModified("password")) return next();

  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Method to compare password
userSchema.methods.comparePassword = async function (candidatePassword) {
  return bcrypt.compare(candidatePassword, this.password);
};

// Method to check if account is locked
userSchema.methods.isLocked = function () {
  return this.lockUntil && this.lockUntil > Date.now();
};

// Method to increment login attempts
userSchema.methods.incrementLoginAttempts = async function () {
  // Reset attempts if lock has expired
  if (this.lockUntil && this.lockUntil < Date.now()) {
    return this.updateOne({
      $set: { loginAttempts: 1 },
      $unset: { lockUntil: 1 },
    });
  }

  const updates = { $inc: { loginAttempts: 1 } };

  // Lock account after 5 failed attempts for 2 hours
  if (this.loginAttempts + 1 >= 5) {
    updates.$set = { lockUntil: Date.now() + 2 * 60 * 60 * 1000 };
  }

  return this.updateOne(updates);
};

// Static method to find by credentials
userSchema.statics.findByCredentials = async function (email, password) {
  const user = await this.findOne({ email }).select("+password");
  if (!user) return null;

  const isMatch = await user.comparePassword(password);
  if (!isMatch) return null;

  return user;
};

// Method to safely return user data (without sensitive fields)
userSchema.methods.toSafeObject = function () {
  const obj = this.toObject();
  delete obj.password;
  delete obj.twoFactorSecret;
  delete obj.apiKey;
  delete obj.__v;
  return obj;
};

const User = mongoose.model("User", userSchema);

module.exports = User;
