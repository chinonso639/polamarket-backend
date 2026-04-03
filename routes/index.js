/**
 * Routes Index
 * Exports all route modules
 */

const authRoutes = require("./authRoutes");
const marketRoutes = require("./marketRoutes");
const userRoutes = require("./userRoutes");
const betRoutes = require("./betRoutes");
const depositRoutes = require("./depositRoutes");
const withdrawalRoutes = require("./withdrawalRoutes");
const adminRoutes = require("./adminRoutes");
const polymarketRoutes = require("./polymarketRoutes");

module.exports = {
  authRoutes,
  marketRoutes,
  userRoutes,
  betRoutes,
  depositRoutes,
  withdrawalRoutes,
  adminRoutes,
  polymarketRoutes,
};
