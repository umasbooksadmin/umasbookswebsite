// Glue between the admin screens and the pricing library: turns what a form
// or query string carries into a suggestion (counting the copies already in
// stock for the clearance rule), and loads what the price controls need.

const { pool: defaultPool } = require("../../db");
const { normalizeIsbn } = require("../bookLookup");
const { normalizeCondition } = require("../inventory");
const { suggestPriceWithTimeout } = require("./index");
const { getSettings } = require("./settings");
const { countHeldCopies, otherRepriceableCopies } = require("./clearance");
const { levelText, levelKeyFor } = require("./intake");

const BINDINGS = new Set(["hardcover", "paperback", "mass_market"]);
const pricingBinding = (v) => (BINDINGS.has(v) ? v : null);

// What the price controls in the views need from the settings.
async function priceUi(pool = defaultPool) {
  const s = await getSettings(pool);
  return {
    levels: s.levels, clearancePrice: s.clearance.price, clearanceScope: s.clearance.scope, afterCopies: s.clearance.afterCopies,
    // Which radio of the price control a price belongs to: a standard price, clearance or custom.
    keyFor: (price, isClearance) => levelKeyFor(price, isClearance, s.levels),
  };
}

// src: { isbn, title, author, binding, condition, publisherPrice } (strings
// from a form or query). copyId: when pricing an existing copy, so only the
// copies before it count toward clearance. Never throws.
async function computeSuggestion(src, { copyId = null, pool = defaultPool, opts = {} } = {}) {
  const isbn = src.isbn ? normalizeIsbn(String(src.isbn)) : null;
  const input = {
    isbn,
    title: src.title || null,
    author: src.author || null,
    binding: pricingBinding(src.binding),
    condition: normalizeCondition(src.condition),
    publisherPrice: src.publisherPrice,
    existingCopies: 0,
  };
  try {
    input.existingCopies = await countHeldCopies(pool, { isbn, copyId });
  } catch (err) {
    console.warn("Copy count for clearance failed:", err.message);
  }
  const suggestion = await suggestPriceWithTimeout(pool, input, opts);
  return { ...suggestion, levelText: levelText(suggestion) };
}

// For the add-book form: puts the suggestion and the price-control settings
// where the view finds them (res.locals, so the render calls stay as they
// are) and, when clearance would also reprice the other copies, lists them.
async function prepareIntakeForm(res, src, { pool = defaultPool } = {}) {
  const [suggestion, ui, settings] = await Promise.all([computeSuggestion(src, { pool }), priceUi(pool), getSettings(pool)]);
  res.locals.priceSuggestion = suggestion;
  res.locals.priceUi = ui;
  res.locals.clearanceOthers = settings.clearance.scope === "all" && suggestion.clearance
    ? await otherRepriceableCopies(pool, normalizeIsbn(String(src.isbn || "")))
    : [];
  return suggestion;
}

module.exports = { pricingBinding, priceUi, computeSuggestion, prepareIntakeForm };
