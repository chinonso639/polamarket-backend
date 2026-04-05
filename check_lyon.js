const axios = require("axios");

async function main() {
  // 1. Subgraph check
  const SUBGRAPH_URL =
    "https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/positions-subgraph/0.0.7/gn";
  const conditionId =
    "0xabb2aa7a058811f3b64c8534ccd45bee3830e166c6c6c82707a407fbf6f18ba7";

  const sub = await axios.post(
    SUBGRAPH_URL,
    { query: `query { condition(id: "${conditionId}") { id payouts } }` },
    { headers: { "Content-Type": "application/json" }, timeout: 15000 },
  );
  console.log("Subgraph payouts:", sub.data?.data?.condition?.payouts);

  // 2. Gamma API check
  const gamma = await axios.get("https://gamma-api.polymarket.com/markets", {
    params: { limit: 5, slug: "fl1-ang-lyo-2026-04-05-lyo" },
    timeout: 15000,
  });
  const items = Array.isArray(gamma.data)
    ? gamma.data
    : gamma.data?.markets || gamma.data?.data || [];
  const m = items[0];
  if (m && m.markets) {
    // event wrapper
    const ly = m.markets.find((x) => x.slug && x.slug.includes("lyo"));
    if (ly) {
      console.log("Gamma market slug:", ly.slug);
      console.log("  active:", ly.active, "closed:", ly.closed);
      console.log("  outcomePrices:", ly.outcomePrices);
      console.log("  outcomes:", ly.outcomes);
    }
  } else if (m) {
    console.log("Gamma market slug:", m.slug);
    console.log("  active:", m.active, "closed:", m.closed);
    console.log("  outcomePrices:", m.outcomePrices);
    console.log("  outcomes:", m.outcomes);
  } else {
    console.log("Not found in Gamma REST");
  }
}

main().catch(console.error);
