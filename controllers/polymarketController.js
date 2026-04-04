/**
 * Polymarket Proxy Controller
 * Proxies requests to Polymarket Gamma API to avoid CORS issues
 */

const axios = require("axios");
const Market = require("../models/Market");
const Transaction = require("../models/Transaction");
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

const RECENT_TRADES_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Known primary category tags from Gamma (case-insensitive matching)
 */
const CATEGORY_TAG_MAP = {
  sports: "Sports",
  nba: "Sports",
  nfl: "Sports",
  mlb: "Sports",
  nhl: "Sports",
  soccer: "Sports",
  football: "Sports",
  basketball: "Sports",
  baseball: "Sports",
  tennis: "Sports",
  golf: "Sports",
  "champions league": "Sports",
  "premier league": "Sports",
  "world cup": "Sports",
  epl: "Sports",
  superbowl: "Sports",
  "super bowl": "Sports",
  ufc: "Sports",
  boxing: "Sports",
  f1: "Sports",
  "formula 1": "Sports",

  politics: "Politics",
  trump: "Politics",
  biden: "Politics",
  "trump presidency": "Politics",
  congress: "Politics",
  senate: "Politics",

  elections: "Politics",
  election: "Politics",
  "us election": "Politics",
  "world elections": "Politics",
  "global elections": "Politics",
  primary: "Politics",
  nominee: "Politics",

  crypto: "Crypto",
  bitcoin: "Crypto",
  ethereum: "Crypto",
  solana: "Crypto",
  defi: "Crypto",

  economy: "Economy",
  "fed rates": "Economy",
  inflation: "Economy",
  recession: "Economy",
  gdp: "Economy",
  tariff: "Economy",

  finance: "Finance",
  stocks: "Finance",
  "stock market": "Finance",

  tech: "Tech",
  ai: "Tech",
  "artificial intelligence": "Tech",

  iran: "Iran",

  geopolitics: "Geopolitics",
  war: "Geopolitics",
  military: "Geopolitics",
  nato: "Geopolitics",

  esports: "Esports",
  gaming: "Esports",

  weather: "Weather",
  climate: "Weather",

  culture: "Culture",
  entertainment: "Culture",
  movies: "Culture",
  music: "Culture",
};

/**
 * Map category from tags (prioritizes Gamma event tags)
 * @param {Array} tags - Array of tag objects from Gamma (with .label) or strings
 * @param {string} question - Market question as fallback
 */
const mapCategory = (tags = [], question = "") => {
  // Extract tag labels - handle both object tags (from Gamma) and string tags
  const tagLabels = (tags || [])
    .map((t) => (typeof t === "object" && t !== null ? t.label || t.slug : t))
    .filter(Boolean)
    .map((s) => String(s).toLowerCase());

  // Check tag labels against known categories (priority order)
  for (const label of tagLabels) {
    if (CATEGORY_TAG_MAP[label]) {
      return CATEGORY_TAG_MAP[label];
    }
  }

  // Fallback: check if any tag label contains a known category keyword
  for (const label of tagLabels) {
    for (const [keyword, category] of Object.entries(CATEGORY_TAG_MAP)) {
      if (label.includes(keyword)) {
        return category;
      }
    }
  }

  // Last resort: text-based detection on question
  const questionLower = (question || "").toLowerCase();
  for (const [keyword, category] of Object.entries(CATEGORY_TAG_MAP)) {
    if (questionLower.includes(keyword)) {
      return category;
    }
  }

  return "World";
};

const normalizeOutcomeKey = (value = "") =>
  String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "OUTCOME";

const clampProbability = (value) => {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0.001, Math.min(0.999, num));
};

const parseJsonArray = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_error) {
      return [];
    }
  }
  return [];
};

const parseMarketOutcomes = (market) => {
  const tokens = Array.isArray(market.tokens) ? market.tokens : [];
  const tokenOutcomes = tokens
    .filter((token) => token && token.outcome != null)
    .map((token, index) => {
      const label = String(token.outcome);
      const rawPrice = token.price ?? token.lastPrice ?? token.mid;
      return {
        key: normalizeOutcomeKey(label),
        label,
        price: clampProbability(rawPrice),
        volume: Number(token.volume ?? token.volumeNum ?? 0) || 0,
        recentTrades: Number(token.recentTrades ?? token.trades ?? 0) || 0,
        order: index,
      };
    });

  if (tokenOutcomes.length > 0) {
    return tokenOutcomes;
  }

  const labels = parseJsonArray(market.outcomes).map((value) => String(value));
  const prices = parseJsonArray(market.outcomePrices).map((value) =>
    clampProbability(value),
  );

  if (labels.length > 0) {
    return labels.map((label, index) => ({
      key: normalizeOutcomeKey(label),
      label,
      price: prices[index] ?? 0.5,
      volume: 0,
      recentTrades: 0,
      order: index,
    }));
  }

  if (prices.length > 0) {
    return prices.map((price, index) => ({
      key: `OUTCOME_${index + 1}`,
      label: `Outcome ${index + 1}`,
      price,
      volume: 0,
      recentTrades: 0,
      order: index,
    }));
  }

  return [
    {
      key: "YES",
      label: "Yes",
      price: 0.5,
      volume: 0,
      recentTrades: 0,
      order: 0,
    },
    {
      key: "NO",
      label: "No",
      price: 0.5,
      volume: 0,
      recentTrades: 0,
      order: 1,
    },
  ];
};

const mergeOutcomeStats = (outcomes, statsByOutcome) =>
  outcomes.map((outcome) => {
    const stat = statsByOutcome?.[outcome.key] || {};
    return {
      ...outcome,
      volume: (outcome.volume || 0) + (stat.volume || 0),
      recentTrades: (outcome.recentTrades || 0) + (stat.recentTrades || 0),
    };
  });

const attachLocalOutcomeStats = async (markets) => {
  if (!Array.isArray(markets) || markets.length === 0) {
    return markets;
  }

  const externalIds = markets
    .map((market) => String(market._id || ""))
    .filter(Boolean);
  const conditionIds = markets
    .map((market) => String(market.conditionId || ""))
    .filter(Boolean);

  if (externalIds.length === 0 && conditionIds.length === 0) {
    return markets;
  }

  const localMarkets = await Market.find({
    $or: [
      { externalId: { $in: externalIds } },
      { conditionId: { $in: conditionIds } },
    ],
  })
    .select("_id externalId conditionId")
    .lean();

  if (!localMarkets.length) {
    return markets;
  }

  const localByExternal = new Map();
  const localByCondition = new Map();

  for (const localMarket of localMarkets) {
    if (localMarket.externalId) {
      localByExternal.set(String(localMarket.externalId), localMarket);
    }
    if (localMarket.conditionId) {
      localByCondition.set(String(localMarket.conditionId), localMarket);
    }
  }

  const localMarketIds = localMarkets.map((market) => market._id);
  const recentCutoff = new Date(Date.now() - RECENT_TRADES_WINDOW_MS);

  const aggregated = await Transaction.aggregate([
    {
      $match: {
        marketId: { $in: localMarketIds },
        type: { $in: ["trade_buy", "trade_sell"] },
        status: "completed",
        "tradeDetails.outcome": { $exists: true, $ne: null },
      },
    },
    {
      $group: {
        _id: {
          marketId: "$marketId",
          outcome: "$tradeDetails.outcome",
        },
        volume: { $sum: { $ifNull: ["$amount", 0] } },
        recentTrades: {
          $sum: {
            $cond: [{ $gte: ["$createdAt", recentCutoff] }, 1, 0],
          },
        },
      },
    },
  ]);

  const statsByMarket = new Map();
  for (const item of aggregated) {
    const marketKey = String(item._id.marketId);
    const outcomeKey = normalizeOutcomeKey(item._id.outcome);
    if (!statsByMarket.has(marketKey)) {
      statsByMarket.set(marketKey, {});
    }
    statsByMarket.get(marketKey)[outcomeKey] = {
      volume: Number(item.volume || 0),
      recentTrades: Number(item.recentTrades || 0),
    };
  }

  return markets.map((market) => {
    const localMarket =
      localByExternal.get(String(market._id)) ||
      localByCondition.get(String(market.conditionId || ""));

    if (!localMarket) return market;

    const stats = statsByMarket.get(String(localMarket._id)) || {};

    return {
      ...market,
      outcomes: mergeOutcomeStats(market.outcomes || [], stats),
    };
  });
};

/**
 * Transform Polymarket market to internal format
 */
const transformMarket = (market) => {
  const outcomes = parseMarketOutcomes(market);
  const yesOutcome = outcomes.find((outcome) => outcome.key === "YES");
  const noOutcome = outcomes.find((outcome) => outcome.key === "NO");
  const totalVolume = parseFloat(market.volume || market.volumeNum || 0);
  const hasOutcomeVolume = outcomes.some(
    (outcome) => Number(outcome.volume || 0) > 0,
  );
  const fallbackOutcomeVolume =
    outcomes.length > 0 && totalVolume > 0 ? totalVolume / outcomes.length : 0;

  const yesPrice = yesOutcome?.price ?? clampProbability(market.bestBid ?? 0.5);
  const noPrice = noOutcome?.price ?? clampProbability(1 - yesPrice);

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
    outcomes: outcomes.map((outcome) => ({
      key: outcome.key,
      label: outcome.label,
      price: outcome.price,
      probability: outcome.price,
      volume: hasOutcomeVolume
        ? Number(outcome.volume || 0)
        : Number(fallbackOutcomeVolume || 0),
      recentTrades: Number(outcome.recentTrades || 0),
    })),
    priceChange24h,
    totalVolume,
    liquidity: parseFloat(market.liquidity || market.liquidityNum || 0),
    imageUrl: market.image || market.icon || null,
    slug: market.slug || market.market_slug,
    groupItemTitle: market.groupItemTitle || null,
    siblingCount: market.siblingCount || 0,
    eventId:
      market.eventId || market.events?.[0]?.id || market.event?.id || null,
    conditionId: market.conditionId || market.condition_id,
    resolved: market.closed || market.resolved || false,
    outcome: market.outcome || null,
    tags: market.tags || [],
    createdAt: market.createdAt || market.created_at || null,
  };
};

const buildGroupedContracts = (eventPayload, currentMarketId) => {
  const eventMarkets = Array.isArray(eventPayload?.markets)
    ? eventPayload.markets
    : [];

  if (eventMarkets.length <= 1) {
    return [];
  }

  return (
    eventMarkets
      .map((item) => transformMarket(item))
      .map((item) => ({
        id: String(item._id),
        slug: item.slug || null,
        label: item.groupItemTitle || item.question,
        question: item.question,
        yesPrice: Number(item.yesPrice || 0.5),
        noPrice: Number(item.noPrice || 0.5),
        totalVolume: Number(item.totalVolume || 0),
        resolved: Boolean(item.resolved),
        isCurrent: String(item._id) === String(currentMarketId),
        endDate: item.endDate || null,
      }))
      // Filter out placeholder contracts (zero volume with 50% price or placeholder names)
      .filter((item) => {
        const isPlaceholderPrice =
          item.yesPrice === 0.5 && item.noPrice === 0.5;
        const isPlaceholderName =
          /^(Team\s+[A-Z]{1,2}|Other|Person\s+[A-Z])$/i.test(item.label);
        const hasNoVolume = item.totalVolume === 0;
        // Keep if it has volume, or if it doesn't look like a placeholder
        return (
          item.totalVolume > 0 || (!isPlaceholderPrice && !isPlaceholderName)
        );
      })
      .sort((a, b) => (b.totalVolume || 0) - (a.totalVolume || 0))
  );
};

const deriveEventSlugFromMarket = (market = {}) => {
  const explicitEventSlug =
    market.eventSlug || market.events?.[0]?.slug || market.event?.slug;
  if (explicitEventSlug) return String(explicitEventSlug);

  const slug = String(market.slug || market.market_slug || "").trim();
  if (!slug) return null;

  // Handles grouped binary contracts like:
  // elon-musk-of-tweets-april-2026-1600-1679 -> elon-musk-of-tweets-april-2026
  const withoutRange = slug.replace(/-(\d+)(-(\d+)|\+)$/i, "");
  return withoutRange !== slug ? withoutRange : null;
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
  const enriched = await attachLocalOutcomeStats(transformed);

  return response.success(res, enriched);
});

/**
 * GET /api/polymarket/trending
 * Fetch trending markets from Gamma events endpoint (better volume data)
 */
const getTrendingMarkets = asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const category = req.query.category;

  // Use events endpoint - has real volume data vs fake/low-volume sports markets
  let allMarkets = [];
  const now = new Date();

  try {
    // Fetch top events by volume
    const eventsResponse = await gammaApi.get("/events", {
      params: {
        limit: 50,
        order: "volume",
        ascending: false,
        active: true,
        closed: false,
      },
    });

    const events = Array.isArray(eventsResponse.data)
      ? eventsResponse.data
      : eventsResponse.data.events || [];

    // Extract all active markets from events, inheriting event tags and sibling count
    for (const event of events) {
      const eventMarkets = Array.isArray(event.markets) ? event.markets : [];
      const eventTags = Array.isArray(event.tags) ? event.tags : [];
      const activeEventMarkets = eventMarkets.filter(
        (m) => !m.closed && m.active !== false,
      );
      const siblingCount = activeEventMarkets.length;
      const marketsWithMeta = activeEventMarkets.map((m) => ({
        ...m,
        // Merge event tags with any market-specific tags
        tags: [...eventTags, ...(m.tags || [])],
        // Track how many sibling markets exist in the same event
        siblingCount,
        // Pass eventId so detail page can fetch siblings directly
        eventId: event.id,
      }));
      allMarkets = [...allMarkets, ...marketsWithMeta];
    }
  } catch (error) {
    logger.warn(`Failed to fetch events: ${error.message}`);
  }

  // Fallback: also fetch some from markets endpoint if needed
  if (allMarkets.length < 50) {
    try {
      const marketsResponse = await gammaApi.get("/markets", {
        params: {
          limit: 100,
          active: true,
          closed: false,
          order: "liquidity",
          ascending: false,
        },
      });
      const fallbackMarkets = Array.isArray(marketsResponse.data)
        ? marketsResponse.data
        : marketsResponse.data.markets || [];
      // Only add markets with meaningful volume
      const validFallback = fallbackMarkets.filter(
        (m) => parseFloat(m.volume || 0) > 10000,
      );
      allMarkets = [...allMarkets, ...validFallback];
    } catch (error) {
      logger.warn(`Failed to fetch fallback markets: ${error.message}`);
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

  // Filter out resolved markets and markets with end dates in the past
  transformed = transformed.filter((m) => {
    if (m.resolved) return false;
    if (m.endDate) {
      const endDate = new Date(m.endDate);
      if (endDate < now) return false;
    }
    return true;
  });

  // Handle special filter types
  const specialFilters = ["Trending", "Breaking", "New"];

  // Filter by category if specified (skip for special filters)
  if (category && category !== "All" && !specialFilters.includes(category)) {
    transformed = transformed.filter((m) => m.category === category);
  }

  // Sort based on filter type
  if (category === "New") {
    // New: Diverse markets sorted by creation date
    // Ensure variety by picking newest from each category
    const byCategory = {};
    transformed.forEach((m) => {
      const cat = m.category || "Other";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(m);
    });

    // Sort each category by creation date (newest first)
    Object.values(byCategory).forEach((arr) => {
      arr.sort(
        (a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0),
      );
    });

    // Pick newest from each category, then fill remaining
    const diverse = [];
    const used = new Set();
    const categories = Object.keys(byCategory).sort(
      (a, b) =>
        new Date(byCategory[b][0]?.createdAt || 0) -
        new Date(byCategory[a][0]?.createdAt || 0),
    );

    // First pass: one from each category
    for (const cat of categories) {
      const market = byCategory[cat][0];
      if (market && !used.has(market._id)) {
        diverse.push(market);
        used.add(market._id);
      }
    }

    // Second pass: fill remaining slots by creation date
    const remaining = transformed
      .filter((m) => !used.has(m._id))
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    diverse.push(...remaining);

    transformed = diverse;
  } else if (category === "Breaking") {
    // Breaking: Diverse markets with biggest price changes
    // Ensure variety by picking top market from each category first
    const byCategory = {};
    transformed.forEach((m) => {
      const cat = m.category || "Other";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(m);
    });

    // Sort each category by price change
    Object.values(byCategory).forEach((arr) => {
      arr.sort(
        (a, b) =>
          Math.abs(b.priceChange24h || 0) - Math.abs(a.priceChange24h || 0),
      );
    });

    // Pick top market from each category, then fill with remaining by price change
    const diverse = [];
    const used = new Set();
    const categories = Object.keys(byCategory).sort(
      (a, b) =>
        Math.abs(byCategory[b][0]?.priceChange24h || 0) -
        Math.abs(byCategory[a][0]?.priceChange24h || 0),
    );

    // First pass: one from each category
    for (const cat of categories) {
      const market = byCategory[cat][0];
      if (market && !used.has(market._id)) {
        diverse.push(market);
        used.add(market._id);
      }
    }

    // Second pass: fill remaining slots by price change
    const remaining = transformed
      .filter((m) => !used.has(m._id))
      .sort(
        (a, b) =>
          Math.abs(b.priceChange24h || 0) - Math.abs(a.priceChange24h || 0),
      );
    diverse.push(...remaining);

    transformed = diverse;
  } else {
    // Default: Sort by volume (Trending and All)
    transformed.sort((a, b) => (b.totalVolume || 0) - (a.totalVolume || 0));
  }

  const sliced = transformed.slice(0, limit);
  const enriched = await attachLocalOutcomeStats(sliced);

  return response.success(res, enriched);
});

/**
 * GET /api/polymarket/markets/:id
 * Fetch single market by ID
 */
const getMarketById = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { eventId: eventIdFromQuery } = req.query;

  const tryFetchGammaById = async (candidateId) => {
    if (!candidateId) return null;
    try {
      const gammaResponse = await gammaApi.get(`/markets/${candidateId}`);
      const marketData = Array.isArray(gammaResponse.data)
        ? gammaResponse.data[0]
        : gammaResponse.data;
      return marketData && (marketData.id || marketData.question)
        ? marketData
        : null;
    } catch (_error) {
      return null;
    }
  };

  let gammaMarket = await tryFetchGammaById(id);

  // If the route parameter is a local Mongo _id, resolve to external Gamma id first.
  if (!gammaMarket) {
    try {
      const slugResponse = await gammaApi.get("/markets", {
        params: {
          slug: id,
          limit: 1,
          closed: true,
        },
      });
      const slugMarkets = Array.isArray(slugResponse.data)
        ? slugResponse.data
        : slugResponse.data?.data || slugResponse.data?.markets || [];
      gammaMarket = slugMarkets[0] || null;
    } catch (_error) {
      // Ignore slug lookup errors and continue with local fallback.
    }

    if (gammaMarket) {
      const transformed = transformMarket(gammaMarket);
      const [enriched] = await attachLocalOutcomeStats([transformed]);
      return response.success(res, enriched || transformed);
    }

    let localMarket = null;
    try {
      localMarket = await Market.findById(id)
        .select(
          "externalId conditionId outcomeStates question totalVolume endDate imageUrl tags",
        )
        .lean();
    } catch (_error) {
      localMarket = await Market.findOne({
        $or: [{ externalId: id }, { conditionId: id }],
      })
        .select(
          "externalId conditionId outcomeStates question totalVolume endDate imageUrl tags",
        )
        .lean();
    }

    const candidateIds = [
      localMarket?.externalId,
      localMarket?.conditionId,
      id,
    ].filter(Boolean);

    for (const candidate of candidateIds) {
      gammaMarket = await tryFetchGammaById(candidate);
      if (gammaMarket) break;
    }

    // Last resort: use local data shape so clients still receive available outcomes.
    if (!gammaMarket && localMarket) {
      const localFallback = {
        _id: id,
        question: localMarket.question || "Market",
        description: "",
        category: "World",
        endDate: localMarket.endDate,
        yesPrice: 0.5,
        noPrice: 0.5,
        outcomes: (localMarket.outcomeStates || []).map((state, index) => ({
          key: state.key,
          label: state.label,
          price: 0.5,
          probability: 0.5,
          volume: 0,
          recentTrades: 0,
          order: Number(state.order ?? index),
        })),
        priceChange24h: 0,
        totalVolume: Number(localMarket.totalVolume || 0),
        liquidity: 0,
        imageUrl: localMarket.imageUrl || null,
        slug: null,
        conditionId: localMarket.conditionId || null,
        resolved: false,
        outcome: null,
        tags: localMarket.tags || [],
      };

      const [enrichedLocal] = await attachLocalOutcomeStats([localFallback]);
      return response.success(res, enrichedLocal || localFallback);
    }
  }

  if (!gammaMarket) {
    return response.notFound(res, "Market");
  }

  const transformed = transformMarket(gammaMarket);

  // Use eventId from query param (passed from frontend) or from market data
  const effectiveEventId = eventIdFromQuery || transformed.eventId;

  if (effectiveEventId) {
    try {
      const eventResponse = await gammaApi.get(`/events/${effectiveEventId}`);
      const eventPayload = Array.isArray(eventResponse.data)
        ? eventResponse.data[0]
        : eventResponse.data;
      const groupedContracts = buildGroupedContracts(
        eventPayload,
        transformed._id,
      );
      if (groupedContracts.length > 0) {
        transformed.groupContracts = groupedContracts;
        transformed.eventId = effectiveEventId;
      }
    } catch (_error) {
      // Non-fatal. Some events may not expose grouped markets.
    }
  }

  // Fallback 1: Try deriving event slug from market slug (for -NNNN-NNNN or -NNNN+ patterns)
  if (
    !Array.isArray(transformed.groupContracts) ||
    transformed.groupContracts.length <= 1
  ) {
    const derivedEventSlug = deriveEventSlugFromMarket(gammaMarket);
    if (derivedEventSlug) {
      try {
        const eventLookupResponse = await gammaApi.get("/events", {
          params: {
            slug: derivedEventSlug,
            limit: 1,
          },
        });
        const eventResults = Array.isArray(eventLookupResponse.data)
          ? eventLookupResponse.data
          : eventLookupResponse.data?.data ||
            eventLookupResponse.data?.events ||
            [];
        const matchedEvent = eventResults[0];
        const groupedContracts = buildGroupedContracts(
          matchedEvent,
          transformed._id,
        );
        if (groupedContracts.length > 0) {
          transformed.groupContracts = groupedContracts;
          transformed.eventId = transformed.eventId || matchedEvent?.id || null;
        }
      } catch (_error) {
        // Non-fatal fallback; market detail still returns without grouped contracts.
      }
    }
  }

  // Fallback 2: If groupItemTitle is set, search top events to find parent event
  if (
    (!Array.isArray(transformed.groupContracts) ||
      transformed.groupContracts.length <= 1) &&
    transformed.groupItemTitle
  ) {
    try {
      const eventsResponse = await gammaApi.get("/events", {
        params: {
          limit: 200,
          order: "volume",
          ascending: false,
          active: true,
        },
      });
      const events = Array.isArray(eventsResponse.data)
        ? eventsResponse.data
        : eventsResponse.data?.events || [];

      // Find the event containing this market
      const parentEvent = events.find(
        (ev) =>
          Array.isArray(ev.markets) &&
          ev.markets.some((m) => String(m.id) === String(transformed._id)),
      );

      if (parentEvent) {
        const groupedContracts = buildGroupedContracts(
          parentEvent,
          transformed._id,
        );
        if (groupedContracts.length > 0) {
          transformed.groupContracts = groupedContracts;
          transformed.eventId = transformed.eventId || parentEvent.id || null;
        }
      }
    } catch (_error) {
      // Non-fatal fallback
    }
  }

  const [enriched] = await attachLocalOutcomeStats([transformed]);

  return response.success(res, enriched || transformed);
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
  const enriched = await attachLocalOutcomeStats(transformed);

  return response.success(res, enriched);
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
