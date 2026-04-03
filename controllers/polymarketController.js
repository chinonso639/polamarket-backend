/**
 * Polymarket Proxy Controller
 * Proxies requests to Polymarket Gamma API to avoid CORS issues
 */

const axios = require("axios");
const response = require("../utils/response");
const logger = require("../utils/logger");
const { asyncHandler } = require("../middleware/errorHandler");

const GAMMA_API_URL =
  process.env.GAMMA_API_URL || "https://gamma-api.polymarket.com";
const CLOB_API_URL = process.env.CLOB_API_URL || "https://clob.polymarket.com";

// Create axios instances
const gammaApi = axios.create({
  baseURL: GAMMA_API_URL,
  timeout: 30000,
  headers: {
    Accept: "application/json",
  },
});

const clobApi = axios.create({
  baseURL: CLOB_API_URL,
  timeout: 30000,
  headers: {
    Accept: "application/json",
  },
});

/**
 * Map category from tags/question
 */
const mapCategory = (tags = [], question = "") => {
  const tagStr = (tags || []).join(" ").toLowerCase();
  const questionLower = (question || "").toLowerCase();
  const combined = `${tagStr} ${questionLower}`;

  // Iran - specific geopolitical focus
  if (
    combined.includes("iran") ||
    combined.includes("tehran") ||
    combined.includes("khamenei") ||
    combined.includes("persian")
  ) {
    return "Iran";
  }

  // Geopolitics - international relations, wars, conflicts
  if (
    combined.includes("geopolitic") ||
    combined.includes("war") ||
    combined.includes("military") ||
    combined.includes("nato") ||
    combined.includes("russia") ||
    combined.includes("ukraine") ||
    combined.includes("china") ||
    combined.includes("taiwan") ||
    combined.includes("north korea") ||
    combined.includes("sanction") ||
    combined.includes("invasion") ||
    combined.includes("troops") ||
    combined.includes("conflict") ||
    combined.includes("missile") ||
    combined.includes("nuclear") ||
    combined.includes("diplomat")
  ) {
    return "Geopolitics";
  }

  // Elections - specifically election markets
  if (
    combined.includes("election") ||
    combined.includes("vote") ||
    combined.includes("ballot") ||
    combined.includes("primary") ||
    combined.includes("nominee") ||
    combined.includes("campaign") ||
    combined.includes("electoral")
  ) {
    return "Elections";
  }

  // Politics - general political topics
  if (
    combined.includes("politic") ||
    combined.includes("trump") ||
    combined.includes("biden") ||
    combined.includes("president") ||
    combined.includes("congress") ||
    combined.includes("senate") ||
    combined.includes("democrat") ||
    combined.includes("republican") ||
    combined.includes("governor") ||
    combined.includes("poll") ||
    combined.includes("cabinet") ||
    combined.includes("legislation")
  ) {
    return "Politics";
  }

  // Esports
  if (
    combined.includes("esport") ||
    combined.includes("league of legends") ||
    combined.includes("dota") ||
    combined.includes("csgo") ||
    combined.includes("cs2") ||
    combined.includes("valorant") ||
    combined.includes("overwatch") ||
    combined.includes("fortnite") ||
    combined.includes("gaming tournament") ||
    combined.includes("twitch") ||
    combined.includes("streamer")
  ) {
    return "Esports";
  }

  // Weather
  if (
    combined.includes("weather") ||
    combined.includes("temperature") ||
    combined.includes("hurricane") ||
    combined.includes("tornado") ||
    combined.includes("storm") ||
    combined.includes("climate") ||
    combined.includes("rainfall") ||
    combined.includes("snow") ||
    combined.includes("heat wave") ||
    combined.includes("forecast") ||
    combined.includes("celsius") ||
    combined.includes("fahrenheit")
  ) {
    return "Weather";
  }

  // Crypto
  if (
    combined.includes("crypto") ||
    combined.includes("bitcoin") ||
    combined.includes("ethereum") ||
    combined.includes("btc") ||
    combined.includes("eth") ||
    combined.includes("solana") ||
    combined.includes("sol ") ||
    combined.includes("doge") ||
    combined.includes("blockchain") ||
    combined.includes("defi") ||
    combined.includes("altcoin") ||
    combined.includes("nft")
  ) {
    return "Crypto";
  }

  // Sports
  if (
    combined.includes("sport") ||
    combined.includes("nba") ||
    combined.includes("nfl") ||
    combined.includes("mlb") ||
    combined.includes("nhl") ||
    combined.includes("championship") ||
    combined.includes("world cup") ||
    combined.includes("super bowl") ||
    combined.includes("playoffs") ||
    combined.includes("finals") ||
    combined.includes("mvp") ||
    combined.includes("olympics") ||
    combined.includes("soccer") ||
    combined.includes("football") ||
    combined.includes("basketball") ||
    combined.includes("baseball") ||
    combined.includes("tennis") ||
    combined.includes("golf") ||
    combined.includes("ufc") ||
    combined.includes("boxing") ||
    combined.includes("f1") ||
    combined.includes("formula 1") ||
    combined.includes("premier league") ||
    combined.includes("la liga") ||
    combined.includes("champions league")
  ) {
    return "Sports";
  }

  // Tech
  if (
    combined.includes("tech") ||
    combined.includes("ai") ||
    combined.includes("artificial intelligence") ||
    combined.includes("chatgpt") ||
    combined.includes("openai") ||
    combined.includes("apple") ||
    combined.includes("google") ||
    combined.includes("microsoft") ||
    combined.includes("meta") ||
    combined.includes("facebook") ||
    combined.includes("amazon") ||
    combined.includes("nvidia") ||
    combined.includes("tesla") ||
    combined.includes("spacex") ||
    combined.includes("elon musk") ||
    combined.includes("iphone") ||
    combined.includes("android") ||
    combined.includes("software") ||
    combined.includes("startup")
  ) {
    return "Tech";
  }

  // Economy
  if (
    combined.includes("economy") ||
    combined.includes("gdp") ||
    combined.includes("recession") ||
    combined.includes("inflation") ||
    combined.includes("unemployment") ||
    combined.includes("tariff") ||
    combined.includes("trade war") ||
    combined.includes("import") ||
    combined.includes("export")
  ) {
    return "Economy";
  }

  // Finance
  if (
    combined.includes("financ") ||
    combined.includes("fed") ||
    combined.includes("interest rate") ||
    combined.includes("stock") ||
    combined.includes("s&p") ||
    combined.includes("nasdaq") ||
    combined.includes("dow jones") ||
    combined.includes("market") ||
    combined.includes("bank") ||
    combined.includes("treasury") ||
    combined.includes("bond") ||
    combined.includes("oil") ||
    combined.includes("gold") ||
    combined.includes("commodity")
  ) {
    return "Finance";
  }

  // Culture/Entertainment
  if (
    combined.includes("culture") ||
    combined.includes("movie") ||
    combined.includes("oscar") ||
    combined.includes("grammy") ||
    combined.includes("emmy") ||
    combined.includes("award") ||
    combined.includes("celebrity") ||
    combined.includes("music") ||
    combined.includes("film") ||
    combined.includes("television") ||
    combined.includes("tv show") ||
    combined.includes("netflix") ||
    combined.includes("disney") ||
    combined.includes("hollywood") ||
    combined.includes("album") ||
    combined.includes("concert") ||
    combined.includes("viral")
  ) {
    return "Culture";
  }

  return "World";
};

/**
 * Transform Polymarket market to internal format
 */
const transformMarket = (market) => {
  let yesPrice = 0.5;
  let noPrice = 0.5;

  const tokens = market.tokens || [];
  if (tokens.length >= 2) {
    const yesToken = tokens.find((t) => t.outcome === "Yes");
    const noToken = tokens.find((t) => t.outcome === "No");
    yesPrice = yesToken?.price || 0.5;
    noPrice = noToken?.price || 0.5;
  } else if (market.outcomePrices) {
    try {
      const prices = JSON.parse(market.outcomePrices);
      yesPrice = parseFloat(prices[0]) || 0.5;
      noPrice = parseFloat(prices[1]) || 0.5;
    } catch (e) {
      // Use defaults
    }
  } else if (market.bestBid !== undefined) {
    yesPrice = market.bestBid || 0.5;
  }

  const priceChange24h = market.priceChange
    ? parseFloat(market.priceChange) * 100
    : Math.round((Math.random() - 0.5) * 20);

  return {
    _id: market.id || market.condition_id || market.conditionId,
    question: market.question || market.title,
    description: market.description || "",
    category: mapCategory(market.tags, market.question || market.title),
    endDate: market.endDate || market.end_date_iso || market.resolutionDate,
    yesPrice: parseFloat(yesPrice),
    noPrice: parseFloat(noPrice),
    priceChange24h,
    totalVolume: parseFloat(market.volume || market.volumeNum || 0),
    liquidity: parseFloat(market.liquidity || market.liquidityNum || 0),
    imageUrl: market.image || market.icon || null,
    slug: market.slug || market.market_slug,
    conditionId: market.conditionId || market.condition_id,
    resolved: market.closed || market.resolved || false,
    outcome: market.outcome || null,
    tags: market.tags || [],
  };
};

const SPORTS_KEYWORDS = [
  "nba",
  "ncaab",
  "nfl",
  "nhl",
  "mlb",
  "soccer",
  "football",
  "basketball",
  "ufc",
  "mma",
  "tennis",
  "champions league",
  "premier league",
  "f1",
  "formula 1",
  "mls",
  "ncaa",
  "playoff",
  "match",
  "game",
  "vs",
];

const extractTagText = (tags = []) =>
  (Array.isArray(tags) ? tags : [])
    .map((tag) => {
      if (typeof tag === "string") return tag;
      if (tag && typeof tag === "object") return tag.name || tag.slug || "";
      return "";
    })
    .join(" ");

const detectSportsLeague = (market = {}) => {
  const question = market.question || market.title || "";
  const tagText = extractTagText(market.tags);
  const slug = market.slug || market.market_slug || "";
  const t = `${question} ${tagText} ${slug}`.toLowerCase();

  if (
    slug.startsWith("nba-") ||
    t.includes(" nba ") ||
    t.includes("basketball")
  ) {
    return "NBA";
  }
  if (
    slug.startsWith("ncaab-") ||
    slug.startsWith("ncaa-") ||
    t.includes("ncaab") ||
    t.includes("ncaa") ||
    t.includes("march madness")
  ) {
    return "NCAAB";
  }
  if (slug.startsWith("nhl-") || t.includes("nhl") || t.includes("hockey")) {
    return "NHL";
  }
  if (slug.startsWith("ufc-") || t.includes("ufc") || t.includes("mma")) {
    return "UFC";
  }
  if (
    slug.startsWith("nfl-") ||
    t.includes("nfl") ||
    t.includes("super bowl")
  ) {
    return "Football";
  }
  if (
    t.includes("champions league") ||
    t.includes(" ucl ") ||
    slug.startsWith("ucl-")
  ) {
    return "UCL";
  }
  if (t.includes("nba")) return "NBA";
  if (t.includes("ncaa") || t.includes("ncaab")) return "NCAAB";
  if (t.includes("nhl")) return "NHL";
  if (t.includes("ufc") || t.includes("mma")) return "UFC";
  if (t.includes("nfl")) return "Football";
  if (
    t.includes("soccer") ||
    t.includes("premier league") ||
    t.includes("la liga") ||
    t.includes("serie a") ||
    t.includes("bundesliga") ||
    t.includes("champions league")
  ) {
    return "Soccer";
  }
  if (t.includes("tennis") || t.includes("atp") || t.includes("wta")) {
    return "Tennis";
  }

  // Soccer-heavy slugs often use 3-letter league + team codes (e.g. por-spo-cds)
  if (/^[a-z]{3}-[a-z0-9]{2,5}-[a-z0-9]{2,5}/.test(slug)) {
    return "Soccer";
  }

  return "Soccer";
};

const parseTeamsFromQuestion = (question = "") => {
  const trimmed = question.replace(/\?/g, "").trim();

  const vsMatch = trimmed.match(
    /([\p{L}\p{N} .'-]{2,})\s+vs\.?\s+([\p{L}\p{N} .'-]{2,})/iu,
  );
  if (vsMatch) {
    return {
      teamA: vsMatch[1].trim(),
      teamB: vsMatch[2].trim(),
    };
  }

  const beatMatch = trimmed.match(
    /will\s+([\p{L}\p{N} .'-]{2,})\s+(beat|defeat|win against)\s+([\p{L}\p{N} .'-]{2,})/iu,
  );
  if (beatMatch) {
    return {
      teamA: beatMatch[1].trim(),
      teamB: beatMatch[3].trim(),
    };
  }

  return { teamA: null, teamB: null };
};

const parseMatchFromMarket = (market) => {
  const question = market.question || market.title || "";
  const combined = `${question} ${extractTagText(market.tags)} ${market.slug || ""}`;
  const lower = combined.toLowerCase();

  // Skip esports-style matches for this traditional sports board
  if (
    lower.includes("counter-strike") ||
    lower.includes("cs2") ||
    lower.includes("valorant") ||
    lower.includes("league of legends") ||
    lower.includes("dota")
  ) {
    return null;
  }

  // Only keep sports-like markets
  if (!SPORTS_KEYWORDS.some((k) => lower.includes(k))) {
    return null;
  }

  const tokens = Array.isArray(market.tokens) ? market.tokens : [];
  const pricedTokens = tokens
    .filter((t) => t && t.outcome && t.price !== undefined)
    .map((t) => ({
      outcome: String(t.outcome),
      price: Number(t.price) || 0,
    }));

  const nonBinaryTokens = pricedTokens.filter(
    (t) => !["yes", "no"].includes(t.outcome.toLowerCase()),
  );

  let teamA = nonBinaryTokens[0]?.outcome || null;
  let teamB = nonBinaryTokens[1]?.outcome || null;
  let priceA = nonBinaryTokens[0]?.price || null;
  let priceB = nonBinaryTokens[1]?.price || null;

  if (!teamA || !teamB) {
    const parsed = parseTeamsFromQuestion(question);
    teamA = teamA || parsed.teamA;
    teamB = teamB || parsed.teamB;

    const yesToken = pricedTokens.find(
      (t) => t.outcome.toLowerCase() === "yes",
    );
    const noToken = pricedTokens.find((t) => t.outcome.toLowerCase() === "no");

    // Fallback to outcomePrices payload when token prices are absent
    let outcomePriceA = null;
    let outcomePriceB = null;
    if (market.outcomePrices) {
      try {
        const parsed = JSON.parse(market.outcomePrices);
        outcomePriceA = Number(parsed?.[0]);
        outcomePriceB = Number(parsed?.[1]);
      } catch (_e) {
        // ignore malformed payload
      }
    }

    priceA = priceA ?? (yesToken ? yesToken.price : (outcomePriceA ?? 0.5));
    priceB = priceB ?? (noToken ? noToken.price : (outcomePriceB ?? 0.5));
  }

  if (!teamA || !teamB) return null;

  const questionLower = question.toLowerCase();
  const marketType =
    questionLower.includes("o/u") || questionLower.includes("total")
      ? "total"
      : questionLower.includes("spread") || /\s[+-]\d/.test(questionLower)
        ? "spread"
        : "moneyline";

  const marketId = market.id || market.condition_id || market.conditionId;
  const slug = market.slug || market.market_slug;

  return {
    id: marketId,
    marketId,
    slug,
    question,
    league: detectSportsLeague(market),
    marketType,
    teamA,
    teamB,
    priceA: Number(priceA || 0.5),
    priceB: Number(priceB || 0.5),
    totalVolume: Number(market.volume || market.volumeNum || 0),
    liquidity: Number(market.liquidity || market.liquidityNum || 0),
    imageUrl: market.image || market.icon || null,
    startTime:
      market.endDate ||
      market.end_date_iso ||
      market.accepting_orders_timestamp,
    isLive: true,
  };
};

/**
 * GET /api/polymarket/sports/live
 * Fetch live sports-style matches from Gamma and normalize to matchup data
 */
const getLiveSportsMatches = asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 30;

  // Pull multiple batches to avoid one-league bias and improve category coverage
  const batchSize = 200;
  const batches = 6;
  let allMarkets = [];

  for (let i = 0; i < batches; i++) {
    try {
      const response_data = await gammaApi.get("/markets", {
        params: {
          limit: batchSize,
          offset: i * batchSize,
          active: true,
          closed: false,
          order: "volume",
          ascending: false,
        },
      });

      const batch = Array.isArray(response_data.data)
        ? response_data.data
        : response_data.data.markets || response_data.data.data || [];

      allMarkets = [...allMarkets, ...batch];
    } catch (error) {
      logger.warn(`Failed sports batch ${i}: ${error.message}`);
    }
  }

  // Deduplicate by id
  const seen = new Set();
  const markets = allMarkets.filter((m) => {
    const id = m.id || m.condition_id || m.conditionId;
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const parsedMatches = markets.map(parseMatchFromMarket).filter(Boolean);

  // Prefer moneyline head-to-head markets to match sportsbook-style screens
  const moneyline = parsedMatches.filter((m) => m.marketType === "moneyline");
  const others = parsedMatches.filter((m) => m.marketType !== "moneyline");

  const matches = [...moneyline, ...others]
    .sort((a, b) => b.totalVolume - a.totalVolume)
    .slice(0, limit);

  return response.success(res, matches);
});

/**
 * GET /api/polymarket/markets
 * Fetch markets from Polymarket Gamma API
 */
const getMarkets = asyncHandler(async (req, res) => {
  const {
    limit = 50,
    offset = 0,
    active = true,
    closed = false,
    order = "volume",
  } = req.query;

  const response_data = await gammaApi.get("/markets", {
    params: {
      limit: parseInt(limit),
      offset: parseInt(offset),
      active: active === "true" || active === true,
      closed: closed === "true" || closed === true,
      order,
      ascending: false,
    },
  });

  const markets = Array.isArray(response_data.data)
    ? response_data.data
    : response_data.data.markets || response_data.data.data || [];

  const transformed = markets.map(transformMarket);

  return response.success(res, transformed);
});

/**
 * GET /api/polymarket/trending
 * Fetch trending markets - fetches multiple batches to get variety across categories
 */
const getTrendingMarkets = asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const category = req.query.category;

  // Fetch larger batch to ensure variety across categories
  const batchSize = 100;
  const batches = 3; // Fetch 300 markets total
  let allMarkets = [];

  for (let i = 0; i < batches; i++) {
    try {
      const response_data = await gammaApi.get("/markets", {
        params: {
          limit: batchSize,
          offset: i * batchSize,
          active: true,
          closed: false,
          order: "volume",
          ascending: false,
        },
      });

      const markets = Array.isArray(response_data.data)
        ? response_data.data
        : response_data.data.markets || response_data.data.data || [];

      allMarkets = [...allMarkets, ...markets];
    } catch (error) {
      logger.warn(`Failed to fetch batch ${i}: ${error.message}`);
    }
  }

  // Remove duplicates
  const seen = new Set();
  allMarkets = allMarkets.filter((m) => {
    const id = m.id || m.condition_id || m.conditionId;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  let transformed = allMarkets.map(transformMarket);

  // Handle special filter types
  const specialFilters = ["Trending", "Breaking", "New"];

  // Filter by category if specified (skip for special filters)
  if (category && category !== "All" && !specialFilters.includes(category)) {
    transformed = transformed.filter((m) => m.category === category);
  }

  // Sort based on filter type
  if (category === "New") {
    // Sort by creation date (newest first)
    transformed.sort(
      (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
    );
  } else if (category === "Breaking") {
    // Sort by recent activity (price changes, volume in last 24h)
    transformed.sort((a, b) => {
      const aScore =
        Math.abs(a.priceChange24h || 0) * 100 + (a.volume24hr || 0) / 1000;
      const bScore =
        Math.abs(b.priceChange24h || 0) * 100 + (b.volume24hr || 0) / 1000;
      return bScore - aScore;
    });
  } else {
    // Default: Sort by volume (Trending and All)
    transformed.sort((a, b) => (b.totalVolume || 0) - (a.totalVolume || 0));
  }

  return response.success(res, transformed.slice(0, limit));
});

/**
 * GET /api/polymarket/markets/:id
 * Fetch single market by ID
 */
const getMarketById = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const response_data = await gammaApi.get(`/markets/${id}`);
  const transformed = transformMarket(response_data.data);

  return response.success(res, transformed);
});

/**
 * GET /api/polymarket/search
 * Search markets
 */
const searchMarkets = asyncHandler(async (req, res) => {
  const { q, limit = 20 } = req.query;

  if (!q) {
    return response.success(res, []);
  }

  const response_data = await gammaApi.get("/markets", {
    params: {
      limit: 100,
      active: true,
      closed: false,
    },
  });

  const markets = Array.isArray(response_data.data)
    ? response_data.data
    : response_data.data.markets || response_data.data.data || [];

  // Filter by search query
  const filtered = markets.filter(
    (m) =>
      (m.question || "").toLowerCase().includes(q.toLowerCase()) ||
      (m.title || "").toLowerCase().includes(q.toLowerCase()) ||
      (m.description || "").toLowerCase().includes(q.toLowerCase()),
  );

  const transformed = filtered.slice(0, parseInt(limit)).map(transformMarket);

  return response.success(res, transformed);
});

/**
 * GET /api/polymarket/categories
 * Get categories with counts from full market dataset
 */
const getCategories = asyncHandler(async (req, res) => {
  // Fetch multiple batches for accurate counts
  const batchSize = 100;
  const batches = 3;
  let allMarkets = [];

  for (let i = 0; i < batches; i++) {
    try {
      const response_data = await gammaApi.get("/markets", {
        params: {
          limit: batchSize,
          offset: i * batchSize,
          active: true,
          closed: false,
        },
      });

      const markets = Array.isArray(response_data.data)
        ? response_data.data
        : response_data.data.markets || response_data.data.data || [];

      allMarkets = [...allMarkets, ...markets];
    } catch (error) {
      logger.warn(`Failed to fetch batch ${i}: ${error.message}`);
    }
  }

  // Remove duplicates
  const seen = new Set();
  allMarkets = allMarkets.filter((m) => {
    const id = m.id || m.condition_id || m.conditionId;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });

  const transformed = allMarkets.map(transformMarket);

  const categoryCounts = transformed.reduce((acc, market) => {
    const cat = market.category;
    acc[cat] = (acc[cat] || 0) + 1;
    return acc;
  }, {});

  const categories = Object.entries(categoryCounts)
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count);

  return response.success(res, categories);
});

/**
 * GET /api/polymarket/trades/:conditionId
 * Fetch trades for a market
 */
const getTrades = asyncHandler(async (req, res) => {
  const { conditionId } = req.params;
  const { limit = 50 } = req.query;

  try {
    const response_data = await clobApi.get("/trades", {
      params: {
        asset_id: conditionId,
        limit: parseInt(limit),
      },
    });

    return response.success(res, response_data.data || []);
  } catch (error) {
    logger.error(`Failed to fetch trades: ${error.message}`);
    return response.success(res, []);
  }
});

/**
 * GET /api/polymarket/prices/:conditionId
 * Fetch price history
 */
const getPriceHistory = asyncHandler(async (req, res) => {
  const { conditionId } = req.params;
  const { period = "24h" } = req.query;

  try {
    const interval = period === "24h" ? "1h" : period === "7d" ? "4h" : "1d";

    const response_data = await clobApi.get("/prices-history", {
      params: {
        market: conditionId,
        interval,
        fidelity: 60,
      },
    });

    return response.success(res, response_data.data?.history || []);
  } catch (error) {
    logger.error(`Failed to fetch price history: ${error.message}`);
    return response.success(res, []);
  }
});

module.exports = {
  getMarkets,
  getTrendingMarkets,
  getLiveSportsMatches,
  getMarketById,
  searchMarkets,
  getCategories,
  getTrades,
  getPriceHistory,
};
