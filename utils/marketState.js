const clampProbability = (value, fallback = 0.5) => {
  const num = Number(value);
  if (!Number.isFinite(num)) {
    return fallback;
  }

  return Math.max(0.001, Math.min(0.999, num));
};

const normalizeOutcomeKey = (value = "") =>
  String(value)
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "") || "OUTCOME";

const toFiniteNumber = (value, fallback = 0) => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const buildBinaryOutcomeStates = (market = {}) => [
  {
    key: "YES",
    label: "Yes",
    quantity: Math.max(0, toFiniteNumber(market.qYes, 0)),
    pool: Math.max(0, toFiniteNumber(market.yesPool, 0)),
    order: 0,
  },
  {
    key: "NO",
    label: "No",
    quantity: Math.max(0, toFiniteNumber(market.qNo, 0)),
    pool: Math.max(0, toFiniteNumber(market.noPool, 0)),
    order: 1,
  },
];

const normalizeOutcomeStates = (market = {}) => {
  const source = Array.isArray(market.outcomeStates)
    ? market.outcomeStates
    : [];

  if (source.length === 0) {
    return buildBinaryOutcomeStates(market);
  }

  return source
    .map((state, index) => {
      const key = normalizeOutcomeKey(
        state?.key || state?.label || `OUTCOME_${index + 1}`,
      );
      return {
        key,
        label: String(state?.label || key),
        quantity: Math.max(0, toFiniteNumber(state?.quantity, 0)),
        pool: Math.max(0, toFiniteNumber(state?.pool, 0)),
        order: toFiniteNumber(state?.order, index),
      };
    })
    .filter((state, index, list) => {
      return (
        state.key && list.findIndex((item) => item.key === state.key) === index
      );
    })
    .sort((left, right) => left.order - right.order);
};

const getOutcomeStateMap = (market = {}) => {
  return normalizeOutcomeStates(market).reduce((accumulator, state) => {
    accumulator[state.key] = state;
    return accumulator;
  }, {});
};

const buildCompatibilityFields = (
  market = {},
  outcomeStates = normalizeOutcomeStates(market),
) => {
  const stateMap = outcomeStates.reduce((accumulator, state) => {
    accumulator[state.key] = state;
    return accumulator;
  }, {});

  return {
    qYes: stateMap.YES?.quantity ?? Math.max(0, toFiniteNumber(market.qYes, 0)),
    qNo: stateMap.NO?.quantity ?? Math.max(0, toFiniteNumber(market.qNo, 0)),
    yesPool:
      stateMap.YES?.pool ?? Math.max(0, toFiniteNumber(market.yesPool, 0)),
    noPool: stateMap.NO?.pool ?? Math.max(0, toFiniteNumber(market.noPool, 0)),
  };
};

const buildOutcomeStatesFromProbabilities = ({
  outcomes = [],
  probabilities = [],
  liquidity = 0,
  b = 100,
}) => {
  const labels = Array.isArray(outcomes) ? outcomes : [];
  const rawProbabilities = Array.isArray(probabilities) ? probabilities : [];

  const seeded = labels.map((label, index) => ({
    key: normalizeOutcomeKey(label || `Outcome ${index + 1}`),
    label: String(label || `Outcome ${index + 1}`),
    probability: clampProbability(
      rawProbabilities[index],
      1 / Math.max(labels.length, 1),
    ),
    order: index,
  }));

  if (seeded.length === 0) {
    return buildBinaryOutcomeStates();
  }

  const probabilitySum =
    seeded.reduce((sum, item) => sum + item.probability, 0) || 1;
  const normalized = seeded.map((item) => ({
    ...item,
    probability: clampProbability(
      item.probability / probabilitySum,
      1 / seeded.length,
    ),
  }));
  const minProbability = Math.min(
    ...normalized.map((item) => item.probability),
  );

  return normalized.map((item) => ({
    key: item.key,
    label: item.label,
    quantity: Math.max(0, b * Math.log(item.probability / minProbability)),
    pool: Math.max(0, toFiniteNumber(liquidity, 0) * item.probability),
    order: item.order,
  }));
};

module.exports = {
  buildBinaryOutcomeStates,
  buildCompatibilityFields,
  buildOutcomeStatesFromProbabilities,
  clampProbability,
  getOutcomeStateMap,
  normalizeOutcomeKey,
  normalizeOutcomeStates,
  toFiniteNumber,
};
