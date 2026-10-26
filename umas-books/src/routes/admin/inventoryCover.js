// The Cover card of a book's admin page: replace the cover photo, rotate it, crop it, remove it.
//
//   POST /admin/inventory/:id/cover/rotate    direction=left|right
//   POST /admin/inventory/:id/cover/crop      x, y, w, h  (fractions 0..1 of the CURRENT picture)
//   POST /admin/inventory/:id/cover/replace   multipart, field "coverPhoto" (multer runs in src/app.js, 8 MB)
//   POST /admin/inventory/:id/cover/remove
//
// Admin only, CSRF-protected (src/app.js), audit-logged (cover.rotate / cover.crop / cover.replace / cover.remove),
// limited per admin account. Every one is a plain form post that works without JavaScript: the answer is a redirect back to
// the book (#cover) with the result in the card; a script that sends `Accept: application/json` gets JSON and the real
// status (400 bad values, 409 changed meanwhile, 413 too big, 429 too many). The image work is lib/coverEdit.js; this file
// only reads the request, saves the new picture and points books.cover_url at it.
//
// What an edit does NOT do: no awards check, no AI call, no description or translation fill (they belong to saving a new
// book), no network call. The old picture stays in `images` for the cleanup job (lib/imageCleanup.js).

const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { coverEditLimiter } = require("../../middleware/rateLimits");
const { validateIdParams } = require("../../middleware/idParams");
const { audit } = require("../../lib/audit");
const { saveImage } = require("../../lib/imageStore");
const { clearBrowseCaches } = require("../../lib/latestArrivals");
const { CoverEditError, COVER_ERRORS, COVER_NOTICES, rotateCover, parseCrop, cropCover, coverFromPhoto, loadStoredCover } = require("../../lib/coverEdit");

const router = express.Router();
validateIdParams(router, "id");

const wantsJson = (req) => req.accepts(["html", "json"]) === "json";

// One way to answer: JSON for a script, otherwise back to the book with the sentence shown in the Cover card.
function answer(req, res, bookId, code, extra = {}) {
  const failed = Object.hasOwn(COVER_ERRORS, code);
  if (wantsJson(req)) {
    const status = failed ? COVER_ERRORS[code].status : 200;
    const message = failed ? COVER_ERRORS[code].message : COVER_NOTICES[code];
    return res.status(status).json({ ok: !failed, code, message, ...extra });
  }
  return res.redirect(303, `/admin/inventory/${bookId}?cover=${encodeURIComponent(code)}#cover`);
}

const limiter = coverEditLimiter({
  handler: (req, res) => {
    const m = /^\/admin\/inventory\/(\d+)\/cover\//.exec(req.originalUrl || "");
    if (m && !wantsJson(req)) return res.redirect(303, `/admin/inventory/${m[1]}?cover=busy#cover`);
    return res.status(429).json({ ok: false, code: "busy", message: COVER_ERRORS.busy.message });
  },
});

async function loadBook(req, res) {
  const id = Number(req.params.id);
  const { rows } = await pool.query("SELECT id, cover_url FROM books WHERE id = $1", [id]);
  if (!rows.length) { res.status(404).render("404"); return null; }
  return rows[0];
}

// Runs one edit and writes the result. `change` gets the stored bytes and returns { data } for the new picture, or
// { unchanged: true }. The write only happens while the cover is still the one that was edited, so two people pressing
// at once cannot silently undo each other (a double press by one person is two turns: both are applied in turn).
async function editStored(req, res, kind, change, auditDetail) {
  const book = await loadBook(req, res);
  if (!book) return;
  try {
    const bytes = await loadStoredCover(book.cover_url, pool);
    const result = await change(bytes);
    if (result.unchanged) return answer(req, res, book.id, "no-change", { coverUrl: book.cover_url });
    const url = await saveImage(result.data, "image/jpeg", pool);
    const { rowCount } = await pool.query(
      `UPDATE books SET cover_url = $1, cover_removed_at = NULL, updated_at = now()
        WHERE id = $2 AND cover_url = $3`,
      [url, book.id, book.cover_url]
    );
    if (!rowCount) return answer(req, res, book.id, "changed");
    clearBrowseCaches(pool);
    await audit(req, { action: `cover.${kind}`, targetType: "book", targetId: book.id, detail: auditDetail(result) });
    return answer(req, res, book.id, kind === "rotate" ? "rotated" : "cropped", { coverUrl: url });
  } catch (err) {
    if (!(err instanceof CoverEditError)) throw err;
    return answer(req, res, book.id, err.code);
  }
}

router.post("/admin/inventory/:id/cover/rotate", requireAdmin, limiter, (req, res) => {
  const direction = req.body && typeof req.body.direction === "string" ? req.body.direction : "";
  return editStored(req, res, "rotate", async (bytes) => ({ data: await rotateCover(bytes, direction) }), () => direction);
});

router.post("/admin/inventory/:id/cover/crop", requireAdmin, limiter, async (req, res) => {
  let crop;
  try {
    crop = parseCrop(req.body);
  } catch (err) {
    if (!(err instanceof CoverEditError)) throw err;
    // Checked before anything is read or stored: a bad box changes nothing. (A missing book is still a 404.)
    const book = await loadBook(req, res);
    return book ? answer(req, res, book.id, err.code) : undefined;
  }
  const r4 = (n) => Math.round(n * 10000) / 10000;
  return editStored(req, res, "crop", async (bytes) => {
    const out = await cropCover(bytes, crop);
    return out.changed ? { data: out.data } : { unchanged: true };
  }, () => `x=${r4(crop.x)} y=${r4(crop.y)} w=${r4(crop.w)} h=${r4(crop.h)}`);
});

router.post("/admin/inventory/:id/cover/replace", requireAdmin, limiter, async (req, res) => {
  const book = await loadBook(req, res);
  if (!book) return;
  const file = req.files && req.files.coverPhoto && req.files.coverPhoto[0];
  try {
    const data = await coverFromPhoto(file && file.buffer);
    const url = await saveImage(data, "image/jpeg", pool);
    await pool.query("UPDATE books SET cover_url = $1, cover_removed_at = NULL, updated_at = now() WHERE id = $2", [url, book.id]);
    clearBrowseCaches(pool);
    await audit(req, { action: "cover.replace", targetType: "book", targetId: book.id, detail: book.cover_url ? "replaced" : "added" });
    return answer(req, res, book.id, "replaced", { coverUrl: url });
  } catch (err) {
    if (!(err instanceof CoverEditError)) throw err;
    return answer(req, res, book.id, err.code);
  }
});

// The picture itself is left in `images` for the unused-image cleanup (it is deleted there once nothing refers to it and it is
// older than the grace period). The book remembers the removal (cover_removed_at) so saving its details, scanning another copy
// or the background job does not fetch a cover again; its download address is forgotten for the same reason.
router.post("/admin/inventory/:id/cover/remove", requireAdmin, limiter, async (req, res) => {
  const book = await loadBook(req, res);
  if (!book) return;
  if (!book.cover_url) return answer(req, res, book.id, "removed", { coverUrl: null });
  await pool.query(
    `UPDATE books SET cover_url = NULL, cover_source_url = NULL, cover_fetch_failures = 0, cover_removed_at = now(), updated_at = now()
      WHERE id = $1`,
    [book.id]
  );
  clearBrowseCaches(pool);
  await audit(req, { action: "cover.remove", targetType: "book", targetId: book.id });
  return answer(req, res, book.id, "removed", { coverUrl: null });
});

module.exports = router;
