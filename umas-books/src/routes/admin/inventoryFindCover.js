// "Find a cover" for one book (lib/coverSearch.js): Open Library candidates by title and author, picked by the admin.
//
//   GET  /admin/inventory/:id/find-cover?go=1             the candidates (the search runs when the page opens, cached); without go=1 only the button
//   GET  /admin/inventory/:id/find-cover/thumb/:coverId   a small picture of one candidate (the pages may only show our own images)
//   POST /admin/inventory/:id/find-cover/choose           coverId=<number>: download that cover, save it, origin 'chosen'
//
// Admin only, CSRF-protected (src/app.js), audit-logged (cover.choose), limited per admin account. A candidate is never applied
// by itself. The browser sends back only a cover NUMBER; the address is built here and goes through the safe download pipeline
// (lib/coverStore.js: covers.openlibrary.org only, public addresses only, size and time limits, re-encoded). A pick clears
// cover_removed_at like a photo does, and marks the cover as checked (the admin looked at it).

const express = require("express");
const sharp = require("sharp");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { coverEditLimiter } = require("../../middleware/rateLimits");
const { validateIdParams } = require("../../middleware/idParams");
const { audit } = require("../../lib/audit");
const { setFlash } = require("../../lib/flash");
const { clearBrowseCaches } = require("../../lib/latestArrivals");
const { fetchCoverImage, localizeCover } = require("../../lib/coverStore");
const { findCoverCandidates, parseCoverId, coverAddress } = require("../../lib/coverSearch");
const { isStoredImageUrl } = require("../../lib/imageStore");
const { variantUrl } = require("../../lib/imageVariants");
const { COVER_ERRORS, COVER_NOTICES } = require("../../lib/coverEdit");

const router = express.Router();
validateIdParams(router, "id");

const BACK = { missing: "/admin/reports/covers-to-check?view=missing", check: "/admin/reports/covers-to-check" };
const backOf = (from) => (Object.hasOwn(BACK, from) ? from : "");
const fromOf = (req) => backOf(String((req.body && req.body.from) || req.query.from || ""));

const busy = (req, res) => {
  const m = /^\/admin\/inventory\/(\d+)\//.exec(req.originalUrl || "");
  if (req.method === "POST" && m) return res.redirect(303, `/admin/inventory/${m[1]}?cover=busy#cover`);
  return res.status(429).type("text/plain").send(COVER_ERRORS.busy.message);
};
const searchLimiter = coverEditLimiter({ max: 12, handler: busy }); // each opening of the page is one or two Open Library searches
const thumbLimiter = coverEditLimiter({ max: 120, handler: busy }); // up to 8 small pictures per opening
const chooseLimiter = coverEditLimiter({ handler: busy });

async function loadBook(req, res) {
  const { rows } = await pool.query("SELECT id, isbn, title, authors, publisher, published_year, cover_url, cover_removed_at FROM books WHERE id = $1", [Number(req.params.id)]);
  if (!rows.length) { res.status(404).render("404"); return null; }
  return rows[0];
}

// The search runs only with go=1 (every Find a cover button and link carries it): any other address shows the page with a
// "Search Open Library" button and asks nothing outside, so a stray or crafted address never costs a request.
const limitedWhenSearching = (req, res, next) => (req.query.go === "1" ? searchLimiter(req, res, next) : next());

router.get("/admin/inventory/:id/find-cover", requireAdmin, limitedWhenSearching, async (req, res) => {
  const book = await loadBook(req, res);
  if (!book) return;
  const result = req.query.go !== "1"
    ? { candidates: [], state: "idle", message: null }
    : await findCoverCandidates({ title: book.title, authors: book.authors, isbn: book.isbn, publisher: book.publisher, publishedYear: book.published_year });
  const goHref = `/admin/inventory/${book.id}/find-cover?go=1${fromOf(req) ? `&from=${fromOf(req)}` : ""}`;
  res.set("Cache-Control", "no-store");
  res.render("admin/inventory/find_cover", {
    active: "inventory", title: "Find a cover", pageTitle: "Find a cover", pageSub: book.title,
    book, result, from: fromOf(req), goHref,
    currentCover: isStoredImageUrl(book.cover_url) ? variantUrl(book.cover_url, 300) : null,
    backHref: BACK[fromOf(req)] || `/admin/inventory/${book.id}#cover`,
  });
});

// Small pictures for the candidate cards, through the same safe download as a real pick. Kept in memory for a while so a
// second look (or a reload) does not ask Open Library again.
const thumbs = new Map(); // coverId -> { jpeg, expires }
const THUMB_MAX = 80;
const THUMB_TTL_MS = 10 * 60 * 1000;

router.get("/admin/inventory/:id/find-cover/thumb/:coverId", requireAdmin, thumbLimiter, async (req, res) => {
  const coverId = parseCoverId(req.params.coverId);
  if (!coverId) return res.status(404).render("404");
  try {
    let hit = thumbs.get(coverId);
    if (!hit || hit.expires <= Date.now()) {
      const raw = await fetchCoverImage(coverAddress(coverId, "M"));
      const jpeg = await sharp(raw, { failOn: "none", limitInputPixels: 25_000_000 }).rotate().resize({ width: 240, withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer();
      hit = { jpeg, expires: Date.now() + THUMB_TTL_MS };
      thumbs.delete(coverId);
      thumbs.set(coverId, hit);
      while (thumbs.size > THUMB_MAX) thumbs.delete(thumbs.keys().next().value);
    }
    res.set({ "Content-Type": "image/jpeg", "Cache-Control": "private, max-age=600" });
    return res.send(hit.jpeg);
  } catch {
    return res.status(404).type("text/plain").send("No picture");
  }
});

router.post("/admin/inventory/:id/find-cover/choose", requireAdmin, chooseLimiter, async (req, res) => {
  const book = await loadBook(req, res);
  if (!book) return;
  const from = fromOf(req);
  const bookPage = (code) => `/admin/inventory/${book.id}?cover=${encodeURIComponent(code)}#cover`;
  const coverId = parseCoverId(req.body && req.body.coverId);
  if (!coverId) return res.redirect(303, bookPage("bad-pick"));

  let url;
  try {
    url = await localizeCover(coverAddress(coverId, "L"));
  } catch (err) {
    console.warn("Chosen cover download failed:", err.message);
    return res.redirect(303, bookPage("pick-failed"));
  }
  await pool.query(
    `UPDATE books SET cover_url = $1, cover_source_url = $2, cover_fetch_failures = 0, cover_removed_at = NULL,
            cover_origin = 'chosen', cover_checked_at = now(), updated_at = now()
      WHERE id = $3`,
    [url, coverAddress(coverId, "L"), book.id]
  );
  clearBrowseCaches(pool);
  await audit(req, { action: "cover.choose", targetType: "book", targetId: book.id, detail: `Open Library cover ${coverId}${book.cover_url ? ", replaced" : ", added"}` });
  if (from) {
    await setFlash(req, "covers-to-check", { notice: `"${book.title}": ${COVER_NOTICES.chosen}` });
    return res.redirect(303, BACK[from]);
  }
  return res.redirect(303, bookPage("chosen"));
});

module.exports = router;
