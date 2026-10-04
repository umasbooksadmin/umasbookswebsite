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
const { parseId } = require("../../lib/validation");
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

// No-JavaScript version: shows the add-book form again with everything typed
// so far and the price control set to the suggestion. (A chosen cover photo
// has to be picked again.)
router.post("/admin/inventory/suggest", requireAdmin, async (req, res) => {
  const b = req.body;
  const isbn = b.isbn ? normalizeIsbn(b.isbn) : null;
  const binding = pricingBinding(b.binding);
  const condition = normalizeCondition(b.condition);
  const suggestion = await prepareIntakeForm(res, { isbn, title: (b.title || "").trim(), author: (b.author || "").trim(), binding, condition, publisherPrice: b.publisherPrice });
  res.locals.copyNotesValue = b.copyNotes || "";
  const { rows: locs } = await pool.query("SELECT DISTINCT location FROM book_copies WHERE location IS NOT NULL ORDER BY 1");
  res.render("admin/inventory/new", {
    active: "inventory", location: normalizeLocation(b.location) || "", source: normalizeSource(b.source) || "", sources: SOURCES, locations: locs.map((r) => r.location),
    book: {
      isbn, title: (b.title || "").trim() || null, author: (b.author || "").trim() || null, publisher: (b.publisher || "").trim() || null,
      publishedYear: b.publishedYear ? Number(b.publishedYear) : null, description: (b.description || "").trim() || null,
      descriptionFr: (b.descriptionFr || "").trim() || null, coverUrl: (b.coverUrl || "").trim() || null,
      genre: normalizeGenres(b.genre), genreFr: (b.genreFr || "").trim() || null, binding,
    },
    error: null,
    fromScan: b.fromScan === "1",
    conditions: CONDITIONS, bindings: inventoryLib.BINDINGS || [],
    statuses: STATUSES,
    selectedCondition: condition,
    publisherPriceValue: b.publisherPrice || "",
    defaultPricing: { price: suggestion.price, acquisitionCost: b.acquisitionCost ? Number(b.acquisitionCost) : 0 },
  });
});

module.exports = router;
