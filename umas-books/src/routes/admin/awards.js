const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { validateIdParams } = require("../../middleware/idParams");
const { checkBookAwards } = require("../../lib/awards");
const { parseManualAwards } = require("../../lib/awards/manual");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id");

// "Re-check now" waits this long, then lets the check finish in the background.
const RECHECK_WAIT_MS = 30 * 1000;

// Remove: typed-in (manual) rows only. Wikidata / NYT rows come from the
// lookups and are not edited by hand.
router.post("/admin/awards/:id/remove", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    "DELETE FROM book_awards WHERE id = $1 AND source = 'manual' RETURNING id, label, book_id", [Number(req.params.id)]
  );
  if (!rows.length) return res.status(404).render("404");
  await audit(req, { action: "award.remove", targetType: "book_award", targetId: rows[0].id, detail: rows[0].label });
  res.redirect(`/admin/inventory/${rows[0].book_id}?notice=awards-removed`);
});

router.post("/admin/inventory/:id/awards/check", requireAdmin, async (req, res) => {
  const bookId = Number(req.params.id);
  const { rows } = await pool.query("SELECT 1 FROM books WHERE id = $1", [bookId]);
  if (!rows.length) return res.status(404).render("404");
  let timer;
  const slow = new Promise((resolve) => { timer = setTimeout(() => resolve("slow"), RECHECK_WAIT_MS); });
  const result = await Promise.race([checkBookAwards(pool, bookId), slow]);
  clearTimeout(timer);
  await audit(req, { action: "award.check", targetType: "book", targetId: bookId });
  res.redirect(`/admin/inventory/${bookId}?notice=${result === "slow" ? "awards-slow" : "awards-checked"}`);
});

router.post("/admin/inventory/:id/awards/add", requireAdmin, async (req, res) => {
  const bookId = Number(req.params.id);
  const { rows } = await pool.query("SELECT 1 FROM books WHERE id = $1", [bookId]);
  if (!rows.length) return res.status(404).render("404");
  const items = parseManualAwards(req.body?.awards);
  for (const it of items) {
    // Typed-in awards are shown at once; one already on the book is left alone.
    const { rows: done } = await pool.query(
      `INSERT INTO book_awards (book_id, label, year, kind, source, status, decided_at, decided_by)
       VALUES ($1, $2, $3, $4, 'manual', 'verified', now(), $5)
       ON CONFLICT (book_id, lower(label), (COALESCE(year, 0))) DO NOTHING
       RETURNING id, label`,
      [bookId, it.label, it.year, it.kind, req.session.user.id]
    );
    if (done.length) await audit(req, { action: "award.add", targetType: "book_award", targetId: done[0].id, detail: done[0].label });
  }
  res.redirect(`/admin/inventory/${bookId}?notice=awards-added`);
});

module.exports = router;
