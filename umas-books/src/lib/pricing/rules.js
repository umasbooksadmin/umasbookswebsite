// Pricing rules engine: pure functions, no network and no database, so it is
// fully unit-tested and can always answer instantly.
//
// The price of a used book depends on what the book is worth online (its
// typical USED price in euros, "M"), its binding and how many copies the shop
// already holds (N): NEVER on the copy's condition. First match wins:
//
//   1. condition new                          -> the publisher's price (loi Lang)
//   2. no ISBN                                -> manual review: no price suggested
//   3. not mass market / trade and M >= c_max (50)
//                                             -> manual review: no price suggested
//   4. clearance: N >= 2 and the book is Set A (mass market, trade, or M < a_max)
//                                             -> EUR 1
//   5. mass market                            -> EUR 5, whatever M is
//      trade                                  -> EUR 5, whatever M is
//   6. Set A  M < a_max (6)                   -> EUR 5
//      Set B  M < b_max (20)                  -> EUR 10
//      Set C  M < c_max (50)                  -> M x 0.75, rounded to the nearest 0.50
//
// The standard price levels are 3, 5 and 10 (EUR 8 was retired): Rule B's
// price (b_price) is therefore 10, the nearest remaining level above 8.
//   7. hardcover floor: a hardcover below EUR 10 is raised to EUR 10
//
// A suggestion is only ever a suggestion: a volunteer accepts or changes it.

const { toIsbn13 } = require("./isbn");

const DEFAULT_SETTINGS = Object.freeze({
  // Standard prices a volunteer can pick by hand (besides clearance and custom).
  levels: Object.freeze([3, 5, 10]),
  massMarketPrice: 5,
  tradePrice: 5,
  aMax: 6, aPrice: 5,
  bMax: 20, bPrice: 10,
  cMax: 50, cFactor: 0.75,
  hardcoverMinPrice: 10,
  hardcoverMinAppliesToClearance: false, // true: a hardcover on clearance is raised to the minimum too
  usedFraction: 0.35, // used value as a share of the publisher's price, when only that is known
  roundingStep: 0.5,
  // Typical used value, in EUR, when nothing at all is known about the book.
  fallbackEur: Object.freeze({ hardcover: 12, trade: 5, mass_market: 5, unknown: 5 }),
  usdEur: 0.92, // 1 USD in EUR (to convert US listings)
  gbpEur: 1.15, // 1 GBP in EUR (to convert UK listings)
  // Clearance: once a book already has `afterCopies` copies in stock (in stock
  // + reserved), each further copy is a clearance copy at `price` (scope
  // 'extra'), or all its copies are (scope 'all'). appliesTo: 'set_a' = Rule A
  // and mass market books only, 'all_sets' = every rule. Never for new books.
  clearance: Object.freeze({ afterCopies: 2, price: 1, scope: "extra", appliesTo: "set_a" }),
});

const cents = (n) => Math.round(n * 100) / 100;
const eur = (n) => `EUR ${Number(n).toFixed(2)}`;

function isNewCondition(condition) {
  return condition === "new";
}

function positive(n) {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

function median(values) {
  const v = [...values].sort((a, b) => a - b);
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
}

function roundToStep(value, settings) {
  const step = settings.roundingStep > 0 ? settings.roundingStep : 0.5;
  return cents(Math.round(value / step) * step);
}

// M in EUR, and where it came from. With 4+ comparables (EUR prices), ones
// above 3x or below a third of the median are dropped first; the listings' own
// conditions are deliberately ignored. `marketEur` (a number) skips all of it.
function referenceFrom({ marketEur, comparables, originalPrice, binding, settings }) {
  const given = Number(marketEur);
  if (marketEur != null && Number.isFinite(given) && given >= 0) {
    return { valueEur: cents(given), source: "given", used: 0, dropped: 0, confidence: "medium" };
  }
  const prices = (Array.isArray(comparables) ? comparables : []).map(positive).filter((p) => p != null);
  let kept = prices;
  if (prices.length >= 4) {
    const m = median(prices);
    kept = prices.filter((p) => p <= 3 * m && p >= m / 3);
  }
  const dropped = prices.length - kept.length;
  if (kept.length >= 2) {
    return { valueEur: cents(median(kept)), source: "median", used: kept.length, dropped, confidence: kept.length >= 4 ? "high" : "medium" };
  }
  if (kept.length === 1) {
    return { valueEur: cents(kept[0]), source: "single", used: 1, dropped, confidence: "medium" };
  }
  const original = positive(originalPrice);
  if (original) {
    return { valueEur: cents(original * settings.usedFraction), source: "original", used: 0, dropped: 0, confidence: "medium" };
  }
  const known = ["hardcover", "trade", "mass_market"].includes(binding);
  return { valueEur: settings.fallbackEur[known ? binding : "unknown"], source: "fallback", used: 0, dropped: 0, confidence: "low" };
}

// Range shown next to a suggestion: the neighbouring standard prices; a custom
// price (Rule C) gets +-20%.
function neighbours(price, settings) {
  const all = [...settings.levels, settings.clearance.price, price].sort((a, b) => a - b);
  const lower = all.filter((l) => l < price);
  const higher = all.filter((l) => l > price);
  return { low: lower.length ? lower[lower.length - 1] : price, high: higher.length ? higher[0] : price };
}

// suggestFromRules({ condition, binding, isbn, comparables, originalPrice, publisherPrice,
//                    marketEur, existingCopies, settings })
//   comparables: used-listing prices in EUR (any condition: not adjusted)
//   originalPrice: the book's publisher/cover price in EUR, when known
//   marketEur: M directly in EUR (calculator and tests), instead of the above
//   existingCopies: N, copies of this book already in stock (in stock + reserved)
// -> { price, level, ruleSet, basis, confidence, low, high, marketEur,
//      referenceSource, comparablesUsed, comparablesDropped, needsReview,
//      reviewMessage, clearance, floorApplied, normal } or null: a NEW copy
//      with no publisher price.
//   ruleSet: 'new' | 'review' | 'clearance' | 'mass_market' | 'trade' | 'A' | 'B' | 'C'
//   level: number (a standard price) | 'custom' (Rule C) | 'clearance' | 'review' | null (new)
//   basis: 'publisher' | 'clearance' | 'market' (listings found) | 'rules' (estimated)
//   price is null for 'review'. `normal` (clearance only) is the price without clearance.
function suggestFromRules({ condition, binding, isbn, comparables, originalPrice, publisherPrice, marketEur, existingCopies, settings } = {}) {
  const s = settings || DEFAULT_SETTINGS;
  const blank = {
    comparablesUsed: 0, comparablesDropped: 0, referenceSource: null, marketEur: null,
    needsReview: false, reviewMessage: null, clearance: false, floorApplied: false, normal: null,
  };

  // 1. New books: the publisher's price.
  if (isNewCondition(condition)) {
    const pub = positive(publisherPrice);
    if (!pub) return null;
    const price = cents(pub);
    return {
      ...blank, price, level: null, ruleSet: "new", basis: "publisher", confidence: "high",
      low: cents(Math.ceil(pub * 95) / 100), high: price, referenceSource: "publisher",
    };
  }

  // 2. No ISBN: a person decides.
  if (!toIsbn13(isbn)) {
    return {
      ...blank, price: null, level: "review", ruleSet: "review", basis: "rules", confidence: "low", low: null, high: null,
      needsReview: true, reviewMessage: "Manual review: no ISBN barcode",
    };
  }

  const held = Number.isInteger(existingCopies) ? existingCopies : 0;
  const clearanceDue = (isSetA) => held >= s.clearance.afterCopies && (isSetA || s.clearance.appliesTo === "all_sets");
  const clearanceResult = (info, confidence, normal) => {
    const floor = binding === "hardcover" && s.hardcoverMinAppliesToClearance ? s.hardcoverMinPrice : 0;
    const price = cents(Math.max(s.clearance.price, floor));
    return {
      ...info, price, level: "clearance", ruleSet: "clearance", basis: "clearance", confidence, low: price, high: price,
      clearance: true, normal,
    };
  };

  // Mass market and trade: one flat price each, whatever the book is worth online.
  const isMassMarket = binding === "mass_market";
  const isFlat = isMassMarket || binding === "trade";
  let info = blank;
  let ref = null;
  let ruleSet;
  let ruled;

  if (isFlat) {
    // Mass market and trade: one price whatever the book is worth online (so no market value is needed).
    ruleSet = isMassMarket ? "mass_market" : "trade";
    ruled = cents(isMassMarket ? s.massMarketPrice : s.tradePrice);
  } else {
    ref = referenceFrom({ marketEur, comparables, originalPrice, binding, settings: s });
    const m = ref.valueEur;
    info = {
      ...blank, referenceSource: ref.source, marketEur: m, comparablesUsed: ref.used, comparablesDropped: ref.dropped,
    };
    const basis = ref.source === "median" || ref.source === "single" || ref.source === "given" ? "market" : "rules";

    // 3. Valuable books: a person decides.
    if (m >= s.cMax) {
      return {
        ...info, price: null, level: "review", ruleSet: "review", basis, confidence: ref.confidence, low: null, high: null,
        needsReview: true, reviewMessage: `Manual review: online value ${eur(s.cMax)} or more`,
      };
    }
    ruleSet = m < s.aMax ? "A" : m < s.bMax ? "B" : "C";
    ruled = ruleSet === "A" ? s.aPrice : ruleSet === "B" ? s.bPrice : roundToStep(m * s.cFactor, s);
  }

  // 7 (computed first so clearance can report the usual price). Hardcover floor.
  const floorApplied = binding === "hardcover" && ruled < s.hardcoverMinPrice;
  const price = floorApplied ? cents(s.hardcoverMinPrice) : cents(ruled);
  const level = ruleSet === "C" && !floorApplied ? "custom" : price;

  // 4. Clearance (Rule A and mass market books, or every rule when set so).
  if (clearanceDue(isFlat || ruleSet === "A")) {
    return clearanceResult(info, ref ? ref.confidence : "high", { ruleSet, price, level });
  }

  const basis = ref ? (ref.source === "median" || ref.source === "single" || ref.source === "given" ? "market" : "rules") : "rules";
  const range = ruleSet === "C" && !floorApplied
    ? { low: roundToStep(price * 0.8, s), high: roundToStep(price * 1.2, s) }
    : neighbours(price, s);
  return { ...info, price, level, ruleSet, basis, confidence: ref ? ref.confidence : "high", floorApplied, ...range };
}

module.exports = {
  DEFAULT_SETTINGS, isNewCondition, median, roundToStep, referenceFrom, suggestFromRules, eur,
};
