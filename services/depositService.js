/**
 * NowPayments Deposit Service
 * Handles crypto deposits via NowPayments API
 */

const axios = require("axios");
const User = require("../models/User");
const Transaction = require("../models/Transaction");
const logger = require("../utils/logger");
const {
  verifyNowPaymentsSignature,
  generateTransactionId,
} = require("../utils/crypto");
const { emitDepositReceived, emitBalanceUpdate } = require("./socketService");

// NowPayments API configuration
const NOWPAYMENTS_API =
  process.env.NOWPAYMENTS_API_URL || "https://api.nowpayments.io/v1";
const API_KEY = process.env.NOWPAYMENTS_API_KEY;
const WEBHOOK_IPN_SECRET =
  process.env.NOWPAYMENTS_WEBHOOK_IPN_SECRET ||
  process.env.NOWPAYMENTS_IPN_SECRET;
const APP_URL = process.env.APP_URL || "http://localhost:3000";

// User-facing symbols to candidate NowPayments pay_currency codes.
// We select by preference order and let /payment return the definitive API error.
const PAY_CURRENCY_CANDIDATES = {
  usdt: ["usdterc20", "usdttrc20", "usdt"],
  usdc: ["usdc", "usdcarb", "usdcarc20", "usdcbase", "usdcmatic"],
  btc: ["btc"],
  eth: ["eth", "etharb", "ethbase"],
  matic: ["matic", "maticmainnet"],
};

// Processed webhook IDs (for replay attack protection)
const processedWebhooks = new Set();

// Supported currencies with their conversion rates to USD
const SUPPORTED_CURRENCIES = {
  btc: { name: "Bitcoin", minAmount: 0.0001 },
  eth: { name: "Ethereum", minAmount: 0.001 },
  usdt: { name: "USDT", minAmount: 10 },
  usdc: { name: "USDC", minAmount: 10 },
  ltc: { name: "Litecoin", minAmount: 0.01 },
  matic: { name: "Polygon", minAmount: 1 },
};

/**
 * Create axios instance with auth headers
 */
const api = axios.create({
  baseURL: NOWPAYMENTS_API,
  headers: {
    "x-api-key": API_KEY,
    "Content-Type": "application/json",
  },
  timeout: 30000,
});

/**
 * Get available currencies and their minimum amounts
 *
 * @returns {Promise<Object>} - Available currencies
 */
async function getAvailableCurrencies() {
  try {
    const response = await api.get("/currencies");

    // Filter to supported currencies
    const available = response.data.currencies
      .filter((c) => SUPPORTED_CURRENCIES[c.toLowerCase()])
      .map((c) => ({
        symbol: c.toLowerCase(),
        ...SUPPORTED_CURRENCIES[c.toLowerCase()],
      }));

    return available;
  } catch (error) {
    logger.error("Failed to get currencies:", error.message);
    throw error;
  }
}

/**
 * Get minimum payment amount for a currency
 *
 * @param {string} currency - Currency symbol
 * @returns {Promise<Object>} - Minimum amount info
 */
async function getMinimumAmount(currency) {
  try {
    const response = await api.get(
      `/min-amount?currency_from=${currency}&currency_to=usd`,
    );
    return response.data;
  } catch (error) {
    logger.error("Failed to get minimum amount:", error.message);
    throw error;
  }
}

/**
 * Estimate price for deposit
 *
 * @param {number} amountUsd - Amount in USD
 * @param {string} currency - Crypto currency
 * @returns {Promise<Object>} - Estimated price
 */
async function estimatePrice(amountUsd, currency) {
  try {
    const response = await api.get("/estimate", {
      params: {
        amount: amountUsd,
        currency_from: currency,
        currency_to: "usd",
      },
    });
    return response.data;
  } catch (error) {
    logger.error("Failed to estimate price:", error.message);
    throw error;
  }
}

/**
 * Picks a supported pay_currency for the current NowPayments environment.
 *
 * @param {string} requestedCurrency
 * @returns {string}
 */
function resolvePayCurrency(requestedCurrency) {
  const normalized = String(requestedCurrency || "USDT").toLowerCase();
  const candidates = PAY_CURRENCY_CANDIDATES[normalized] || [normalized];
  return candidates[0];
}

function getPayCurrencyCandidates(requestedCurrency) {
  const normalized = String(requestedCurrency || "USDT").toLowerCase();
  return PAY_CURRENCY_CANDIDATES[normalized] || [normalized];
}

/**
 * Create a new deposit payment
 *
 * @param {Object} params
 * @param {string} params.userId - User ID
 * @param {number} params.amount - Amount in USD
 * @param {string} params.currency - Crypto currency to pay with
 * @param {string} params.description - Order description
 * @returns {Promise<Object>} - Payment details
 */
async function createDeposit({ userId, amount, currency, description }) {
  try {
    // Validate minimum amount
    if (amount < 10) {
      throw new Error("Minimum deposit is $10");
    }

    // Generate unique order ID
    const orderId = generateTransactionId();

    // Create payment (try a few pay_currency variants for sandbox/live compatibility)
    const payCurrencyCandidates = getPayCurrencyCandidates(currency);
    let response;
    let payCurrencyUsed = null;
    let lastApiError = null;

    for (const payCurrency of payCurrencyCandidates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        response = await api.post("/payment", {
          price_amount: amount,
          price_currency: "usd",
          pay_currency: payCurrency,
          order_id: orderId,
          order_description: description || `Deposit for user ${userId}`,
          ipn_callback_url: `${APP_URL}/api/deposits/webhook`,
          success_url: `${APP_URL}/deposit/success`,
          cancel_url: `${APP_URL}/deposit/cancel`,
        });
        payCurrencyUsed = payCurrency;
        break;
      } catch (err) {
        const apiError = err.response?.data;
        lastApiError = apiError || err.message;

        // Try next candidate only for unsupported currency style errors.
        const msg = String(apiError?.message || "").toLowerCase();
        const isUnsupportedCurrency =
          apiError?.code === "BAD_REQUEST" &&
          msg.includes("currency") &&
          msg.includes("not found");

        if (isUnsupportedCurrency) {
          continue;
        }

        throw err;
      }
    }

    if (!response) {
      throw new Error(
        `No supported pay currency found for ${String(currency || "USDT").toLowerCase()} in current NowPayments environment: ${JSON.stringify(lastApiError)}`,
      );
    }

    // Create pending transaction
    const transaction = new Transaction({
      userId,
      type: "deposit",
      amount,
      fee: 0,
      netAmount: amount,
      status: "pending",
      externalId: orderId,
      depositDetails: {
        paymentId: response.data.payment_id,
        paymentStatus: response.data.payment_status,
        payAddress: response.data.pay_address,
        payCurrency: response.data.pay_currency,
        payAmount: response.data.pay_amount,
        priceCurrency: "usd",
        priceAmount: amount,
        invoiceId: response.data.invoice_id,
      },
    });

    await transaction.save();

    logger.info(
      `Deposit created: ${orderId} for user ${userId}, $${amount} in ${currency} via ${payCurrencyUsed}`,
    );

    return {
      paymentId: response.data.payment_id,
      payAddress: response.data.pay_address,
      payAmount: response.data.pay_amount,
      payCurrency: response.data.pay_currency,
      expiredAt: response.data.expiration_estimate_date,
      orderId,
      transactionId: transaction._id,
    };
  } catch (error) {
    const apiError = error.response?.data;
    logger.error("Failed to create deposit:", apiError || error.message);

    if (error.response?.status === 404) {
      throw new Error(
        "NowPayments endpoint not found (404). Check NOWPAYMENTS_API_URL for this environment, e.g. https://api-sandbox.nowpayments.io/v1",
      );
    }

    if (apiError?.code === "INVALID_API_KEY") {
      throw new Error(
        "NowPayments rejected the API key for payment endpoints. Use the Secret API key (not public/IPN key) for this environment.",
      );
    }

    if (apiError?.message) {
      throw new Error(apiError.message);
    }

    throw error;
  }
}

/**
 * Get payment status
 *
 * @param {string} paymentId - NowPayments payment ID
 * @returns {Promise<Object>} - Payment status
 */
async function getPaymentStatus(paymentId) {
  try {
    const response = await api.get(`/payment/${paymentId}`);
    return response.data;
  } catch (error) {
    logger.error("Failed to get payment status:", error.message);
    throw error;
  }
}

/**
 * Process IPN webhook from NowPayments
 *
 * @param {Object} payload - Webhook payload (parsed JSON)
 * @param {string} rawBody - Raw request body (for signature verification)
 * @param {string} signature - Webhook signature
 * @returns {Promise<Object>} - Processing result
 */
async function processWebhook(payload, rawBody, signature) {
  const paymentId = payload.payment_id;

  // Replay attack protection
  const webhookKey = `${paymentId}:${payload.payment_status}`;
  if (processedWebhooks.has(webhookKey)) {
    logger.warn(`Duplicate webhook ignored: ${webhookKey}`);
    return { success: true, message: "Duplicate webhook" };
  }

  // Verify signature
  if (WEBHOOK_IPN_SECRET && signature) {
    if (!verifyNowPaymentsSignature(rawBody, signature)) {
      logger.error("Invalid webhook signature");
      throw new Error("Invalid signature");
    }
  }

  // Find transaction
  const transaction = await Transaction.findByPaymentId(paymentId);

  if (!transaction) {
    logger.warn(`Transaction not found for payment: ${paymentId}`);
    throw new Error("Transaction not found");
  }

  // Update transaction based on status
  const status = payload.payment_status;

  switch (status) {
    case "waiting":
    case "confirming":
      transaction.status = "processing";
      transaction.depositDetails.paymentStatus = status;
      await transaction.save();
      break;

    case "confirmed":
    case "sending":
      transaction.status = "processing";
      transaction.depositDetails.paymentStatus = status;
      transaction.depositDetails.actualAmountReceived = payload.actually_paid;
      await transaction.save();
      break;

    case "finished":
      // Credit user balance
      await creditDeposit(transaction, payload);
      break;

    case "partially_paid":
      // Handle partial payment
      transaction.status = "processing";
      transaction.depositDetails.paymentStatus = status;
      transaction.depositDetails.actualAmountReceived = payload.actually_paid;
      transaction.notes = "Partial payment received";
      await transaction.save();
      logger.warn(
        `Partial payment: ${paymentId}, received ${payload.actually_paid}`,
      );
      break;

    case "failed":
    case "expired":
    case "refunded":
      transaction.status = "failed";
      transaction.depositDetails.paymentStatus = status;
      transaction.failureReason = status;
      await transaction.save();
      logger.warn(`Payment ${status}: ${paymentId}`);
      break;

    default:
      logger.info(`Unknown payment status: ${status} for ${paymentId}`);
  }

  // Mark webhook as processed
  processedWebhooks.add(webhookKey);

  // Clean up old webhook IDs (keep last 10000)
  if (processedWebhooks.size > 10000) {
    const iterator = processedWebhooks.values();
    for (let i = 0; i < 1000; i++) {
      processedWebhooks.delete(iterator.next().value);
    }
  }

  return { success: true, status };
}

/**
 * Credit deposit to user balance
 *
 * @param {Object} transaction - Transaction document
 * @param {Object} payload - Webhook payload
 */
async function creditDeposit(transaction, payload) {
  const applyCredit = async (session = null) => {
    const user = await User.findById(transaction.userId);

    if (!user) {
      throw new Error("User not found");
    }

    // Calculate credited amount (use outcome_amount which is in USD)
    const creditAmount =
      parseFloat(payload.outcome_amount) || transaction.amount;

    // Update user balance
    transaction.balanceBefore = user.balance;
    user.balance += creditAmount;
    user.withdrawable += creditAmount;
    user.totalDeposited += creditAmount;
    transaction.balanceAfter = user.balance;

    if (session) {
      await user.save({ session });
    } else {
      await user.save();
    }

    // Update transaction
    transaction.status = "completed";
    transaction.depositDetails.paymentStatus = "finished";
    transaction.depositDetails.actualAmountReceived = payload.actually_paid;
    transaction.netAmount = creditAmount;
    transaction.processedAt = new Date();

    if (session) {
      await transaction.save({ session });
    } else {
      await transaction.save();
    }

    // Emit real-time updates
    emitDepositReceived(user._id.toString(), {
      amount: creditAmount,
      currency: payload.pay_currency,
      transactionId: transaction._id,
    });

    emitBalanceUpdate(user._id.toString(), {
      balance: user.balance,
      withdrawable: user.withdrawable,
    });

    logger.info(`Deposit credited: ${user.email} +$${creditAmount}`);
  };

  let session;
  try {
    session = await Transaction.startSession();
    await session.withTransaction(async () => {
      await applyCredit(session);
    });
  } catch (error) {
    const message = error?.message || "";
    const transactionsUnsupported =
      message.includes("replica set member") ||
      message.includes("Transaction numbers are only allowed") ||
      message.includes("Standalone servers do not support transactions");

    if (!transactionsUnsupported) {
      logger.error("Failed to credit deposit:", error);
      throw error;
    }

    logger.warn(
      "MongoDB transactions unavailable; retrying deposit credit without transaction",
    );
    await applyCredit(null);
  } finally {
    if (session) {
      session.endSession();
    }
  }
}

/**
 * Get user's deposit history
 *
 * @param {string} userId - User ID
 * @param {Object} options - Query options
 * @returns {Promise<Array>} - Deposit transactions
 */
async function getDepositHistory(userId, options = {}) {
  return Transaction.find({
    userId,
    type: "deposit",
    ...(options.status && { status: options.status }),
  })
    .sort({ createdAt: -1 })
    .limit(options.limit || 50)
    .lean();
}

module.exports = {
  getAvailableCurrencies,
  getMinimumAmount,
  estimatePrice,
  createDeposit,
  getPaymentStatus,
  processWebhook,
  getDepositHistory,
};
