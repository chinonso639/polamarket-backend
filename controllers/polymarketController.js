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
const { getGammaCached, setGammaCached } = require("../utils/gammaCache");

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

// ── TheSportsDB team badge cache ─────────────────────────────────────────────
const _teamBadgeCache = new Map();

/**
 * Normalise a team name for TheSportsDB lookup:
 * - Remove accents/diacritics
 * - Strip common prefixes (FC, SK, AS, …)
 * Returns an array of candidates to try in order.
 */
const _teamNameCandidates = (name = "") => {
  const stripped = name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // remove diacritics
    .replace(/\s+/g, " ")
    .trim();
  const noPrefix = stripped
    .replace(
      /^(fc|fk|sk|sc|ac|as|rc|vfb|vfl|sv|bv|rb|1\.\s*fc|1\.\s*fk|1\.)\s+/i,
      "",
    )
    .trim();
  const candidates = Array.from(
    new Set([name.trim(), stripped, noPrefix].filter(Boolean)),
  );
  return candidates;
};

const fetchTeamBadge = async (teamName) => {
  if (!teamName) return null;
  const cacheKey = teamName.toLowerCase().trim();
  if (_teamBadgeCache.has(cacheKey)) return _teamBadgeCache.get(cacheKey);

  const candidates = _teamNameCandidates(teamName);
  let badge = null;
  for (const candidate of candidates) {
    try {
      const r = await axios.get(
        "https://www.thesportsdb.com/api/v1/json/3/searchteams.php",
        { params: { t: candidate }, timeout: 5000 },
      );
      const team = r.data?.teams?.[0];
      const found = team?.strBadge || team?.strLogo || null;
      if (found) {
        badge = found;
        break;
      }
    } catch {
      /* continue */
    }
  }
  _teamBadgeCache.set(cacheKey, badge);
  return badge;
};

// ── Sofascore live score + team logos ────────────────────────────────────────

// Normalise a team name to bare words for fuzzy matching
const _bareTeam = (name = "") =>
  name
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\b(fc|fk|sk|sc|ac|as|rc|sv|vfb|vfl|rb|1\.\s*fc|1\.)\b/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

const _nameMatch = (a = "", b = "") => {
  const ba = _bareTeam(a);
  const bb = _bareTeam(b);
  if (!ba || !bb) return false;
  return (
    ba === bb ||
    ba.includes(bb) ||
    bb.includes(ba) ||
    ba.split(" ").some((w) => w.length > 3 && bb.includes(w))
  );
};

const _liveScoreCache = new Map(); // key: slugPrefix → { data, ts }
const SOFASCORE_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36",
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  "Accept-Encoding": "gzip, deflate, br",
  Referer: "https://www.sofascore.com/",
  Origin: "https://www.sofascore.com",
  "sec-ch-ua":
    '"Chromium";v="123", "Google Chrome";v="123", "Not:A-Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
};

// ── API-Football fallback (used when Sofascore is blocked in production) ─────
const _apifootballKey = process.env.APIFOOTBALL_KEY;
const APIFOOTBALL_HEADERS = _apifootballKey
  ? { "x-apisports-key": _apifootballKey }
  : null;

const _apifootballScoreCache = new Map(); // key: dateStr → { events, ts }

const _fetchApifootballEvents = async (dateStr) => {
  if (!APIFOOTBALL_HEADERS) return [];
  const cached = _apifootballScoreCache.get(dateStr);
  if (cached && Date.now() - cached.ts < 60_000) return cached.events;
  try {
    const [liveRes, schedRes] = await Promise.allSettled([
      axios.get("https://v3.football.api-sports.io/fixtures?live=all", {
        headers: APIFOOTBALL_HEADERS,
        timeout: 8000,
      }),
      axios.get(`https://v3.football.api-sports.io/fixtures?date=${dateStr}`, {
        headers: APIFOOTBALL_HEADERS,
        timeout: 8000,
      }),
    ]);
    const liveEvents =
      liveRes.status === "fulfilled" ? liveRes.value.data?.response || [] : [];
    const schedEvents =
      schedRes.status === "fulfilled"
        ? schedRes.value.data?.response || []
        : [];
    const liveIds = new Set(liveEvents.map((e) => e.fixture?.id));
    const merged = [...liveEvents];
    for (const e of schedEvents) {
      if (!liveIds.has(e.fixture?.id)) merged.push(e);
    }
    _apifootballScoreCache.set(dateStr, { events: merged, ts: Date.now() });
    return merged;
  } catch {
    return [];
  }
};

const _normaliseApifootballEvent = (e) => {
  const statusShort = e.fixture?.status?.short;
  const elapsed = e.fixture?.status?.elapsed ?? null;
  const LIVE_SHORTS = ["1H", "2H", "HT", "ET", "BT", "P"];
  const ENDED_SHORTS = ["FT", "AET", "PEN"];
  const normStatus = LIVE_SHORTS.includes(statusShort)
    ? statusShort === "HT"
      ? "HT"
      : "LIVE"
    : ENDED_SHORTS.includes(statusShort)
      ? "FT"
      : "NS";
  return {
    home: e.goals?.home ?? null,
    away: e.goals?.away ?? null,
    statusShort: normStatus,
    statusLong: e.fixture?.status?.long || "",
    elapsed,
    homeTeamId: null,
    awayTeamId: null,
  };
};

const fetchLiveScore = async (slugPrefix, teamA, teamB, gameStartTimestamp) => {
  const now = Date.now();
  const kickoff = gameStartTimestamp
    ? new Date(gameStartTimestamp).getTime()
    : null;
  if (!kickoff) return null;

  // Only fetch from -15min before kickoff to +140min after
  if (now < kickoff - 15 * 60 * 1000 || now > kickoff + 140 * 60 * 1000)
    return null;

  // Return cached result (valid for 60s)
  const cached = _liveScoreCache.get(slugPrefix);
  if (cached && now - cached.ts < 60_000) return cached.data;

  // Extract date from slugPrefix e.g. "cze1-fvp-fkt-2026-04-04"
  const dateStr = (() => {
    const parts = slugPrefix.split("-");
    for (let i = 0; i < parts.length; i++) {
      if (/^20\d{2}$/.test(parts[i]) && i + 2 < parts.length) {
        return `${parts[i]}-${parts[i + 1]}-${parts[i + 2]}`;
      }
    }
    return null;
  })();
  if (!dateStr) return null;

  // ── Try Sofascore first ───────────────────────────────────────────────────
  try {
    let events = [];
    try {
      const liveRes = await axios.get(
        "https://api.sofascore.com/api/v1/sport/football/events/live",
        { headers: SOFASCORE_HEADERS, timeout: 6000 },
      );
      events = liveRes.data?.events || [];
    } catch {
      /* ignore, fall through to scheduled */
    }

    const schedRes = await axios.get(
      `https://api.sofascore.com/api/v1/sport/football/scheduled-events/${dateStr}`,
      { headers: SOFASCORE_HEADERS, timeout: 6000 },
    );
    const scheduled = schedRes.data?.events || [];

    const liveIds = new Set(events.map((e) => e.id));
    for (const e of scheduled) {
      if (!liveIds.has(e.id)) events.push(e);
    }

    const match =
      events.find(
        (e) =>
          _nameMatch(e.homeTeam?.name, teamA) &&
          _nameMatch(e.awayTeam?.name, teamB),
      ) ||
      events.find(
        (e) =>
          _nameMatch(e.homeTeam?.name, teamA) ||
          _nameMatch(e.awayTeam?.name, teamB),
      );

    if (!match) {
      _liveScoreCache.set(slugPrefix, { data: null, ts: now });
      return null;
    }

    const statusDesc = match.status?.description || "";
    const LIVE_STATUSES = [
      "1st half",
      "2nd half",
      "Half Time",
      "Extra Time",
      "Extra time halftime",
      "Penalties",
    ];
    const ENDED_STATUSES = ["Ended", "After extra time", "After penalties"];
    const statusShort = LIVE_STATUSES.some((s) =>
      statusDesc.toLowerCase().includes(s.toLowerCase()),
    )
      ? statusDesc.toLowerCase().includes("half time")
        ? "HT"
        : "LIVE"
      : ENDED_STATUSES.some((s) =>
            statusDesc.toLowerCase().includes(s.toLowerCase()),
          )
        ? "FT"
        : "NS";

    const elapsed = match.time?.played ?? null;

    const score = {
      home: match.homeScore?.current ?? null,
      away: match.awayScore?.current ?? null,
      statusShort,
      statusLong: statusDesc,
      elapsed,
      homeTeamId: match.homeTeam?.id ?? null,
      awayTeamId: match.awayTeam?.id ?? null,
    };

    _liveScoreCache.set(slugPrefix, { data: score, ts: now });
    return score;
  } catch (sofaErr) {
    logger.warn("Sofascore fetch failed:", sofaErr.message);
  }

  // ── Fallback: API-Football ────────────────────────────────────────────────
  if (APIFOOTBALL_HEADERS) {
    try {
      const afEvents = await _fetchApifootballEvents(dateStr);
      const afMatch =
        afEvents.find(
          (e) =>
            _nameMatch(e.teams?.home?.name, teamA) &&
            _nameMatch(e.teams?.away?.name, teamB),
        ) ||
        afEvents.find(
          (e) =>
            _nameMatch(e.teams?.home?.name, teamA) ||
            _nameMatch(e.teams?.away?.name, teamB),
        );

      if (afMatch) {
        const score = _normaliseApifootballEvent(afMatch);
        _liveScoreCache.set(slugPrefix, { data: score, ts: now });
        return score;
      }
    } catch (afErr) {
      logger.warn("API-Football fallback failed:", afErr.message);
    }
  }

  _liveScoreCache.set(slugPrefix, { data: null, ts: now });
  return null;
};

/**
 * Maps frontend nav label (lowercase) to internal category value stored on markets.
 * Handles case differences and conceptual label differences.
 */
const FRONTEND_LABEL_TO_CATEGORY = {
  politics: "politics",
  elections: "politics",
  sports: "sports",
  crypto: "crypto",
  esports: "entertainment",
  culture: "entertainment",
  entertainment: "entertainment",
  finance: "business",
  business: "business",
  geopolitics: "world",
  iran: "world",
  world: "world",
  tech: "science",
  weather: "science",
  science: "science",
  economy: "other",
  mentions: "other",
  other: "other",
};

/**
 * Known primary category tags from Gamma (case-insensitive matching)
 */
const CATEGORY_TAG_MAP = {
  nba: "sports",
  nfl: "sports",
  mlb: "sports",
  nhl: "sports",
  soccer: "sports",
  football: "sports",
  basketball: "sports",
  baseball: "sports",
  tennis: "sports",
  golf: "sports",
  "champions league": "sports",
  "premier league": "sports",
  "world cup": "sports",
  epl: "sports",
  superbowl: "sports",
  "super bowl": "sports",
  ufc: "sports",
  boxing: "sports",
  f1: "sports",
  "formula 1": "sports",

  politics: "politics",
  trump: "politics",
  biden: "politics",
  "trump presidency": "politics",
  congress: "politics",
  senate: "politics",

  elections: "politics",
  election: "politics",
  "us election": "politics",
  "world elections": "politics",
  "global elections": "politics",
  primary: "politics",
  nominee: "politics",

  crypto: "crypto",
  bitcoin: "crypto",
  ethereum: "crypto",
  solana: "crypto",
  defi: "crypto",

  economy: "other",
  "fed rates": "other",
  inflation: "other",
  recession: "other",
  gdp: "other",
  tariff: "other",

  finance: "business",
  stocks: "business",
  "stock market": "business",

  tech: "science",
  ai: "science",
  "artificial intelligence": "science",

  iran: "world",

  geopolitics: "world",
  war: "world",
  military: "world",
  nato: "world",

  esports: "entertainment",
  gaming: "entertainment",

  weather: "science",
  climate: "science",

  culture: "entertainment",
  entertainment: "entertainment",
  movies: "entertainment",
  music: "entertainment",
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

  return "world";
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
  "atp",
  "wta",
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
  "fight",
  "hockey",
];

const extractTagText = (tags = []) =>
  (Array.isArray(tags) ? tags : [])
    .map((tag) => {
      if (typeof tag === "string") return tag;
      if (tag && typeof tag === "object") return tag.name || tag.slug || "";
      return "";
    })
    .join(" ");

// Gamma slug prefix → soccer league name
const SOCCER_SLUG_PREFIX_MAP = {
  bun: "Bundesliga",
  bl2: "2. Bundesliga",
  bl3: "3. Liga",
  sea: "Serie A",
  itsb: "Serie B",
  lal: "La Liga",
  es2: "La Liga 2",
  elc: "Championship",
  efa: "Championship",
  eng1: "Championship",
  spl: "Saudi Pro League",
  fl1: "Ligue 1",
  fl2: "Ligue 2",
  tur: "Super Lig",
  isp: "ISL",
  ind1: "ISL",
  bra1: "Brasileirão",
  bra2: "Brasileirão Série B",
  nor: "Eliteserien",
  ere: "Eredivisie",
  por: "Liga Portugal",
  por2: "Liga Portugal 2",
  cze1: "Czech First League",
  svk1: "Slovak Super Liga",
  den: "Danish Superliga",
  kor: "K League",
  mar1: "Botola Pro",
  col: "Conference League",
  col1: "Copa Colombia",
  arg1: "Liga Profesional",
  arg2: "Primera Nacional",
  scop: "Scottish Premiership",
  sco1: "Scottish Premiership",
  rus: "Russian Premier League",
  rus1: "Russian Premier League",
  sud: "Copa Sudamericana",
  j1100: "J-League",
  j1: "J-League",
  jpn1: "J-League",
  mls: "MLS",
  mlsmls: "MLS",
  ucl: "Champions League",
  uel: "Europa League",
  uecl: "Conference League",
  afl: "Australian A-League",
  gre1: "Super League Greece",
  bel1: "Pro League Belgium",
  sco2: "Scottish Championship",
  wal1: "Cymru Premier",
  nig1: "NPFL Nigeria",
  egy1: "Egyptian Premier League",
  rsa1: "PSL South Africa",
  mex1: "Liga MX",
  mex2: "Ascenso MX",
  chi1: "Primera División Chile",
  uru1: "Primera División Uruguay",
  per1: "Liga 1 Peru",
  ecu1: "LigaPro Ecuador",
  ven1: "Primera División Venezuela",
  bol1: "División de Fútbol Bolivia",
  par1: "División de Honor Paraguay",
  con: "CONCACAF League",
  caf: "CAF Champions League",
};

// Slug prefixes that are NOT soccer (basketball, esports, cricket, baseball etc.)
// Do NOT add nba/nhl/nfl/ufc/tennis here — those need to reach the sports board
const NON_SOCCER_SLUG_PREFIXES = new Set([
  "bkcba",
  "bkarg",
  "bkeur",
  "bkrus",
  "bknba",
  "bkusa",
  "bktur",
  "bktbr",
  "bkbra",
  "cbb",
  "euroleague", // non-NBA basketball leagues
  "lol",
  "mlbb",
  "ow",
  "r6siege",
  "val",
  "dota",
  "pubg",
  "cs2",
  "rl",
  "apexl",
  "rocketleague",
  "smite",
  "sc2",
  "halo", // esports
  "chess",
  "checkers", // chess
  "criclcl",
  "crint",
  "cricp",
  "cri",
  "ipl", // cricket
  "mlb",
  "kbo",
  "npb", // baseball
  "f1",
  "nascar", // motorsport
  // NOTE: nhl, nfl, ufc, nba, tennis, atp, wta are intentionally NOT here —
  // they need to pass through parseMatchFromMarket so they appear on the sports board
]);

const detectSoccerLeague = (market = {}) => {
  const question = market.question || market.title || "";
  const tagText = extractTagText(market.tags);
  const slug = market.slug || market.market_slug || "";
  const t = `${question} ${tagText} ${slug}`.toLowerCase();
  const slugPrefix = slug.split("-")[0].toLowerCase();

  // Slug-prefix detection is most reliable (Gamma encodes the league in the prefix)
  if (SOCCER_SLUG_PREFIX_MAP[slugPrefix])
    return SOCCER_SLUG_PREFIX_MAP[slugPrefix];

  // Keyword fallback
  if (t.includes("premier league") || t.includes(" epl "))
    return "Premier League";
  if (t.includes("la liga") || t.includes("laliga")) return "La Liga";
  if (t.includes("serie a")) return "Serie A";
  if (t.includes("bundesliga")) return "Bundesliga";
  if (t.includes("ligue 1") || t.includes("ligue1")) return "Ligue 1";
  if (t.includes("eredivisie")) return "Eredivisie";
  if (t.includes("liga portugal") || t.includes("primeira liga"))
    return "Liga Portugal";
  if (t.includes("super lig") || t.includes("süper lig")) return "Super Lig";
  if (t.includes("scottish premiership") || t.includes("spfl"))
    return "Scottish Premiership";
  if (t.includes(" mls ") || t.includes("major league soccer")) return "MLS";
  if (t.includes("copa libertadores") || t.includes("libertadores"))
    return "Copa Libertadores";
  if (t.includes("champions league") || t.includes(" ucl "))
    return "Champions League";
  if (t.includes("europa league")) return "Europa League";
  if (t.includes("conference league")) return "Conference League";
  if (t.includes("fa cup")) return "FA Cup";
  if (t.includes("copa del rey")) return "Copa del Rey";
  if (t.includes("saudi pro league") || t.includes("saudi league"))
    return "Saudi Pro League";
  if (t.includes("brasileirão") || t.includes("serie b brazil"))
    return "Brasileirão";
  return null;
};

const detectSportsLeague = (market = {}) => {
  const question = market.question || market.title || "";
  const tagText = extractTagText(market.tags);
  const slug = market.slug || market.market_slug || "";
  const t = `${question} ${tagText} ${slug}`.toLowerCase();
  const slugPrefix = slug.split("-")[0].toLowerCase();

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

  // Known non-soccer slug prefixes: return null so parseMatchFromMarket can filter them out
  if (NON_SOCCER_SLUG_PREFIXES.has(slugPrefix)) return null;

  // Known soccer slug prefixes
  if (SOCCER_SLUG_PREFIX_MAP[slugPrefix]) return "Soccer";

  // Soccer-heavy slugs often use 3-letter league + team codes (e.g. por-spo-cds)
  if (/^[a-z]{3,5}-[a-z0-9]{2,5}-[a-z0-9]{2,5}/.test(slug)) {
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
    // Strip any league/competition prefix leaking into teamA
    // e.g. "K League 1 - Daejeon Citizen" → "Daejeon Citizen"
    let teamA = vsMatch[1].trim();
    teamA = teamA.replace(/^[\p{L}\p{N} .']+\s*[-–]\s*/u, "").trim() || teamA;
    return {
      teamA,
      teamB: vsMatch[2].trim(),
    };
  }

  const beatMatch = trimmed.match(
    /will\s+([\p{L}\p{N} .'-]{2,})\s+(beat|defeat|win against|win over|to beat)\s+([\p{L}\p{N} .'-]{2,})/iu,
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
  const slugPrefix = (market.slug || "").split("-")[0].toLowerCase();

  // Skip known non-sports-board slugs (esports, basketball, cricket, baseball, chess…)
  if (NON_SOCCER_SLUG_PREFIXES.has(slugPrefix)) return null;

  // Skip esports by question keywords
  if (
    lower.includes("counter-strike") ||
    lower.includes("cs2") ||
    lower.includes("valorant") ||
    lower.includes("league of legends") ||
    lower.includes("dota") ||
    lower.includes("overwatch") ||
    lower.includes("rainbow six") ||
    lower.includes("mobile legends") ||
    lower.includes("pubg") ||
    lower.includes("rocket league") ||
    lower.includes("lol:") ||
    lower.includes("mlbb:")
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

  const endDateRaw =
    market.endDate || market.end_date_iso || market.accepting_orders_timestamp;
  const endMs = endDateRaw ? new Date(endDateRaw).getTime() : null;
  const now = Date.now();
  const hoursUntilEnd = endMs ? (endMs - now) / 3600000 : null;

  // Skip markets resolving more than 7 days from now — too far to be "sports"
  if (hoursUntilEnd !== null && hoursUntilEnd > 168) return null;

  // isLive: market resolves within 12 hours — match is today or in progress
  const isLive =
    hoursUntilEnd !== null && hoursUntilEnd >= -2 && hoursUntilEnd <= 12;

  // matchStatus: finer label shown in the UI
  let matchStatus;
  if (hoursUntilEnd === null) {
    matchStatus = "upcoming";
  } else if (hoursUntilEnd < -2) {
    matchStatus = "ended";
  } else if (hoursUntilEnd <= 3) {
    matchStatus = "live";
  } else if (hoursUntilEnd <= 12) {
    matchStatus = "today";
  } else {
    matchStatus = "upcoming";
  }

  const detectedLeague = detectSportsLeague(market);

  return {
    id: marketId,
    marketId,
    slug,
    question,
    league: detectedLeague,
    soccerLeague:
      detectedLeague === "Soccer" ? detectSoccerLeague(market) : null,
    marketType,
    teamA,
    teamB,
    priceA: Number(priceA || 0.5),
    priceB: Number(priceB || 0.5),
    totalVolume: Number(market.volume || market.volumeNum || 0),
    liquidity: Number(market.liquidity || market.liquidityNum || 0),
    imageUrl: market.image || market.icon || null,
    startTime: endDateRaw,
    isLive,
    matchStatus,
  };
};

/**
 * GET /api/polymarket/sports/live
 * Fetch live sports-style matches from Gamma and normalize to matchup data
 */
const getLiveSportsMatches = asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit) || 500;
  // page=1 → fast load (events only, 1 Gamma call)
  // page=2 → full sweep (events + tagged + 8 broad pages)
  const page = parseInt(req.query.page) || 1;

  const leagueSlugs = Object.keys(SOCCER_SLUG_PREFIX_MAP);

  // Build request list based on page number
  const requests = [
    // Always include /events — best source for grouped match data
    gammaApi.get("/events", {
      params: {
        limit: 500,
        active: true,
        closed: false,
        order: "volume",
        ascending: false,
      },
    }),
  ];

  if (page >= 2) {
    // Full sweep: tagged + 8 broad volume-ordered pages
    requests.push(
      gammaApi.get("/markets", {
        params: {
          limit: 500,
          tag_slug: leagueSlugs.slice(0, 30).join(","),
          active: true,
          closed: false,
        },
      }),
      ...Array.from({ length: 8 }, (_, i) =>
        gammaApi.get("/markets", {
          params: {
            limit: 500,
            offset: i * 500,
            active: true,
            closed: false,
            order: "volume",
            ascending: false,
          },
        }),
      ),
    );
  }

  const allResults = await Promise.allSettled(requests);

  let allMarkets = [];
  for (let ri = 0; ri < allResults.length; ri++) {
    const result = allResults[ri];
    if (result.status !== "fulfilled") {
      logger.warn(`Sports fetch ${ri} failed: ${result.reason?.message}`);
      continue;
    }
    const data = result.value.data;
    // Detect events response by presence of events array
    const events = Array.isArray(data) ? null : data?.events || null;
    if (events) {
      for (const event of events) {
        const eventMarkets = Array.isArray(event.markets) ? event.markets : [];
        const eventTags = Array.isArray(event.tags) ? event.tags : [];
        const active = eventMarkets.filter(
          (m) => !m.closed && m.active !== false,
        );
        for (const m of active) {
          allMarkets.push({ ...m, tags: [...eventTags, ...(m.tags || [])] });
        }
      }
    } else {
      const batch = Array.isArray(data)
        ? data
        : data?.markets || data?.data || [];
      allMarkets = allMarkets.concat(batch);
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

  const marketsCacheKey = `gamma:markets:${parseInt(offset)}`;
  const cachedMarkets = await getGammaCached(marketsCacheKey);
  if (cachedMarkets) {
    const transformed = cachedMarkets.map(transformMarket);
    const enriched = await attachLocalOutcomeStats(transformed);
    return response.success(res, enriched);
  }

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

  await setGammaCached(marketsCacheKey, markets, 60);
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
  const cachedRaw = await getGammaCached("gamma:trending:raw");
  if (cachedRaw) allMarkets = cachedRaw;
  const now = new Date();

  // Rotation factor - changes every 10 minutes to show different markets
  // This ensures users see variety even with the same top volume markets
  const rotationIndex = Math.floor(Date.now() / (10 * 60 * 1000)) % 15;

  if (!cachedRaw)
    try {
      // Fetch more events to get variety across categories
      const eventsResponse = await gammaApi.get("/events", {
        params: {
          limit: 200,
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
  if (!cachedRaw && allMarkets.length < 50) {
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
  if (!cachedRaw) await setGammaCached("gamma:trending:raw", allMarkets, 60);

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
    const internalCategory =
      FRONTEND_LABEL_TO_CATEGORY[category.toLowerCase()] ||
      category.toLowerCase();
    transformed = transformed.filter(
      (m) => (m.category || "").toLowerCase() === internalCategory,
    );
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

    // Pick from each category with rotation for variety
    const diverse = [];
    const used = new Set();
    const categories = Object.keys(byCategory).sort(
      (a, b) =>
        new Date(byCategory[b][0]?.createdAt || 0) -
        new Date(byCategory[a][0]?.createdAt || 0),
    );

    // First pass: one from each category (with rotation offset)
    for (const cat of categories) {
      const catMarkets = byCategory[cat];
      const offset = rotationIndex % Math.max(1, catMarkets.length);
      const market = catMarkets[offset] || catMarkets[0];
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

    // Pick from each category with rotation for variety
    const diverse = [];
    const used = new Set();
    const categories = Object.keys(byCategory).sort(
      (a, b) =>
        Math.abs(byCategory[b][0]?.priceChange24h || 0) -
        Math.abs(byCategory[a][0]?.priceChange24h || 0),
    );

    // First pass: one from each category (with rotation offset)
    for (const cat of categories) {
      const catMarkets = byCategory[cat];
      const offset = rotationIndex % Math.max(1, catMarkets.length);
      const market = catMarkets[offset] || catMarkets[0];
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
  } else if (category === "Trending" || !category || category === "All") {
    // Trending/All: Pick diverse markets across categories with rotation
    const byCategory = {};
    transformed.forEach((m) => {
      const cat = m.category || "Other";
      if (!byCategory[cat]) byCategory[cat] = [];
      byCategory[cat].push(m);
    });

    // Sort each category by volume
    Object.values(byCategory).forEach((arr) => {
      arr.sort((a, b) => (b.totalVolume || 0) - (a.totalVolume || 0));
    });

    const diverse = [];
    const used = new Set();
    const categories = Object.keys(byCategory).sort(
      (a, b) =>
        (byCategory[b][0]?.totalVolume || 0) -
        (byCategory[a][0]?.totalVolume || 0),
    );

    // First pass: pick 2 from each category (with rotation offset)
    for (const cat of categories) {
      const catMarkets = byCategory[cat];
      const offset = rotationIndex % Math.max(1, catMarkets.length);
      // Pick up to 2 markets per category, rotated
      for (let i = 0; i < Math.min(2, catMarkets.length); i++) {
        const idx = (offset + i) % catMarkets.length;
        const market = catMarkets[idx];
        if (market && !used.has(market._id)) {
          diverse.push(market);
          used.add(market._id);
        }
      }
    }

    // Second pass: fill remaining by volume
    const remaining = transformed
      .filter((m) => !used.has(m._id))
      .sort((a, b) => (b.totalVolume || 0) - (a.totalVolume || 0));
    diverse.push(...remaining);

    transformed = diverse;
  } else {
    // Specific category sort: by volume with rotation
    transformed.sort((a, b) => (b.totalVolume || 0) - (a.totalVolume || 0));

    // Apply rotation offset so users see different markets each period
    if (transformed.length > 10 && rotationIndex > 0) {
      const offset = (rotationIndex * 3) % Math.min(40, transformed.length);
      if (offset > 0) {
        // Keep top 5 fixed, rotate the rest
        const top5 = transformed.slice(0, 5);
        const rest = transformed.slice(5);
        transformed = [
          ...top5,
          ...rest.slice(offset),
          ...rest.slice(0, offset),
        ];
      }
    }
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
        category: "world",
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
 * GET /api/polymarket/sports/match
 * Fetch all prediction markets for a specific sports match, grouped by type.
 * Accepts ?slugPrefix=bun-fre-bay-2026-04-04 to identify the match.
 */
const getSportsMatch = asyncHandler(async (req, res) => {
  const { slugPrefix } = req.query;
  if (!slugPrefix) {
    return response.error(res, "slugPrefix query param is required", 400);
  }

  // Fetch markets for this match using the same multi-source approach as getLiveSportsMatches.
  // The /events endpoint is the most reliable source for low-volume leagues (K League etc.)
  // because it groups markets by event regardless of global volume rank.
  const allResults = await Promise.allSettled([
    // /events endpoint — active: catches upcoming/live matches in all leagues
    gammaApi.get("/events", {
      params: {
        limit: 500,
        active: true,
        closed: false,
        order: "volume",
        ascending: false,
      },
    }),
    // /events endpoint — closed: catches recently finished matches
    gammaApi.get("/events", {
      params: {
        limit: 500,
        active: false,
        closed: true,
        order: "volume",
        ascending: false,
      },
    }),
    // Broad fallback — active markets by volume, 4 pages × 500
    ...Array.from({ length: 4 }, (_, i) =>
      gammaApi.get("/markets", {
        params: {
          limit: 500,
          offset: i * 500,
          order: "volume",
          ascending: false,
          active: true,
          closed: false,
        },
      }),
    ),
    // Broad fallback — closed markets by volume, 2 pages × 500
    ...Array.from({ length: 2 }, (_, i) =>
      gammaApi.get("/markets", {
        params: {
          limit: 500,
          offset: i * 500,
          order: "volume",
          ascending: false,
          active: false,
          closed: true,
        },
      }),
    ),
  ]);

  let allMarkets = [];
  for (const result of allResults) {
    if (result.status !== "fulfilled") continue;
    const data = result.value.data;
    // Events response: { events: [ { markets: [...], tags: [...] } ] }
    const events = Array.isArray(data) ? null : data?.events || null;
    if (events) {
      for (const event of events) {
        const eventMarkets = Array.isArray(event.markets) ? event.markets : [];
        const eventTags = Array.isArray(event.tags) ? event.tags : [];
        for (const m of eventMarkets) {
          allMarkets.push({ ...m, tags: [...eventTags, ...(m.tags || [])] });
        }
      }
    } else {
      // Plain markets response
      const batch = Array.isArray(data)
        ? data
        : data?.markets || data?.data || [];
      allMarkets = allMarkets.concat(batch);
    }
  }

  // Filter to this match's slug prefix (deduplicate first)
  const seenIds = new Set();
  let matchMarkets = allMarkets.filter((m) => {
    const id = m.id || m.condition_id || m.conditionId;
    if (!id || seenIds.has(id)) return false;
    seenIds.add(id);
    return m.slug && m.slug.startsWith(slugPrefix);
  });

  if (matchMarkets.length === 0) {
    // Last-resort: try Gamma search endpoint by the slug prefix itself
    try {
      const searchResult = await gammaApi.get("/markets", {
        params: {
          limit: 50,
          // Some Gamma deployments support a 'slug_contains' or 'slug' search param
          slug: slugPrefix,
          active: true,
          closed: false,
        },
      });
      const searchBatch = Array.isArray(searchResult.data)
        ? searchResult.data
        : searchResult.data?.markets || searchResult.data?.data || [];
      const extra = searchBatch.filter(
        (m) => m.slug && m.slug.startsWith(slugPrefix),
      );
      if (extra.length > 0) {
        matchMarkets.push(...extra);
      }
    } catch (_e) {
      // ignore
    }
  }

  if (matchMarkets.length === 0) {
    return response.success(res, { slugPrefix, groups: [] });
  }

  // Extract team names and metadata from the moneyline market (most informative)
  const moneylineMarket =
    matchMarkets.find((m) => m.sportsMarketType === "moneyline") ||
    matchMarkets[0];

  // Best team names: try to parse from "Team A vs Team B" in the question
  const extractTeamsFromQuestion = (question = "") => {
    // Remove leading "Will ", trailing "?" and everything after
    const cleaned = question
      .replace(/^Will\s+/i, "")
      .replace(/\?.*$/, "")
      .trim();

    // Strip common league/competition prefix patterns like:
    //   "K League 1 - Daejeon vs Daegu"  →  "Daejeon vs Daegu"
    //   "Premier League: Arsenal vs Chelsea"  →  "Arsenal vs Chelsea"
    const stripped = cleaned
      .replace(/^[A-Za-z0-9 .']+\s*-\s*/, "") // "League Name - "
      .replace(/^[A-Za-z0-9 .']+:\s*/, "") // "League Name: "
      .trim();

    // 1. Try "vs" pattern on stripped text first
    const vsStripped = stripped.match(
      /^(.+?)\s+vs\.?\s+(.+?)(?:\s*[:–-].*)?$/i,
    );
    if (vsStripped) {
      return { teamA: vsStripped[1].trim(), teamB: vsStripped[2].trim() };
    }

    // 2. Try "vs" pattern on full cleaned text, then strip any league prefix from teamA
    const vsFull = cleaned.match(/(.+?)\s+vs\.?\s+(.+?)(?:\s*[:–-].*)?$/i);
    if (vsFull) {
      let teamA = vsFull[1].trim();
      // Strip "League Name - " or "League Name: " prefix from teamA
      teamA = teamA
        .replace(/^[A-Za-z0-9 .']+\s*-\s*/, "")
        .replace(/^[A-Za-z0-9 .']+:\s*/, "")
        .trim();
      return { teamA, teamB: vsFull[2].trim() };
    }

    // 3. Handle "Will TeamA beat/defeat/win against TeamB" (binary Yes/No markets)
    const beatMatch = cleaned.match(
      /^(.+?)\s+(?:beat|defeat|win(?:s)?(?:\s+against)?|to\s+beat)\s+(.+)/i,
    );
    if (beatMatch) {
      // Strip any trailing fluff like "to win" from teamB
      const teamB = beatMatch[2].replace(/\s+to\s+win\b.*/i, "").trim();
      return { teamA: beatMatch[1].trim(), teamB };
    }

    return { teamA: null, teamB: null };
  };

  // Find the best market for team name extraction: prefer moneyline with vs pattern
  const bestForNames =
    matchMarkets.find((m) => {
      const { teamA } = extractTeamsFromQuestion(m.question);
      return !!teamA;
    }) || moneylineMarket;

  const parseOutcomePrices = (m) => {
    try {
      return JSON.parse(m.outcomePrices || "[]").map(Number);
    } catch {
      return [];
    }
  };

  const parseOutcomes = (m) => {
    try {
      return JSON.parse(m.outcomes || "[]");
    } catch {
      return [];
    }
  };

  const formatMoney = (v) => {
    const n = Number(v || 0);
    if (n >= 1000000) return `$${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `$${(n / 1000).toFixed(0)}K`;
    return `$${n.toFixed(0)}`;
  };

  // Group markets by their sportsMarketType category
  const SECTION_ORDER = [
    "moneyline",
    "spreads",
    "totals",
    "both_teams_to_score",
    "soccer_exact_score",
    "soccer_halftime_result",
    "soccer_anytime_goalscorer",
  ];

  const SECTION_LABELS = {
    moneyline: "Moneyline",
    spreads: "Spreads",
    totals: "Totals",
    both_teams_to_score: "Both Teams to Score?",
    soccer_exact_score: "Exact Score",
    soccer_halftime_result: "Halftime Result",
    soccer_anytime_goalscorer: "Goalscorers",
  };

  const sectionMap = {};
  for (const m of matchMarkets) {
    const type = m.sportsMarketType || "other";
    if (!sectionMap[type]) sectionMap[type] = [];
    const prices = parseOutcomePrices(m);
    const outcomes = parseOutcomes(m);
    sectionMap[type].push({
      id: m.id,
      slug: m.slug,
      question: m.question,
      sportsMarketType: type,
      line: m.line,
      volume: formatMoney(m.volumeNum || m.volume),
      volumeRaw: Number(m.volumeNum || m.volume || 0),
      outcomes: outcomes.map((label, idx) => ({
        label,
        price: prices[idx] ?? 0.5,
        pricePct: Math.round((prices[idx] ?? 0.5) * 100),
      })),
    });
  }

  // Build ordered groups
  const groups = [];
  for (const type of SECTION_ORDER) {
    if (sectionMap[type]) {
      // Sort within section by line (numeric) then volume
      const sorted = sectionMap[type].sort(
        (a, b) =>
          (Number(a.line) || 0) - (Number(b.line) || 0) ||
          b.volumeRaw - a.volumeRaw,
      );
      const totalVol = formatMoney(
        sectionMap[type].reduce((s, m) => s + m.volumeRaw, 0),
      );
      groups.push({
        type,
        label: SECTION_LABELS[type] || type,
        volume: totalVol,
        markets: sorted,
      });
    }
  }
  // Append any unknown types at the end
  for (const [type, mkts] of Object.entries(sectionMap)) {
    if (!SECTION_ORDER.includes(type)) {
      groups.push({
        type,
        label: type.replace(/_/g, " "),
        volume: formatMoney(mkts.reduce((s, m) => s + m.volumeRaw, 0)),
        markets: mkts,
      });
    }
  }

  // Get match metadata — prefer names from question text (handles binary Yes/No markets)
  const { teamA: parsedA, teamB: parsedB } = extractTeamsFromQuestion(
    bestForNames?.question || "",
  );
  const teamOutcomes = parseOutcomes(moneylineMarket);
  const teamPrices = parseOutcomePrices(moneylineMarket);
  const isBinary =
    teamOutcomes.length === 2 &&
    ["yes", "no"].includes((teamOutcomes[0] || "").toLowerCase());

  const teamA = parsedA || (!isBinary ? teamOutcomes[0] : null) || null;
  const teamB =
    parsedB ||
    (!isBinary ? teamOutcomes[teamOutcomes.length - 1] : null) ||
    null;

  // For moneyline markets the raw outcomes give correct prices; for binary they don't
  const priceA = isBinary ? null : (teamPrices[0] ?? null);
  const priceB = isBinary ? null : (teamPrices[teamPrices.length - 1] ?? null);

  // Fetch match image, live score, and team badges in parallel
  const GENERIC_SOCCER_BALL = "soccer ball";
  const rawImage = moneylineMarket.image || moneylineMarket.icon || "";
  const matchImage = rawImage.toLowerCase().includes(GENERIC_SOCCER_BALL)
    ? null
    : rawImage || null;

  const gameStartTime = moneylineMarket.gameStartTime;

  // Fetch live score first so we can use Sofascore team IDs for logos
  const liveScore = await fetchLiveScore(
    slugPrefix,
    teamA,
    teamB,
    gameStartTime,
  );

  // Prefer Sofascore logos (faster CDN, no rate limits); fallback to TheSportsDB
  const sofascoreLogoUrl = (id) =>
    id ? `https://api.sofascore.app/api/v1/team/${id}/image` : null;

  const [teamAIcon, teamBIcon] = await Promise.all([
    liveScore?.homeTeamId
      ? Promise.resolve(sofascoreLogoUrl(liveScore.homeTeamId))
      : fetchTeamBadge(teamA),
    liveScore?.awayTeamId
      ? Promise.resolve(sofascoreLogoUrl(liveScore.awayTeamId))
      : fetchTeamBadge(teamB),
  ]);

  return response.success(res, {
    slugPrefix,
    teamA,
    teamB,
    teamAIcon,
    teamBIcon,
    matchImage,
    priceA,
    priceB,
    gameStartTime,
    liveScore, // { home, away, statusShort, statusLong, elapsed, homeTeamId, awayTeamId } or null
    league:
      detectSoccerLeague(moneylineMarket) ||
      detectSportsLeague(moneylineMarket),
    groups,
  });
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

  const searchRawKey = "gamma:search:raw";
  let markets = await getGammaCached(searchRawKey);
  if (!markets) {
    const response_data = await gammaApi.get("/markets", {
      params: {
        limit: 100,
        active: true,
        closed: false,
      },
    });
    markets = Array.isArray(response_data.data)
      ? response_data.data
      : response_data.data.markets || response_data.data.data || [];
    await setGammaCached(searchRawKey, markets, 30);
  }

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
  // Serve from cache if available (pre-warmed by 30s sync job)
  const cachedCategories = await getGammaCached("gamma:categories");
  if (cachedCategories) return response.success(res, cachedCategories);

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

  await setGammaCached("gamma:categories", categories, 60);
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

/**
 * POST /api/polymarket/sports/explain
 * Ask Kimi K2.5 to explain a sports betting contract in context.
 * Streams the response as SSE.
 */
const explainContract = asyncHandler(async (req, res) => {
  const {
    marketType,
    question,
    teamA,
    teamB,
    contractLabel,
    price,
    league,
    history = [],
    _onboarding = false,
  } = req.body;

  if (!question && !contractLabel) {
    return response.error(res, "question or contractLabel is required", 400);
  }

  const MOONSHOT_API_KEY = process.env.MOONSHOT_API_KEY;
  if (!MOONSHOT_API_KEY || MOONSHOT_API_KEY === "your-moonshot-api-key-here") {
    return response.error(res, "Kimi AI not configured", 503);
  }

  let messages;

  if (_onboarding) {
    // Onboarding mode: question IS the full prompt, no sports context needed
    const onboardingSystem = `You are a friendly, enthusiastic guide for Polygrid, a prediction market platform. 
Explain clearly in plain English. Use simple language. Format with short paragraphs separated by blank lines. 
No markdown headers — just clean readable text. Keep the full response under 250 words.`;
    messages =
      history.length > 0
        ? [
            { role: "system", content: onboardingSystem },
            ...history.map((m) => ({ role: m.role, content: m.content })),
          ]
        : [
            { role: "system", content: onboardingSystem },
            { role: "user", content: question },
          ];
  } else {
    // Sports contract explanation mode
    const systemPrompt = `You are a friendly sports betting guide for Polygrid, a prediction market platform.
Your job is to explain betting contracts to newcomers in plain English — short, clear, and conversational.
Always start with a one-line "plain English" summary, then give a brief breakdown.
Use the match context (teams, league, market type) to make the explanation specific, not generic.
Do NOT use jargon without explaining it. Keep answers under 120 words.`;

    const TYPE_DESCRIPTIONS = {
      moneyline:
        "A moneyline bet is simply: who wins this match? (or will there be a draw?)",
      spreads:
        "A spread bet adds a handicap (e.g. -1.5 goals) to level the playing field between teams.",
      totals:
        "A totals bet (Over/Under) asks: will the total goals scored be above or below a number?",
      both_teams_to_score:
        "Both Teams to Score (BTTS): will both teams score at least one goal?",
      soccer_exact_score:
        "An exact score bet: you're predicting the precise final scoreline.",
      soccer_halftime_result:
        "A halftime result bet: what will the score/situation be at half-time?",
      soccer_anytime_goalscorer:
        "An anytime goalscorer bet: will this player score at any point in the match?",
      corners:
        "A corners bet: predicting the total number of corner kicks in the match.",
    };

    const matchContext = [
      teamA && teamB ? `Match: ${teamA} vs ${teamB}` : null,
      league ? `League: ${league}` : null,
      marketType
        ? `Market type: ${marketType} — ${TYPE_DESCRIPTIONS[marketType] || marketType}`
        : null,
      question ? `Contract question: "${question}"` : null,
      contractLabel ? `Contract being traded: "${contractLabel}"` : null,
      price != null
        ? `Current price: ${Math.round(price * 100)}¢ (${Math.round(price * 100)}% probability)`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    const userMessage = `Please explain this contract to me:\n\n${matchContext}`;

    messages =
      history.length > 0
        ? [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
            { role: "assistant", content: "[context received]" },
            ...history.map((m) => ({ role: m.role, content: m.content })),
          ]
        : [
            { role: "system", content: systemPrompt },
            { role: "user", content: userMessage },
          ];
  }

  // Stream SSE to client
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    const kimiResponse = await fetch(
      "https://api.moonshot.ai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${MOONSHOT_API_KEY}`,
        },
        body: JSON.stringify({
          model: "moonshot-v1-8k",
          messages,
          stream: true,
          max_tokens: _onboarding ? 400 : 200,
        }),
      },
    );

    if (!kimiResponse.ok) {
      const err = await kimiResponse.text();
      res.write(
        `data: ${JSON.stringify({ error: "Kimi API error: " + err })}\n\n`,
      );
      res.end();
      return;
    }

    const reader = kimiResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop(); // keep incomplete line in buffer
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (trimmed.startsWith("data: ")) {
          res.write(trimmed + "\n\n");
        }
      }
    }

    res.write("data: [DONE]\n\n");
    res.end();
  } catch (err) {
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`);
    res.end();
  }
});

module.exports = {
  getMarkets,
  getTrendingMarkets,
  getLiveSportsMatches,
  getSportsMatch,
  explainContract,
  getMarketById,
  searchMarkets,
  getCategories,
  getTrades,
  getPriceHistory,
};
