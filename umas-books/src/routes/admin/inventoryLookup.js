// JSON lookup for the one-screen "Add a book" page (public/scan-intake.js).
// Mounted BEFORE the inventory router: "lookup" is not a book id.
//
//   GET /admin/inventory/lookup?isbn=...
//
// Answers with what the catalog knows about the ISBN, the book and copies the
// shop already has, and the price suggestion for it: the page fills the form
// in place with that. Nothing here saves anything.

const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { limit } = require("../../middleware/rateLimits");
const { normalizeIsbn, lookupByIsbn } = require("../../lib/bookLookup");
const { isbnVariants, bindingLabel } = require("../../lib/inventory");
const { prepareCover } = require("../../lib/coverStore");
const { computeSuggestion } = require("../../lib/pricing/forms");

const router = express.Router();

// 120 a minute per person: a fast run of scans is about one a few seconds.
const lookupLimiter = limit({
  windowMs: 60 * 1000,
  max: 120,
  keyGenerator: (req) => `user-${req.session && req.session.user ? req.session.user.id : "anon"}`,
  handler: (req, res) => res.status(429).json({ error: "Too many lookups: wait a minute and try again." }),
  validate: { keyGeneratorIpFallback: false },
});

const isValidIsbnShape = (s) => /^(\d{13}|\d{9}[\dX])$/.test(s);

// GET /admin/inventory/lookup with no ?isbn= is the page of the no-JavaScript lookup
// (Post/Redirect/Get, in inventory.js): it is passed on. Only ?isbn= answers JSON here.
router.get("/admin/inventory/lookup", requireAdmin, (req, res, next) => (req.query.isbn === undefined ? next("router") : next()), lookupLimiter, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const isbn = normalizeIsbn(String(req.query.isbn == null ? "" : req.query.isbn).slice(0, 40));
  if (!isValidIsbnShape(isbn)) return res.status(400).json({ error: "Enter an ISBN of 10 or 13 digits." });

  const { rows } = await pool.query(
    `SELECT b.id, b.title, b.authors, b.publisher, b.published_year, b.description, b.cover_url, b.categories, b.categories_fr, b.binding,
            (SELECT count(*)::int FROM book_copies c WHERE c.book_id = b.id AND c.status IN ('in_stock', 'reserved')) AS copies
     FROM books b WHERE b.isbn = ANY($1) ORDER BY b.id LIMIT 1`,
    [isbnVariants(isbn)]
  );
  const stocked = rows[0] || null;

  let found = null;
  try {
    found = await lookupByIsbn(isbn);
  } catch (err) {
    console.warn("ISBN lookup failed:", err.message);
  }
  // A book the shop already has is shown as the shop has it; the catalog fills the gaps.
  const book = stocked
    ? {
        title: stocked.title, author: stocked.authors, publisher: stocked.publisher || (found && found.publisher) || null,
        publishedYear: stocked.published_year || (found && found.publishedYear) || null,
        description: stocked.description || (found && found.description) || null,
        coverUrl: stocked.cover_url || (found && found.coverUrl) || null,
        genre: stocked.categories || (found && found.genre) || null, genreFr: stocked.categories_fr || (found && found.genreFr) || null,
        binding: stocked.binding || (found && found.binding) || null,
      }
    : found && {
        title: found.title, author: found.author, publisher: found.publisher, publishedYear: found.publishedYear,
        description: found.description, coverUrl: found.coverUrl, genre: found.genre, genreFr: found.genreFr, binding: found.binding || null,
      };

  // The catalog gives an Open Library address: the preview uses our own copy (lib/coverStore.js).
  if (book && book.coverUrl && !book.coverUrl.startsWith("/")) {
    try {
      book.coverUrl = (await prepareCover(book.coverUrl)).cover || null;
    } catch {
      book.coverUrl = null;
    }
  }

  // The binding is only a hint (the page keeps the one entered last).
  const bindingHint = book && book.binding ? { key: book.binding, label: bindingLabel(book.binding, "en") || book.binding } : null;
  // The price follows the binding selected on the page (the one used last), else the catalog's.
  const selectedBinding = String(req.query.binding == null ? "" : req.query.binding).slice(0, 20);
  const suggestion = await computeSuggestion({
    isbn, title: book && book.title, author: book && book.author, binding: selectedBinding || (book && book.binding), condition: "very_good",
  });

  res.json({
    ok: true,
    isbn,
    found: Boolean(book),
    book: book ? { ...book, binding: undefined } : null,
    bindingHint,
    existing: stocked ? { bookId: stocked.id, title: stocked.title, copies: stocked.copies } : null,
    suggestion,
  });
});

module.exports = router;
