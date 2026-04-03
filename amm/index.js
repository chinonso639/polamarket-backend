/**
 * AMM Module Index
 *
 * This module contains the core LMSR-based AMM engine for the prediction market.
 *
 * Components:
 * - lmsr.js: Core LMSR pricing and trading functions
 * - riskManager.js: Risk controls and exploit prevention
 * - simulator.js: Stress testing and validation
 */

const lmsr = require("./lmsr");
const riskManager = require("./riskManager");

module.exports = {
  // LMSR Core Functions
  ...lmsr,

  // Risk Management
  riskManager,

  // Convenience re-exports
  getPrices: lmsr.getPrices,
  buyYes: lmsr.buyYes,
  buyNo: lmsr.buyNo,
  sellShares: lmsr.sellShares,
  calculateSlippage: lmsr.calculateSlippage,
  assessTradeRisk: riskManager.assessTradeRisk,
};
