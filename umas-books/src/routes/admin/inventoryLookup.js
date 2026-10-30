// JSON lookup for the one-screen "Add a book" page (public/scan-intake.js).
// Mounted BEFORE the inventory router: "lookup" is not a book id.
//
//   GET /admin/inventory/lookup?isbn=...
//   GET /admin/inventory/isbndb-price?isbn=...&condition=new   (the suggested publisher's price, asked after the lookup)
//
// Answers with what the catalog knows about the ISBN, the book and copies the
// shop already has, and the price suggestion for it: the page fills the form
// in place with that. Nothing here saves anything.

const express = require("express");
const config = require("../../lib/config");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { limit } = require("../../middleware/rateLimits");
const { normalizeIsbn, isValidIsbn, lookupByIsbnDetailed } = require("../../lib/bookLookup");
const { isbnVariants, bindingLabel } = require("../../lib/inventory");
const { prepareCover } = require("../../lib/coverStore");
const { computeSuggestion } = require("../../lib/pricing/forms");
const { serverTiming } = require("../../lib/timing");
const { getSettings } = require("../../lib/pricing/settings");
const { suggestPublisherPrice } = require("../../lib/isbndbPrice");
const { getAiLimits } = require("../../lib/aiLimits");

const router = express.Router();

// 120 a minute per person: a fast run of scans is about one a few seconds.
const lookupLimiter = limit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => `user-${req.session && req.session.user ? req.session.user.id : "anon"}`,
  handler: (req, res) => res.status(429).json({ error: "Too many lookups: wait a minute and try again." }),
  validate: { keyGeneratorIpFallback: false },
});

// Waits for `promise` at most `ms`, then answers `fallback` (the promise itself goes on running).
function within(promise, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(fallback), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

const isValidIsbnShape = (s) => /^(\d{13}|\d{9}[\dX])$/.test(s);

// GET /admin/inventory/lookup with no ?isbn= is the page of the no-JavaScript lookup
// (Post/Redirect/Get, in inventory.js): it is passed on. Only ?isbn= answers JSON here.
router.get("/admin/inventory/lookup", requireAdmin, (req, res, next) => (req.query.isbn === undefined ? next("router") : next()), serverTiming("scan.lookup"), lookupLimiter, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const isbn = normalizeIsbn(String(req.query.isbn == null ? "" : req.query.isbn).slice(0, 40));
  if (!isValidIsbnShape(isbn)) return res.status(400).json({ error: "Enter an ISBN of 10 or 13 digits." });
  // Right shape, wrong check digit: a typo or a made-up number. No catalog, no AI, nothing paid is asked.
  if (!isValidIsbn(isbn)) return res.status(400).json({ error: "That ISBN is not valid: check the digits." });

  // The shop's own record and the catalog do not depend on each other: asked together.
  const [stockedResult, catalog] = await Promise.all([
    req.timing.time("db", () => pool.query(
      `SELECT b.id, b.title, b.authors, b.publisher, b.published_year, b.description, b.cover_url, b.categories, b.binding,
              (SELECT count(*)::int FROM book_copies c WHERE c.book_id = b.id AND c.status IN ('in_stock', 'reserved')) AS copies
       FROM books b WHERE b.isbn = ANY($1) ORDER BY b.id LIMIT 1`,
      [isbnVariants(isbn)]
    )),
    req.timing.time("catalog", async () => {
      try {
        return await lookupByIsbnDetailed(isbn);
      } catch (err) {
        console.warn("ISBN lookup failed:", err.message);
        return { book: null, state: "error" };
      }
    }),
  ]);
  const stocked = stockedResult.rows[0] || null;
  const found = catalog.book;
  // A book the shop already has is shown as the shop has it; the catalog fills the gaps.
  const book = stocked
    ? {
        title: stocked.title, author: stocked.authors, publisher: stocked.publisher || (found && found.publisher) || null,
        publishedYear: stocked.published_year || (found && found.publishedYear) || null,
        description: stocked.description || (found && found.description) || null,
        coverUrl: stocked.cover_url || (found && found.coverUrl) || null,
        genre: stocked.categories || (found && found.genre) || null,
        binding: stocked.binding || (found && found.binding) || null,
      }
    : found && {
        title: found.title, author: found.author, publisher: found.publisher, publishedYear: found.publishedYear,
        description: found.description, coverUrl: found.coverUrl, genre: found.genre, binding: found.binding || null,
        coverOrigin: found.coverUrl ? "isbn" : null, // the catalog's cover for this exact ISBN (the record's own, or Open Library's by ISBN)
      };

  // The preview's cover and the price suggestion are independent too, and neither may hold the
  // answer back for long: each is given a budget (SCAN_COVER_WAIT_MS 1200, SCAN_PRICE_WAIT_MS 3000).
  //  - cover: the catalog gives an Open Library address, the preview uses our own copy
  //    (lib/coverStore.js). If the download is slower than the budget the preview has no cover;
  //    the download goes on and the save finds the finished copy.
  //  - price: the market check (PRICING_AI) can take many seconds the first time an ISBN is seen
  //    (the answer is then kept 30 days). Past the budget the price comes from the shop's rules alone;
  //    the check goes on and is stored, so the next price request for this ISBN uses it.
  const bindingKey = String(req.query.binding == null ? "" : req.query.binding).slice(0, 20) || (book && book.binding);
  const priceSource = { isbn, title: book && book.title, author: book && book.author, binding: bindingKey, condition: "very_good" };
  const coverTask = book && book.coverUrl && !book.coverUrl.startsWith("/")
    ? req.timing.time("cover", () => within(prepareCover(book.coverUrl).then((c) => c.cover || null, () => null), config.get("SCAN_COVER_WAIT_MS"), null))
    : null;
  const priceTask = req.timing.time("price", async () => {
    const full = computeSuggestion(priceSource);
    const quick = await within(full, config.get("SCAN_PRICE_WAIT_MS"), undefined);
    return quick !== undefined ? quick : computeSuggestion(priceSource, { opts: { market: false } });
  });
  const [cover, suggestion] = await Promise.all([coverTask, priceTask]);
  if (coverTask) book.coverUrl = cover;

  // The binding is only a hint (the page keeps the one entered last).
  const bindingHint = book && book.binding ? { key: book.binding, label: bindingLabel(book.binding, "en") || book.binding } : null;

  res.json({
    ok: true,
    isbn,
    found: Boolean(book),
    book: book ? { ...book, binding: undefined } : null,
    bindingHint,
    existing: stocked ? { bookId: stocked.id, title: stocked.title, copies: stocked.copies } : null,
    suggestion,
    // "slow": the catalog did not answer in time (fill in by hand, or scan again).
    catalog: catalog.state,
    // Set when this process had to skip an AI call today because the shared daily cap was reached (lib/aiLimits.js).
    aiNotice: getAiLimits().reachedToday().reached ? getAiLimits().reachedToday().message : undefined,
  });
});

// The SUGGESTED publisher's price (prix éditeur) of a New book, from ISBNdb's list price (lib/isbndbPrice.js).
// Asked by the page AFTER the title lookup, so it never slows a scan. Only for condition=new: for any other
// condition nothing is sent to ISBNdb. It saves nothing and the page never fills the field without a click.
router.get("/admin/inventory/isbndb-price", requireAdmin, serverTiming("scan.isbndbPrice"), lookupLimiter, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const isbn = normalizeIsbn(String(req.query.isbn == null ? "" : req.query.isbn).slice(0, 40));
  if (!isValidIsbnShape(isbn) || !isValidIsbn(isbn)) return res.status(400).json({ error: "That ISBN is not valid: check the digits." });
  if (String(req.query.condition || "") !== "new") return res.json({ ok: true, isbn, state: "not_new" });
  try {
    const { isbndbConfigured, isbnForms } = require("../../lib/bookSources");
    if (!isbndbConfigured()) return res.json({ ok: true, isbn, state: "off" });
    const rates = await getSettings(pool);
    const s = await suggestPublisherPrice(isbnForms(isbn).isbn13, rates);
    res.json({ ok: true, isbn, ...s });
  } catch (err) {
    console.warn("ISBNdb price suggestion failed:", err.message);
    res.json({ ok: true, isbn, state: "unavailable" });
  }
});

module.exports = router;
