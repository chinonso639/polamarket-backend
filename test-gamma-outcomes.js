const axios = require("axios");

(async () => {
  try {
    for (let offset = 0; offset < 500; offset += 100) {
      const response = await axios.get(
        "https://gamma-api.polymarket.com/markets?limit=100&offset=" + offset,
      );
      const markets = response.data;

      const multiOutcomeMarket = markets.find((m) => {
        if (!m.outcomes) return false;
        try {
          const parsed = JSON.parse(m.outcomes);
          return Array.isArray(parsed) && parsed.length > 2;
        } catch {
          return false;
        }
      });

      if (multiOutcomeMarket) {
        console.log("Found multi-outcome market!");
        console.log("Question:", multiOutcomeMarket.question);
        console.log("Outcomes:", multiOutcomeMarket.outcomes);
        console.log("OutcomePrices:", multiOutcomeMarket.outcomePrices);
        console.log(
          "Full market data keys:",
          Object.keys(multiOutcomeMarket).slice(0, 20),
        );
        return;
      }
    }
    console.log("No multi-outcome markets found in first 500");
  } catch (error) {
    console.error("Error:", error.message);
  }
})();
