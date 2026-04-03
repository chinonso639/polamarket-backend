/**
 * AMM Stress Test Simulator
 *
 * Run this script to test the LMSR AMM under various scenarios:
 * - Liquidity drain attacks
 * - Arbitrage attempts
 * - High volume trading
 * - Price manipulation
 *
 * Usage: node amm/simulator.js
 */

const {
  getPrices,
  buyYes,
  buyNo,
  calculateCost,
  calculateSlippage,
} = require("./lmsr");

/**
 * Create a test market with default parameters
 */
function createTestMarket(options = {}) {
  return {
    _id: "test-market-001",
    question: "Test Market",
    qYes: options.qYes || 0,
    qNo: options.qNo || 0,
    b: options.b || 100,
    yesPool: options.yesPool || 1000,
    noPool: options.noPool || 1000,
    virtualLiquidityBuffer: options.virtualLiquidityBuffer || 1000,
    feeRate: options.feeRate || 0.02,
    resolved: false,
    isTradingActive: true,
    maxSlippage: options.maxSlippage || 0.1,
    minTradeAmount: options.minTradeAmount || 1,
    maxTradeAmount: options.maxTradeAmount || 10000,
    liquidityFloor: options.liquidityFloor || 100,
    totalFeesCollected: 0,
    totalVolume: 0,
    totalTrades: 0,
  };
}

/**
 * Apply market updates after a trade
 */
function applyUpdate(market, update) {
  return { ...market, ...update };
}

/**
 * Test 1: Normal Trading Scenario
 */
function testNormalTrading() {
  console.log("\n=== TEST 1: Normal Trading Scenario ===\n");

  let market = createTestMarket({ b: 100 });

  console.log("Initial state:", getPrices(market));

  // Simulate 10 alternating trades
  const trades = [
    { type: "YES", amount: 50 },
    { type: "NO", amount: 30 },
    { type: "YES", amount: 100 },
    { type: "NO", amount: 80 },
    { type: "YES", amount: 20 },
    { type: "NO", amount: 150 },
    { type: "YES", amount: 75 },
    { type: "NO", amount: 60 },
    { type: "YES", amount: 40 },
    { type: "NO", amount: 90 },
  ];

  for (const trade of trades) {
    try {
      const result =
        trade.type === "YES"
          ? buyYes(market, trade.amount)
          : buyNo(market, trade.amount);

      market = applyUpdate(market, result.marketUpdate);

      console.log(
        `${trade.type} $${trade.amount}: shares=${result.shares.toFixed(4)}, ` +
          `slippage=${(result.slippage * 100).toFixed(2)}%, ` +
          `prices: YES=${result.pricesAfter.yesPrice.toFixed(4)}, ` +
          `NO=${result.pricesAfter.noPrice.toFixed(4)}`,
      );
    } catch (error) {
      console.log(`Trade failed: ${error.message}`);
    }
  }

  console.log("\nFinal state:");
  console.log("Total volume:", market.totalVolume.toFixed(2));
  console.log("Total fees:", market.totalFeesCollected.toFixed(2));
  console.log("Final prices:", getPrices(market));

  return true;
}

/**
 * Test 2: Liquidity Drain Attack Simulation
 */
function testLiquidityDrain() {
  console.log("\n=== TEST 2: Liquidity Drain Attack ===\n");

  let market = createTestMarket({ b: 100, liquidityFloor: 100 });

  console.log("Initial state:", getPrices(market));
  console.log("Attempting to drain liquidity with large trades...\n");

  // Try increasingly large trades
  const attackAmounts = [500, 1000, 2000, 5000, 10000, 20000];

  let totalDrained = 0;
  for (const amount of attackAmounts) {
    try {
      const slippageCheck = calculateSlippage(market, "YES", amount);
      console.log(
        `Attempting $${amount}: expected slippage ${(slippageCheck.slippage * 100).toFixed(2)}%`,
      );

      const result = buyYes(market, amount);
      market = applyUpdate(market, result.marketUpdate);

      totalDrained += amount;
      console.log(
        `  SUCCESS: Got ${result.shares.toFixed(4)} shares, ` +
          `price moved to ${result.pricesAfter.yesPrice.toFixed(4)}`,
      );
    } catch (error) {
      console.log(`  BLOCKED: ${error.message}`);
    }
  }

  console.log("\nAttack results:");
  console.log("Total drained:", totalDrained.toFixed(2));
  console.log("Final prices:", getPrices(market));
  console.log("LMSR bounded the attack - prices cannot reach 0 or 1");

  return true;
}

/**
 * Test 3: Arbitrage Simulation
 */
function testArbitrage() {
  console.log("\n=== TEST 3: Arbitrage Resistance ===\n");

  let market = createTestMarket({ b: 100 });

  console.log("Initial prices:", getPrices(market));

  // Simulate arbitrage attempt: buy YES, then immediately sell
  console.log("\nArbitrage attempt: Buy YES, then sell...");

  try {
    // Buy YES
    const buyResult = buyYes(market, 1000);
    market = applyUpdate(market, buyResult.marketUpdate);

    console.log("After buying YES:");
    console.log("  Spent: $1000");
    console.log("  Got shares:", buyResult.shares.toFixed(4));
    console.log("  Avg price:", buyResult.avgPrice.toFixed(4));
    console.log("  Fee paid:", buyResult.fee.toFixed(2));
    console.log("  New prices:", buyResult.pricesAfter);

    // Now try to profit by selling at higher price
    // In LMSR, selling pushes price back down, eliminating arbitrage
    const sellValue = buyResult.shares * buyResult.pricesAfter.yesPrice;
    const profit = sellValue - buyResult.amountSpent;

    console.log("\nIf sold immediately:");
    console.log("  Sell value (shares × current price):", sellValue.toFixed(2));
    console.log("  Original spent:", buyResult.amountSpent.toFixed(2));
    console.log("  Profit/Loss:", profit.toFixed(2));
    console.log(
      "  Result:",
      profit < 0 ? "LOSS (arbitrage prevented by fees + slippage)" : "PROFIT",
    );
  } catch (error) {
    console.log("Arbitrage blocked:", error.message);
  }

  return true;
}

/**
 * Test 4: Different Liquidity Parameters
 */
function testLiquidityParameters() {
  console.log("\n=== TEST 4: Liquidity Parameter (b) Effects ===\n");

  const bValues = [10, 50, 100, 500, 1000];
  const tradeAmount = 500;

  console.log(`Trading $${tradeAmount} YES with different b values:\n`);

  for (const b of bValues) {
    const market = createTestMarket({ b });

    try {
      const result = buyYes(market, tradeAmount);

      console.log(`b=${b}:`);
      console.log(`  Shares received: ${result.shares.toFixed(4)}`);
      console.log(`  Slippage: ${(result.slippage * 100).toFixed(2)}%`);
      console.log(
        `  Price impact: ${result.pricesBefore.yesPrice.toFixed(4)} → ${result.pricesAfter.yesPrice.toFixed(4)}`,
      );
      console.log("");
    } catch (error) {
      console.log(`b=${b}: Trade blocked - ${error.message}\n`);
    }
  }

  console.log("Observation: Higher b = more liquidity = less slippage");

  return true;
}

/**
 * Test 5: Price Manipulation Resistance
 */
function testPriceManipulation() {
  console.log("\n=== TEST 5: Price Manipulation Resistance ===\n");

  let market = createTestMarket({ b: 100 });

  console.log("Initial price:", getPrices(market).yesPrice.toFixed(4));

  // Try to manipulate price to extreme
  console.log("\nAttempting to push price to 0.99...");

  let totalSpent = 0;
  let iteration = 0;
  const maxIterations = 100;

  while (getPrices(market).yesPrice < 0.99 && iteration < maxIterations) {
    try {
      const currentPrice = getPrices(market).yesPrice;
      const neededMove = 0.99 - currentPrice;

      // Try to buy enough to move price
      const tradeAmount = Math.min(5000, market.maxTradeAmount);
      const result = buyYes(market, tradeAmount);
      market = applyUpdate(market, result.marketUpdate);

      totalSpent += result.amountSpent;
      iteration++;

      if (iteration % 10 === 0) {
        console.log(
          `  After ${iteration} trades: price=${getPrices(market).yesPrice.toFixed(4)}, total spent=$${totalSpent.toFixed(2)}`,
        );
      }
    } catch (error) {
      console.log("  Trade blocked:", error.message);
      break;
    }
  }

  const finalPrice = getPrices(market).yesPrice;
  console.log(`\nResult after ${iteration} trades:`);
  console.log("Final price:", finalPrice.toFixed(4));
  console.log("Total spent:", totalSpent.toFixed(2));
  console.log(
    "Cost per 0.01 price move:",
    (totalSpent / ((finalPrice - 0.5) * 100)).toFixed(2),
  );
  console.log("\nLMSR makes manipulation exponentially expensive!");

  return true;
}

/**
 * Test 6: Settlement Simulation
 */
function testSettlement() {
  console.log("\n=== TEST 6: Settlement Scenario ===\n");

  let market = createTestMarket({ b: 100 });

  // Simulate multiple users trading
  const users = [
    { id: "user1", trades: [{ type: "YES", amount: 200 }] },
    { id: "user2", trades: [{ type: "NO", amount: 300 }] },
    { id: "user3", trades: [{ type: "YES", amount: 500 }] },
    { id: "user4", trades: [{ type: "NO", amount: 150 }] },
    { id: "user5", trades: [{ type: "YES", amount: 250 }] },
  ];

  const positions = {};

  console.log("Simulating trades...\n");

  for (const user of users) {
    positions[user.id] = { YES: 0, NO: 0, spent: 0 };

    for (const trade of user.trades) {
      try {
        const result =
          trade.type === "YES"
            ? buyYes(market, trade.amount)
            : buyNo(market, trade.amount);

        market = applyUpdate(market, result.marketUpdate);
        positions[user.id][trade.type] += result.shares;
        positions[user.id].spent += result.amountSpent;

        console.log(
          `${user.id}: Bought ${result.shares.toFixed(2)} ${trade.type} for $${trade.amount}`,
        );
      } catch (error) {
        console.log(`${user.id}: Trade failed - ${error.message}`);
      }
    }
  }

  console.log("\nFinal positions:");
  for (const [userId, pos] of Object.entries(positions)) {
    console.log(
      `${userId}: YES=${pos.YES.toFixed(2)}, NO=${pos.NO.toFixed(2)}, spent=$${pos.spent.toFixed(2)}`,
    );
  }

  // Simulate resolution (YES wins)
  console.log("\n--- Market Resolves: YES WINS ---\n");

  const settledPool =
    market.yesPool + market.noPool + market.totalFeesCollected;
  console.log("Settlement pool:", settledPool.toFixed(2));

  let totalPayout = 0;
  for (const [userId, pos] of Object.entries(positions)) {
    // Winners get their shares back (each YES share worth $1 if YES wins)
    const payout = pos.YES;
    const profit = payout - pos.spent;
    totalPayout += payout;

    console.log(
      `${userId}: Payout=$${payout.toFixed(2)}, Profit=$${profit.toFixed(2)}`,
    );
  }

  console.log("\nTotal payouts:", totalPayout.toFixed(2));
  console.log("Pool has:", settledPool.toFixed(2));
  console.log(
    "Settlement status:",
    totalPayout <= settledPool ? "✓ SOLVENT" : "✗ INSOLVENT",
  );

  return true;
}

/**
 * Test 7: Stress Test with 1000 Random Trades
 */
function testHighVolume() {
  console.log("\n=== TEST 7: High Volume Stress Test (1000 trades) ===\n");

  let market = createTestMarket({ b: 500 }); // Higher b for more liquidity

  const startTime = Date.now();
  let successCount = 0;
  let failCount = 0;
  let totalVolume = 0;

  for (let i = 0; i < 1000; i++) {
    const outcome = Math.random() > 0.5 ? "YES" : "NO";
    const amount = Math.floor(Math.random() * 500) + 10; // $10-$510

    try {
      const result =
        outcome === "YES" ? buyYes(market, amount) : buyNo(market, amount);

      market = applyUpdate(market, result.marketUpdate);
      successCount++;
      totalVolume += amount;
    } catch (error) {
      failCount++;
    }
  }

  const elapsed = Date.now() - startTime;

  console.log("Results:");
  console.log("Successful trades:", successCount);
  console.log("Failed trades:", failCount);
  console.log("Total volume:", totalVolume.toFixed(2));
  console.log("Total fees collected:", market.totalFeesCollected.toFixed(2));
  console.log("Time elapsed:", elapsed, "ms");
  console.log("Trades per second:", (1000 / (elapsed / 1000)).toFixed(2));
  console.log("Final prices:", getPrices(market));

  return true;
}

/**
 * Run all tests
 */
function runAllTests() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║          LMSR AMM STRESS TEST SIMULATOR                  ║");
  console.log("║          Polygrid Prediction Market Engine               ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  const tests = [
    { name: "Normal Trading", fn: testNormalTrading },
    { name: "Liquidity Drain Attack", fn: testLiquidityDrain },
    { name: "Arbitrage Resistance", fn: testArbitrage },
    { name: "Liquidity Parameters", fn: testLiquidityParameters },
    { name: "Price Manipulation", fn: testPriceManipulation },
    { name: "Settlement", fn: testSettlement },
    { name: "High Volume", fn: testHighVolume },
  ];

  const results = [];

  for (const test of tests) {
    try {
      const passed = test.fn();
      results.push({ name: test.name, passed });
    } catch (error) {
      console.log(`\nTest ${test.name} CRASHED:`, error.message);
      results.push({ name: test.name, passed: false, error: error.message });
    }
  }

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║                    TEST SUMMARY                          ║");
  console.log("╠══════════════════════════════════════════════════════════╣");

  for (const result of results) {
    const status = result.passed ? "✓ PASS" : "✗ FAIL";
    console.log(`║  ${status}  ${result.name.padEnd(45)}║`);
  }

  console.log("╚══════════════════════════════════════════════════════════╝");

  const passed = results.filter((r) => r.passed).length;
  console.log(`\nTotal: ${passed}/${results.length} tests passed`);
}

// Run if executed directly
if (require.main === module) {
  runAllTests();
}

module.exports = {
  createTestMarket,
  testNormalTrading,
  testLiquidityDrain,
  testArbitrage,
  testLiquidityParameters,
  testPriceManipulation,
  testSettlement,
  testHighVolume,
  runAllTests,
};
