// Admin > Reports > Covers to check (lib/coverReview.js): books whose cover may be another edition's picture.
//
//   GET  /admin/reports/covers-to-check            the list (50 per page, ?page=N); ?view=missing lists the books with no cover
//                                                  (each with a Find a cover button, routes/admin/inventoryFindCover.js)
//   POST /admin/reports/covers-to-check/:id/check  ask the catalog about this one ISBN; a match marks the book checked
//   POST /admin/reports/covers-to-check/:id/ok     the owner says "the cover is fine"
//
// Admin only, CSRF-protected (src/app.js), audit-logged (cover.review_ok), limited per admin account. No cover is ever
// changed, replaced or removed here (that is the Cover card of the book).

const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { coverEditLimiter } = require("../../middleware/rateLimits");
const { validateIdParams } = require("../../middleware/idParams");
const { audit } = require("../../lib/audit");
const { setFlash, takeFlash } = require("../../lib/flash");
const { listCoversToCheck, listMissingCovers, coverCounts, checkCover } = require("../../lib/coverReview");

const router = express.Router();
validateIdParams(router, "id");

const BASE = "/admin/reports/covers-to-check";
const limiter = coverEditLimiter({
  max: 20,
  handler: async (req, res) => {
    await setFlash(req, "covers-to-check", { error: "Too many checks at once. Wait a minute and go on." });
    res.redirect(303, BASE);
  },
});

router.get(BASE, requireAdmin, async (req, res) => {
  const view = req.query.view === "missing" ? "missing" : "check";
  const [list, counts] = await Promise.all([view === "missing" ? listMissingCovers(pool, req.query.page) : listCoversToCheck(pool, req.query.page), coverCounts(pool)]);
  res.render("admin/reports/covers_to_check", {
    active: "reports", title: "Covers to check", pageTitle: "Covers to check",
    pageSub: view === "missing" ? "Books with no cover. Use Find a cover on each." : "Books whose cover may be another edition's picture. Nothing here changes a cover.",
    view, counts, ...list, flash: takeFlash(req, "covers-to-check"),
  });
});

async function loadBook(req, res) {
  const { rows } = await pool.query("SELECT id, isbn, title, cover_source_url FROM books WHERE id = $1", [Number(req.params.id)]);
  if (!rows.length) { res.status(404).render("404"); return null; }
  return rows[0];
}

async function markChecked(req, book, detail) {
  await pool.query("UPDATE books SET cover_checked_at = now() WHERE id = $1 AND cover_url IS NOT NULL", [book.id]);
  await audit(req, { action: "cover.review_ok", targetType: "book", targetId: book.id, detail });
}

router.post(`${BASE}/:id/ok`, requireAdmin, limiter, async (req, res) => {
  const book = await loadBook(req, res);
  if (!book) return;
  await markChecked(req, book, "marked fine by hand");
  await setFlash(req, "covers-to-check", { notice: `"${book.title}": marked as checked. It leaves this list.` });
  res.redirect(303, BASE);
});

router.post(`${BASE}/:id/check`, requireAdmin, limiter, async (req, res) => {
  const book = await loadBook(req, res);
  if (!book) return;
  const result = await checkCover(book);
  if (result.state === "match") {
    await markChecked(req, book, "matches the catalog cover for its ISBN");
    await setFlash(req, "covers-to-check", { notice: `"${book.title}": ${result.message} Marked as checked.` });
  } else {
    await setFlash(req, "covers-to-check", { notice: `"${book.title}": ${result.message}`, bookId: book.id, catalogCover: result.catalogCover });
  }
  res.redirect(303, BASE);
});

module.exports = router;
