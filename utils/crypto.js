/**
 * Crypto Utilities
 * Cryptographic functions for signing, verification, and security
 */

const CryptoJS = require("crypto-js");
const { v4: uuidv4 } = require("uuid");

/**
 * Generate a unique transaction ID
 */
function generateTransactionId() {
  return `txn_${Date.now()}_${uuidv4().replace(/-/g, "").slice(0, 12)}`;
}

/**
 * Generate a webhook signature for verification
 *
 * @param {Object} payload - Webhook payload
 * @param {string} secret - Secret key
 * @returns {string} - HMAC signature
 */
function generateWebhookSignature(payload, secret) {
  const message = JSON.stringify(payload);
  return CryptoJS.HmacSHA512(message, secret).toString(CryptoJS.enc.Hex);
}

/**
 * Verify a webhook signature
 *
 * @param {Object} payload - Webhook payload
 * @param {string} signature - Received signature
 * @param {string} secret - Secret key
 * @returns {boolean} - Whether signature is valid
 */
function verifyWebhookSignature(payload, signature, secret) {
  const expectedSignature = generateWebhookSignature(payload, secret);
  return signature === expectedSignature;
}

/**
 * Generate a signed transaction log entry
 *
 * @param {Object} transaction - Transaction data
 * @returns {string} - Signed log entry
 */
function signTransactionLog(transaction) {
  const secret = process.env.JWT_SECRET || "default-secret";
  const data = {
    ...transaction,
    timestamp: Date.now(),
  };
  const signature = CryptoJS.HmacSHA256(
    JSON.stringify(data),
    secret,
  ).toString();
  return signature;
}

/**
 * Generate a secure random token
 *
 * @param {number} length - Token length in bytes
 * @returns {string} - Random hex token
 */
function generateSecureToken(length = 32) {
  return CryptoJS.lib.WordArray.random(length).toString(CryptoJS.enc.Hex);
}

/**
 * Hash a password for storage (backup to bcrypt)
 *
 * @param {string} password - Plain text password
 * @param {string} salt - Salt value
 * @returns {string} - Hashed password
 */
function hashPassword(password, salt) {
  return CryptoJS.PBKDF2(password, salt, {
    keySize: 256 / 32,
    iterations: 10000,
  }).toString();
}

/**
 * Encrypt sensitive data for storage
 *
 * @param {string} data - Data to encrypt
 * @param {string} key - Encryption key
 * @returns {string} - Encrypted data
 */
function encrypt(data, key = process.env.JWT_SECRET) {
  return CryptoJS.AES.encrypt(data, key).toString();
}

/**
 * Decrypt sensitive data
 *
 * @param {string} encryptedData - Encrypted data
 * @param {string} key - Encryption key
 * @returns {string} - Decrypted data
 */
function decrypt(encryptedData, key = process.env.JWT_SECRET) {
  const bytes = CryptoJS.AES.decrypt(encryptedData, key);
  return bytes.toString(CryptoJS.enc.Utf8);
}

/**
 * Create an idempotency key for preventing duplicate operations
 *
 * @param {string} userId - User ID
 * @param {string} operation - Operation type
 * @param {Object} params - Operation parameters
 * @returns {string} - Idempotency key
 */
function createIdempotencyKey(userId, operation, params) {
  const data = `${userId}:${operation}:${JSON.stringify(params)}`;
  return CryptoJS.SHA256(data).toString().slice(0, 32);
}

/**
 * Verify NowPayments IPN signature
 *
 * @param {Object} payload - IPN payload
 * @param {string} signature - Received signature
 * @returns {boolean} - Whether signature is valid
 */
function verifyNowPaymentsSignature(rawBody, signature) {
  const secret =
    process.env.NOWPAYMENTS_WEBHOOK_IPN_SECRET ||
    process.env.NOWPAYMENTS_IPN_SECRET;
  if (!secret) return false;

  // NowPayments signs the raw request body
  const expectedSignature = CryptoJS.HmacSHA512(rawBody, secret).toString(
    CryptoJS.enc.Hex,
  );

  return signature === expectedSignature;
}

module.exports = {
  generateTransactionId,
  generateWebhookSignature,
  verifyWebhookSignature,
  signTransactionLog,
  generateSecureToken,
  hashPassword,
  encrypt,
  decrypt,
  createIdempotencyKey,
  verifyNowPaymentsSignature,
};
