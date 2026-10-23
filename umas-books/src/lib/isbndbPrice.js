// A SUGGESTED publisher's price (prix éditeur) for a NEW book, from ISBNdb's list price. Admin screens only.
//
// What ISBNdb's book endpoint (GET https://api2.isbndb.com/book/{isbn13}) returns about price, as checked on
// 2026-10-19 (see the PR description; the live docs page needs a browser, so this comes from the published
// OpenAPI spec and the client libraries that track it):
//   - `msrp`: "Manufacturer's suggested retail price", a nullable number with NO currency in the response. The
//     current client documentation marks it deprecated and says it is a USD list price.
//   - `list_price` / `listPrice`: the newer replacement, an object { amount, currency } ("ISO 4217 currency code",
//     amount rounded to two decimals). We could not read its exact JSON key name from an official page, so BOTH
//     spellings are accepted; it is used first, `msrp` (as USD) is the fallback.
//   - `prices`: live merchant offers, only with ?with_prices=true on the Pro plan and slower. NOT used: a merchant's
//     sale price is not the publisher's price.
// A missing, zero, negative or non-numeric price, or a currency that is not EUR/USD/GBP, counts as "no price".
//
// Never saved by itself. The Add Book page shows the suggestion with a "Use this price" button; the maintainer
// checks it against the price printed on the book (French fixed book price law) and presses the button.
//
// Cost control: one paid request per ISBN per PRICE_TTL (3 days; results of "no price" included), concurrent asks
// share one request, it is skipped while ISBNdb is paused (401/403/429, see bookSources.js), and it is only ever
// asked for a New book. The cache is in memory (it resets when the site restarts, which costs at most one call per ISBN).

const config = require("./config");
const { createInflight } = require("./inflight");

const PRICE_TTL_MS = config.specFor("ISBNDB_PRICE_TTL_MS").default;
// Rounding rule: to the nearest 0.05 EUR. French publisher prices are almost always multiples of 5 cents
// (12.90, 8.95, 9.50), so this lands on a plausible shelf price; it is only a suggestion to check against the cover.
const ROUND_STEP_CENTS = 5;
const SUPPORTED = ["EUR", "USD", "GBP"];

const cache = new Map(); // isbn13 -> { value, expires }
const inflight = createInflight();
function cacheGet(isbn, now) {
  const hit = cache.get(isbn);
  if (!hit) return undefined;
  if (hit.expires <= now) { cache.delete(isbn); return undefined; }
  return hit.value;
}
function cacheSet(isbn, value, now, ttl = priceTtl()) {
  if (cache.size >= 2000) cache.delete(cache.keys().next().value);
  cache.set(isbn, { value, expires: now + ttl });
}
function priceTtl() {
  return config.get("ISBNDB_PRICE_TTL_MS");
}
function clearPriceCache() { cache.clear(); }

// { amount, currency } from an ISBNdb book object, or null when it carries no usable price.
function extractListPrice(book) {
  if (!book || typeof book !== "object") return null;
  const lp = book.list_price || book.listPrice;
  if (lp && typeof lp === "object") {
    const amount = Number(lp.amount);
    const currency = String(lp.currency == null ? "" : lp.currency).trim().toUpperCase();
    if (Number.isFinite(amount) && amount > 0 && /^[A-Z]{3}$/.test(currency)) return { amount: Math.round(amount * 100) / 100, currency };
    return null;
  }
  const msrp = typeof book.msrp === "string" ? Number(book.msrp.replace(",", ".")) : book.msrp;
  if (typeof msrp === "number" || typeof msrp === "string") {
    const n = Number(msrp);
    if (Number.isFinite(n) && n > 0) return { amount: Math.round(n * 100) / 100, currency: "USD" }; // msrp is documented as USD
  }
  return null;
}

// Converts to euros with the shop's own rates (Pricing settings: "1 US dollar in euros", "1 British pound in euros",
// approximate and editable) and rounds to the nearest 0.05. Returns { eur, rate } or null (unsupported currency).
function convertToEur(amount, currency, rates) {
  const cur = String(currency || "").toUpperCase();
  if (!(Number.isFinite(amount) && amount > 0) || !SUPPORTED.includes(cur)) return null;
  const rate = cur === "EUR" ? 1 : cur === "USD" ? Number(rates && rates.usdEur) : Number(rates && rates.gbpEur);
  if (!(rate > 0)) return null;
  const cents = Math.round((amount * rate * 100) / ROUND_STEP_CENTS) * ROUND_STEP_CENTS;
  return cents > 0 ? { eur: cents / 100, rate } : null;
}

// Remembers what a book answer says about the price (called by the title fallback in bookSources.js too).
function remember(isbn13, book, now = Date.now()) {
  if (!isbn13 || !book || typeof book !== "object") return;
  const p = extractListPrice(book);
  cacheSet(isbn13, p ? { state: "ok", ...p } : { state: "none" }, now);
}

// Asks ISBNdb (or the cache) for the list price of one ISBN-13.
// Resolves { state: "ok", amount, currency, cached? } | { state: "none" } (no usable price) | { state: "off" } (no key)
// | { state: "unavailable" } (paused, failed, slow) | { state: "limit" } (ISBNDB_DAILY_MAX_CALLS reached today). Never rejects. opts: fetchImpl, env, now, sleep, stats, timeoutMs.
async function lookupListPrice(isbn13, opts = {}) {
  const sources = require("./bookSources");
  const env = opts.env || process.env;
  if (!sources.isbndbConfigured(env)) return { state: "off" };
  const now = opts.now || Date.now;
  const hit = cacheGet(isbn13, now());
  if (hit) return { ...hit, cached: true };
  return inflight.run(isbn13, async () => {
    const controller = new AbortController();
    const timeoutMs = opts.timeoutMs || config.get("ISBNDB_PRICE_TIMEOUT_MS", env);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const r = await sources.isbndbRequest({
        forms: sources.isbnForms(isbn13), fetchImpl: opts.fetchImpl || ((...a) => fetch(...a)), signal: controller.signal,
        stats: opts.stats, env, now: opts.now, sleep: opts.sleep,
      });
      if (r.state === "missing") { const v = { state: "none" }; cacheSet(isbn13, v, now()); return v; }
      if (r.capped) return { state: "limit" }; // today's paid-call cap is used up (not cached)
      if (r.state !== "ok") return { state: "unavailable" }; // paused, refused, over quota, timed out: not cached
      const book = r.data && r.data.book;
      remember(isbn13, book, now());
      const p = extractListPrice(book);
      return p ? { state: "ok", ...p } : { state: "none" };
    } catch {
      return { state: "unavailable" };
    } finally {
      clearTimeout(timer);
    }
  });
}

// What the Add Book page needs: the original price and the converted, rounded suggestion.
// { state: "price", original: { amount, currency }, eur, rate, approximate } | { state: "none" | "off" | "unavailable" | "limit" }
async function suggestPublisherPrice(isbn13, rates, opts = {}) {
  const r = await lookupListPrice(isbn13, opts);
  if (r.state !== "ok") return { state: r.state };
  const conv = convertToEur(r.amount, r.currency, rates);
  if (!conv) return { state: "none" };
  return { state: "price", original: { amount: r.amount, currency: r.currency }, eur: conv.eur, rate: conv.rate, approximate: r.currency !== "EUR" };
}

module.exports = { PRICE_TTL_MS, ROUND_STEP_CENTS, SUPPORTED, extractListPrice, convertToEur, remember, lookupListPrice, suggestPublisherPrice, clearPriceCache };
