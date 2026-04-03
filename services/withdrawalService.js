/**
 * Withdrawal Service
 * Handles crypto withdrawals via ethers.js on Polygon network
 */

const { ethers } = require("ethers");
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const logger = require("../utils/logger");
const {
  signTransactionLog,
  generateTransactionId,
} = require("../utils/crypto");
const {
  emitWithdrawalProcessed,
  emitBalanceUpdate,
} = require("./socketService");

// Network configuration
const POLYGON_RPC = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
const PRIVATE_KEY = process.env.PRIVATE_KEY;

// Token contracts on Polygon
const TOKENS = {
  USDT: {
    address:
      process.env.USDT_CONTRACT_ADDRESS ||
      "0xc2132D05D31c914a87C6611C10748AEb04B58e8F",
    decimals: 6,
  },
  USDC: {
    address:
      process.env.USDC_CONTRACT_ADDRESS ||
      "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    decimals: 6,
  },
};

// ERC20 ABI (minimal for transfers)
const ERC20_ABI = [
  "function transfer(address to, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function decimals() view returns (uint8)",
];

// Withdrawal queue
const withdrawalQueue = [];
let isProcessing = false;

// Rate limiting
const userLastWithdrawal = new Map();
const WITHDRAWAL_COOLDOWN_MS =
  parseInt(process.env.WITHDRAWAL_COOLDOWN_MINUTES || 60) * 60 * 1000;

// Limits
const MIN_WITHDRAWAL = parseFloat(process.env.MIN_WITHDRAWAL_AMOUNT) || 10;
const MAX_WITHDRAWAL = parseFloat(process.env.MAX_WITHDRAWAL_AMOUNT) || 50000;

/**
 * Initialize ethers provider and wallet
 */
let provider = null;
let wallet = null;

function isValidPrivateKey(key) {
  if (!key) return false;
  // Valid private key is 64 hex chars or 66 with 0x prefix
  const cleanKey = key.startsWith("0x") ? key.slice(2) : key;
  return /^[a-fA-F0-9]{64}$/.test(cleanKey);
}

function initializeEthers() {
  if (!PRIVATE_KEY || !isValidPrivateKey(PRIVATE_KEY)) {
    logger.warn("No valid private key configured - withdrawals disabled");
    return false;
  }

  try {
    provider = new ethers.JsonRpcProvider(POLYGON_RPC);
    wallet = new ethers.Wallet(PRIVATE_KEY, provider);
    logger.info(`Withdrawal wallet initialized: ${wallet.address}`);
    return true;
  } catch (error) {
    logger.error("Failed to initialize ethers:", error);
    return false;
  }
}

// Initialize on module load
initializeEthers();

/**
 * Get withdrawal wallet info (balance, etc.)
 *
 * @returns {Promise<Object>} - Wallet info
 */
async function getWalletInfo() {
  if (!wallet) {
    throw new Error("Wallet not initialized");
  }

  const [maticBalance, usdtBalance, usdcBalance] = await Promise.all([
    provider.getBalance(wallet.address),
    getTokenBalance(TOKENS.USDT.address),
    getTokenBalance(TOKENS.USDC.address),
  ]);

  return {
    address: wallet.address,
    balances: {
      MATIC: ethers.formatEther(maticBalance),
      USDT: ethers.formatUnits(usdtBalance, TOKENS.USDT.decimals),
      USDC: ethers.formatUnits(usdcBalance, TOKENS.USDC.decimals),
    },
  };
}

/**
 * Get token balance
 *
 * @param {string} tokenAddress - Token contract address
 * @returns {Promise<BigInt>} - Balance
 */
async function getTokenBalance(tokenAddress) {
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  return contract.balanceOf(wallet.address);
}

/**
 * Check if user can withdraw
 *
 * @param {string} userId - User ID
 * @returns {Object} - { allowed, reason, waitTime }
 */
function checkWithdrawalCooldown(userId) {
  const lastWithdrawal = userLastWithdrawal.get(userId);

  if (lastWithdrawal) {
    const elapsed = Date.now() - lastWithdrawal;
    if (elapsed < WITHDRAWAL_COOLDOWN_MS) {
      return {
        allowed: false,
        reason: "Withdrawal cooldown active",
        waitTime: WITHDRAWAL_COOLDOWN_MS - elapsed,
      };
    }
  }

  return { allowed: true };
}

/**
 * Request a withdrawal
 *
 * @param {Object} params
 * @param {string} params.userId - User ID
 * @param {number} params.amount - Amount in USD
 * @param {string} params.token - 'USDT' or 'USDC'
 * @param {string} params.walletAddress - Destination wallet address
 * @returns {Promise<Object>} - Withdrawal request
 */
async function requestWithdrawal({
  userId,
  amount,
  token = "USDT",
  walletAddress,
}) {
  // Validate amount
  if (amount < MIN_WITHDRAWAL) {
    throw new Error(`Minimum withdrawal is $${MIN_WITHDRAWAL}`);
  }

  if (amount > MAX_WITHDRAWAL) {
    throw new Error(`Maximum withdrawal is $${MAX_WITHDRAWAL}`);
  }

  // Validate token
  if (!TOKENS[token]) {
    throw new Error("Invalid token. Use USDT or USDC");
  }

  // Validate wallet address
  if (!ethers.isAddress(walletAddress)) {
    throw new Error("Invalid wallet address");
  }

  // Check cooldown
  const cooldownCheck = checkWithdrawalCooldown(userId);
  if (!cooldownCheck.allowed) {
    throw new Error(
      `${cooldownCheck.reason}. Wait ${Math.ceil(cooldownCheck.waitTime / 60000)} minutes.`,
    );
  }

  // Get user
  const user = await User.findById(userId);

  if (!user) {
    throw new Error("User not found");
  }

  // Check withdrawable balance
  if (user.withdrawable < amount) {
    throw new Error("Insufficient withdrawable balance");
  }

  // Calculate fee (1% network fee)
  const fee = amount * 0.01;
  const netAmount = amount - fee;

  // Create transaction
  const transaction = new Transaction({
    userId,
    type: "withdrawal",
    amount,
    fee,
    netAmount,
    currency: token,
    status: "pending",
    externalId: generateTransactionId(),
    balanceBefore: user.balance,
    withdrawalDetails: {
      walletAddress,
      network: "polygon",
      tokenContract: TOKENS[token].address,
    },
    signature: signTransactionLog({ userId, amount, walletAddress }),
  });

  // Deduct from user balance immediately
  user.balance -= amount;
  user.withdrawable -= amount;
  user.lockedBalance += netAmount;
  user.lastWithdrawalAt = new Date();

  await Promise.all([transaction.save(), user.save()]);

  // Update cooldown
  userLastWithdrawal.set(userId, Date.now());

  // Add to queue
  withdrawalQueue.push({
    transactionId: transaction._id,
    userId,
    amount: netAmount,
    token,
    walletAddress,
  });

  // Start processing if not already running
  if (!isProcessing) {
    processWithdrawalQueue();
  }

  logger.info(
    `Withdrawal requested: ${userId} -> $${amount} ${token} to ${walletAddress}`,
  );

  return {
    transactionId: transaction._id,
    amount,
    fee,
    netAmount,
    token,
    walletAddress,
    status: "pending",
    estimatedTime: "5-30 minutes",
  };
}

/**
 * Process withdrawal queue
 */
async function processWithdrawalQueue() {
  if (isProcessing || withdrawalQueue.length === 0) {
    return;
  }

  if (!wallet) {
    logger.error("Cannot process withdrawals - wallet not initialized");
    return;
  }

  isProcessing = true;

  while (withdrawalQueue.length > 0) {
    const withdrawal = withdrawalQueue.shift();

    try {
      await processWithdrawal(withdrawal);
    } catch (error) {
      logger.error(`Withdrawal failed: ${withdrawal.transactionId}`, error);

      // Mark transaction as failed
      await Transaction.findByIdAndUpdate(withdrawal.transactionId, {
        status: "failed",
        failureReason: error.message,
        $inc: { retryCount: 1 },
      });

      // Refund user (unlock balance)
      await User.findByIdAndUpdate(withdrawal.userId, {
        $inc: {
          balance: withdrawal.amount,
          withdrawable: withdrawal.amount,
          lockedBalance: -withdrawal.amount,
        },
      });
    }

    // Wait between withdrawals
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }

  isProcessing = false;
}

/**
 * Process a single withdrawal
 *
 * @param {Object} withdrawal - Withdrawal details from queue
 */
async function processWithdrawal(withdrawal) {
  const { transactionId, userId, amount, token, walletAddress } = withdrawal;

  logger.info(`Processing withdrawal: ${transactionId}`);

  // Update status to processing
  await Transaction.findByIdAndUpdate(transactionId, {
    status: "processing",
  });

  // Get token contract
  const tokenConfig = TOKENS[token];
  const contract = new ethers.Contract(tokenConfig.address, ERC20_ABI, wallet);

  // Convert amount to token units
  const amountInUnits = ethers.parseUnits(
    amount.toString(),
    tokenConfig.decimals,
  );

  // Check contract balance
  const balance = await contract.balanceOf(wallet.address);
  if (balance < amountInUnits) {
    throw new Error("Insufficient contract balance");
  }

  // Get gas estimate
  const gasEstimate = await contract.transfer.estimateGas(
    walletAddress,
    amountInUnits,
  );
  const feeData = await provider.getFeeData();

  // Send transaction
  const tx = await contract.transfer(walletAddress, amountInUnits, {
    gasLimit: (gasEstimate * 120n) / 100n, // 20% buffer
    maxFeePerGas: feeData.maxFeePerGas,
    maxPriorityFeePerGas: feeData.maxPriorityFeePerGas,
  });

  logger.info(`Withdrawal tx sent: ${tx.hash}`);

  // Wait for confirmation
  const receipt = await tx.wait(2); // Wait for 2 confirmations

  // Update transaction
  const transaction = await Transaction.findByIdAndUpdate(
    transactionId,
    {
      status: "completed",
      processedAt: new Date(),
      "withdrawalDetails.txHash": tx.hash,
      "withdrawalDetails.blockNumber": receipt.blockNumber,
      "withdrawalDetails.gasUsed": receipt.gasUsed.toString(),
      "withdrawalDetails.confirmations": 2,
    },
    { new: true },
  );

  // Update user - unlock balance and record stats
  const user = await User.findByIdAndUpdate(
    userId,
    {
      $inc: {
        lockedBalance: -amount,
        totalWithdrawn: amount,
      },
    },
    { new: true },
  );

  // Emit events
  emitWithdrawalProcessed(userId, {
    transactionId,
    amount,
    token,
    txHash: tx.hash,
    status: "completed",
  });

  emitBalanceUpdate(userId, {
    balance: user.balance,
    withdrawable: user.withdrawable,
    locked: user.lockedBalance,
  });

  logger.info(`Withdrawal completed: ${transactionId} - tx: ${tx.hash}`);
}

/**
 * Get withdrawal status
 *
 * @param {string} transactionId - Transaction ID
 * @returns {Promise<Object>} - Status details
 */
async function getWithdrawalStatus(transactionId) {
  const transaction = await Transaction.findById(transactionId);

  if (!transaction) {
    throw new Error("Withdrawal not found");
  }

  const result = {
    transactionId,
    status: transaction.status,
    amount: transaction.amount,
    fee: transaction.fee,
    netAmount: transaction.netAmount,
    walletAddress: transaction.withdrawalDetails?.walletAddress,
    createdAt: transaction.createdAt,
  };

  if (transaction.status === "completed") {
    result.txHash = transaction.withdrawalDetails?.txHash;
    result.blockNumber = transaction.withdrawalDetails?.blockNumber;
    result.processedAt = transaction.processedAt;
  }

  if (transaction.status === "failed") {
    result.failureReason = transaction.failureReason;
  }

  return result;
}

/**
 * Get user's withdrawal history
 *
 * @param {string} userId - User ID
 * @param {Object} options - Query options
 * @returns {Promise<Array>} - Withdrawal transactions
 */
async function getWithdrawalHistory(userId, options = {}) {
  return Transaction.find({
    userId,
    type: "withdrawal",
    ...(options.status && { status: options.status }),
  })
    .sort({ createdAt: -1 })
    .limit(options.limit || 50)
    .lean();
}

/**
 * Get pending withdrawals count
 *
 * @returns {Promise<number>} - Count
 */
async function getPendingWithdrawalsCount() {
  return Transaction.countDocuments({
    type: "withdrawal",
    status: { $in: ["pending", "processing"] },
  });
}

/**
 * Retry failed withdrawal
 *
 * @param {string} transactionId - Transaction ID
 * @returns {Promise<Object>} - Updated transaction
 */
async function retryWithdrawal(transactionId) {
  const transaction = await Transaction.findById(transactionId);

  if (!transaction) {
    throw new Error("Transaction not found");
  }

  if (transaction.status !== "failed") {
    throw new Error("Only failed withdrawals can be retried");
  }

  if (transaction.retryCount >= 3) {
    throw new Error("Maximum retry attempts exceeded");
  }

  // Reset status
  transaction.status = "pending";
  transaction.failureReason = null;
  await transaction.save();

  // Add back to queue
  withdrawalQueue.push({
    transactionId: transaction._id,
    userId: transaction.userId,
    amount: transaction.netAmount,
    token: transaction.currency,
    walletAddress: transaction.withdrawalDetails.walletAddress,
  });

  // Start processing
  if (!isProcessing) {
    processWithdrawalQueue();
  }

  return { message: "Withdrawal retry queued", transactionId };
}

module.exports = {
  getWalletInfo,
  checkWithdrawalCooldown,
  requestWithdrawal,
  getWithdrawalStatus,
  getWithdrawalHistory,
  getPendingWithdrawalsCount,
  retryWithdrawal,
  processWithdrawalQueue,
};
