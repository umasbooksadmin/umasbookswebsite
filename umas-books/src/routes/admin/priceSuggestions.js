// Price suggestions on the inventory forms (see lib/pricing). Mounted BEFORE
// the inventory router: "price-suggestion" and "suggest" would otherwise be
// read as a book id.
//
//   GET  /admin/inventory/price-suggestion   JSON for public/price-suggestion.js
//   POST /admin/inventory/suggest            no-JavaScript "Suggest price" on the add-book form
//
// A suggestion is only shown: nothing here saves a price.

const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { limit } = require("../../middleware/rateLimits");
const inventoryLib = require("../../lib/inventory");
const { normalizeIsbn } = require("../../lib/bookLookup");
const { parseId, parseMoney } = require("../../lib/validation");
const { setFlash, takeFlash } = require("../../lib/flash");
const { computeSuggestion, prepareIntakeForm, pricingBinding } = require("../../lib/pricing/forms");

const { CONDITIONS, STATUSES, SOURCES, normalizeSource, normalizeCondition, normalizeGenres, normalizeLocation } = inventoryLib;

const router = express.Router();

// 30 a minute per person: a lookup can cost an AI call.
const suggestionLimiter = limit({
  windowMs: 60 * 1000,
  max: 30,
  keyGenerator: (req) => `user-${req.session && req.session.user ? req.session.user.id : "anon"}`,
  handler: (req, res) => res.status(429).json({ error: "Too many price checks: wait a minute and try again." }),
  validate: { keyGeneratorIpFallback: false },
});

router.get("/admin/inventory/price-suggestion", requireAdmin, suggestionLimiter, async (req, res) => {
  const q = (name, max = 200) => String(req.query[name] == null ? "" : req.query[name]).trim().slice(0, max);
  const copyId = parseId(q("copyId", 12));
  let src = { isbn: q("isbn", 30), title: q("title"), author: q("author"), binding: q("binding", 20), condition: q("condition", 20), publisherPrice: q("publisherPrice", 20) };
  if (copyId !== null) {
    // Pricing an existing copy: the book comes from the copy, and only the copies before it count toward clearance.
    const { rows } = await pool.query(
      `SELECT b.isbn, b.title, b.authors, b.binding
       FROM book_copies c JOIN books b ON b.id = c.book_id WHERE c.id = $1`, [copyId]
    );
    if (rows.length) src = { ...src, isbn: rows[0].isbn || "", title: rows[0].title, author: rows[0].authors, binding: src.binding || rows[0].binding };
  }
  const suggestion = await computeSuggestion(src, { copyId });
  res.set("Cache-Control", "no-store");
  res.json(suggestion);
});

// The add-book form shown again with everything typed so far (a refused save,
// or the no-JavaScript "Suggest price"). The POSTs redirect here (Post/Redirect/
// Get) and carry what to show once in the session: flash.prep is what the price
// suggestion is worked out from, the rest is display only. (A chosen cover photo
// has to be picked again.)
router.get("/admin/inventory/new/again", requireAdmin, async (req, res) => {
  const f = takeFlash(req, "intake");
  if (!f || !f.book) return res.redirect("/admin/inventory/new");
  const suggestion = await prepareIntakeForm(res, f.prep || {});
  if (f.priceLevel !== undefined) res.locals.priceLevelSelected = f.priceLevel;
  if (f.copyNotes !== undefined) res.locals.copyNotesValue = f.copyNotes;
  const { rows: locs } = await pool.query("SELECT location, COUNT(*)::int AS count, MAX(updated_at) AS last FROM book_copies WHERE location IS NOT NULL GROUP BY location");
  res.render("admin/inventory/new", {
    active: "inventory", location: normalizeLocation(f.location) || "", source: normalizeSource(f.source) || "", sources: SOURCES, locations: inventoryLib.uniqueLocations(locs),
    book: f.book,
    error: f.error || null,
    fromScan: f.fromScan === true,
    conditions: CONDITIONS, bindings: inventoryLib.BINDINGS || [],
    statuses: STATUSES,
    ...(f.selectedCondition !== undefined ? { selectedCondition: f.selectedCondition } : {}),
    ...(f.publisherPriceValue !== undefined ? { publisherPriceValue: f.publisherPriceValue } : {}),
    defaultPricing: f.defaultPricing || { price: suggestion.price, acquisitionCost: f.acquisitionCost || 0 },
  });
});

// No-JavaScript version: the add-book form again with the price control set to the suggestion.
router.post("/admin/inventory/suggest", requireAdmin, async (req, res) => {
  const b = req.body;
  const isbn = b.isbn ? normalizeIsbn(b.isbn) : null;
  const binding = pricingBinding(b.binding);
  const condition = normalizeCondition(b.condition);
  await setFlash(req, "intake", {
    prep: { isbn, title: (b.title || "").trim(), author: (b.author || "").trim(), binding, condition, publisherPrice: b.publisherPrice },
    copyNotes: b.copyNotes || "",
    location: normalizeLocation(b.location) || "", source: normalizeSource(b.source) || "",
    book: {
      isbn, title: (b.title || "").trim() || null, author: (b.author || "").trim() || null, publisher: (b.publisher || "").trim() || null,
      publishedYear: b.publishedYear ? Number(b.publishedYear) : null, description: (b.description || "").trim() || null,
      coverUrl: (b.coverUrl || "").trim() || null,
      genre: normalizeGenres(b.genre), binding,
    },
    fromScan: b.fromScan === "1",
    selectedCondition: condition,
    publisherPriceValue: b.publisherPrice || "",
    acquisitionCost: parseMoney(b.acquisitionCost, { allowBlank: true }).value || 0, // "4,50" or "4.50"; anything else: 0
  });
  res.redirect(303, "/admin/inventory/new/again");
});

module.exports = router;
