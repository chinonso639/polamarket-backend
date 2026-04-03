/**
 * Models Index
 * Export all models from a single location
 */

const User = require("./User");
const Market = require("./Market");
const Bet = require("./Bet");
const Transaction = require("./Transaction");

module.exports = {
  User,
  Market,
  Bet,
  Transaction,
};
