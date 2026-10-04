// Price suggestion for a copy at intake: finds what the book is worth online
// (the optional AI market check, cached) and applies the shop's rules (see
// rules.js for the rule sets). A suggestion is only ever a suggestion:
// nothing here saves or publishes a price. The copy's condition does not
// change the price; it is only used to spot NEW books (publisher's price).
//
// suggestPrice() never throws.

const { DEFAULT_SETTINGS, suggestFromRules, eur } = require("./rules");
const { getSettings } = require("./settings");
const { lookupMarket } = require("./market");
const { toIsbn13 } = require("./isbn");

const OVERALL_TIMEOUT_MS = 12000;
const BINDING_NAMES = { hardcover: "hardcover", paperback: "paperback", mass_market: "mass market paperback" };

function summaryLabel(s) {
  if (!s) return "";
  // A new book is never given a used-book level: it sells at the publisher's price.
  if (s.ruleSet === "new") {
    return "New book: sell at the publisher's price (max 5% off)." + (s.price == null ? " Enter the publisher's price (prix éditeur) first." : "");
  }
  if (s.price == null) {
    return s.needsReview ? s.reviewMessage : "No suggestion yet: enter the publisher's price (prix éditeur) first.";
  }
  if (s.level === "clearance") return `Suggested: Clearance ${eur(s.price)}`;
  return `Suggested ${eur(s.price)} (range ${Number(s.low).toFixed(2)}-${Number(s.high).toFixed(2)}, ${s.confidence} confidence)`;
}

function marketSentence(r, comparables, settings, binding) {
  const m = eur(r.marketEur);
  switch (r.referenceSource) {
    case "median": {
      const sites = [...new Set(comparables.map((c) => c.site))].slice(0, 4).join(", ");
      const dropped = r.comparablesDropped ? ` ${r.comparablesDropped} unusually high or low listing${r.comparablesDropped > 1 ? "s were" : " was"} ignored.` : "";
      return `Based on ${r.comparablesUsed} used listings (${sites}), the market value is about ${m}.${dropped}`;
    }
    case "single": {
      const c = comparables[0];
      return `Based on one used listing (${c ? c.site : "online"}), the market value is about ${m}. One listing is not much to go on.`;
    }
    case "original":
      return `We know the publisher's price but found no used listings. Used copies usually sell for about ${Math.round(settings.usedFraction * 100)}% of it, so the market value is about ${m}.`;
    case "fallback":
      return `We found no price information, so we used a typical value for a ${BINDING_NAMES[binding] || "book of unknown binding"}: about ${m}.`;
    default:
      return `The market value is about ${m}.`;
  }
}

function ruleSentence(r, settings) {
  const c = settings.clearance;
  switch (r.ruleSet) {
    case "A":
      return `Rule A (popular books, plenty of supply): market value under ${eur(settings.aMax)} (this includes ${eur(5)} to ${eur(settings.aMax - 0.01)}), so the price is ${eur(settings.aPrice)}.`;
    case "B":
      return `Rule B (mid-range standard stock): market value from ${eur(settings.aMax)} to ${eur(settings.bMax - 0.01)}, so the price is ${eur(settings.bPrice)}.`;
    case "C":
      return `Rule C (high value and collectible): market value about ${eur(r.marketEur)} -> ${Math.round(settings.cFactor * 100)}% = ${eur(r.price)}.`;
    case "clearance":
      return `Clearance rule: the shop already holds ${c.afterCopies} or more copies of this book, so this copy goes to the clearance bin at ${eur(c.price)}. Without it, the price would be ${eur(r.normal.price)}.`;
    case "mass_market":
      return `Mass market paperbacks are priced at ${eur(settings.massMarketPrice)}.`;
    default:
      return "";
  }
}

function rationaleFor(r, { comparables, settings, binding, copyNumber }) {
  if (r.ruleSet === "new") {
    return [`New books are sold at the publisher's price, ${eur(r.price)} (French fixed book price law; up to 5% off is allowed).`];
  }
  if (r.ruleSet === "review") {
    return [
      r.reviewMessage + ".",
      r.marketEur == null
        ? "Without an ISBN we cannot check the book's value online. Look it up yourself and choose a price."
        : `${marketSentence(r, comparables, settings, binding)} Books worth ${eur(settings.cMax)} or more are valuable: check the listings and set the price yourself.`,
    ];
  }
  const out = r.marketEur == null ? [] : [marketSentence(r, comparables, settings, binding)];
  if (r.ruleSet === "clearance") {
    out.unshift(`This is copy no. ${copyNumber} of this book in stock, so it is on clearance.`);
  }
  out.push(ruleSentence(r, settings));
  if (r.floorApplied) out.push(`Hardcover: minimum price ${eur(settings.hardcoverMinPrice)}, so the price is raised to ${eur(r.price)}.`);
  out.push("The copy's condition does not change the price.");
  return out;
}

function shape(r, ctx) {
  if (!r) {
    // New copy without a publisher price.
    const s = {
      price: null, low: null, high: null, level: null, ruleSet: "new", basis: "publisher", confidence: "low",
      needsReview: false, reviewMessage: null, clearance: false, marketEur: null,
      rationale: ["New books must be sold at the publisher's price (French fixed book price law). Enter the publisher's price (prix éditeur) to see the price."],
      comparables: [],
    };
    return { ...s, label: summaryLabel(s) };
  }
  const s = {
    ...r,
    rationale: rationaleFor(r, ctx),
    comparables: ctx.comparables.map((c) => ({ site: c.site, url: c.url, price: c.price, condition: c.condition || null })),
  };
  return { ...s, label: summaryLabel(s) };
}

// suggestPrice(pool, { isbn, title, author, binding, condition, publisherPrice, existingCopies }, opts)
// Options (mostly for tests): settings, market:false (skip the AI check),
// fetchImpl, env, now. existingCopies: copies of this book the shop already
// holds (in stock + reserved), for the clearance rule.
async function suggestPrice(pool, input = {}, opts = {}) {
  try {
    const settings = opts.settings || (await getSettings(pool));
    const isNew = input.condition === "new";
    let market = null;
    // Mass market books have one price whatever they are worth, so no lookup is needed.
    if (!isNew && input.binding !== "mass_market" && toIsbn13(input.isbn) && opts.market !== false) {
      market = await lookupMarket(pool, input, { fetchImpl: opts.fetchImpl, env: opts.env, settings, now: opts.now });
    }
    const comparables = market ? market.comparables : [];
    const r = suggestFromRules({
      condition: input.condition, binding: input.binding, isbn: input.isbn, publisherPrice: input.publisherPrice,
      comparables: comparables.map((c) => c.price), originalPrice: market ? market.originalPrice : null,
      existingCopies: input.existingCopies, settings,
    });
    const held = Number.isInteger(input.existingCopies) ? input.existingCopies : 0;
    return shape(r, { comparables, settings, binding: input.binding, copyNumber: held + 1 });
  } catch (err) {
    console.warn("Price suggestion fell back to the built-in rules:", err.message);
    try {
      const r = suggestFromRules({ ...input, settings: DEFAULT_SETTINGS, comparables: [], originalPrice: null });
      return shape(r, { comparables: [], settings: DEFAULT_SETTINGS, binding: input.binding, copyNumber: 1 });
    } catch {
      return { price: null, low: null, high: null, level: "review", ruleSet: "review", basis: "rules", confidence: "low", needsReview: true, reviewMessage: "Manual review: price check unavailable", clearance: false, rationale: [], comparables: [], label: "Manual review: price check unavailable" };
    }
  }
}

// For page renders: waits for the market check at most ~12 s, then answers
// from the rules alone.
async function suggestPriceWithTimeout(pool, input, opts = {}, ms = OVERALL_TIMEOUT_MS) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
    if (timer.unref) timer.unref();
  });
  try {
    const result = await Promise.race([suggestPrice(pool, input, opts), timeout]);
    return result || suggestPrice(pool, input, { ...opts, market: false });
  } finally {
    clearTimeout(timer);
  }
}

// Short name of the rule that fired, for the calculator and the review page.
function ruleName(r) {
  if (!r) return "New book: publisher's price needed";
  const names = {
    new: "New book: publisher's price", review: r.reviewMessage || "Manual review", clearance: "Clearance",
    mass_market: "Mass market price", A: "Rule A", B: "Rule B", C: "Rule C",
  };
  return (names[r.ruleSet] || r.ruleSet) + (r.floorApplied ? " + hardcover minimum" : "");
}

module.exports = { suggestPrice, suggestPriceWithTimeout, summaryLabel, ruleName };
