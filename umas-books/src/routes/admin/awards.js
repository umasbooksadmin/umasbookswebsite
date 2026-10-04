const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { parseId } = require("../../lib/validation");
const { validateIdParams } = require("../../middleware/idParams");
const { checkBookAwards, lookupsDisabled } = require("../../lib/awards");
const { aiEnabled, aiUsage } = require("../../lib/awards/ai");
const { parseManualAwards } = require("../../lib/awards/manual");

const router = express.Router();
// Garbage ids get the 404 page, not a Postgres 22P02 and a 500.
validateIdParams(router, "id");

// "Re-check now" waits this long, then lets the check finish in the background.
const RECHECK_WAIT_MS = 30 * 1000;

const back = (req, bookId, notice) =>
  req.body?.returnTo === "review" || !bookId ? `/admin/awards?notice=${notice}` : `/admin/inventory/${bookId}?notice=${notice}`;

// ---------- Review queue ----------

const REVIEW_NOTICES = {
  "awards-updated": "Done.",
};

router.get("/admin/awards", requireAdmin, async (req, res) => {
  const { rows: pending } = await pool.query(
    `SELECT a.id, a.label, a.year, a.kind, a.source_url, a.created_at, b.id AS book_id, b.title, b.authors
     FROM book_awards a JOIN books b ON b.id = a.book_id
     WHERE a.status = 'pending' ORDER BY a.created_at ASC, a.id ASC LIMIT 300`
  );
  const { rows: counts } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE awards_checked_at IS NOT NULL)::int AS checked,
            COUNT(*) FILTER (WHERE awards_checked_at IS NULL)::int AS unchecked,
            COUNT(*) FILTER (WHERE awards_check_state = 'error')::int AS errors
     FROM books`
  );
  const usage = await aiUsage(pool);
  res.render("admin/awards", {
    active: "awards", pending, counts: counts[0], usage, aiOn: aiEnabled(),
    lookupsOn: !lookupsDisabled(),
    notice: typeof req.query.notice === "string" && Object.hasOwn(REVIEW_NOTICES, req.query.notice) ? REVIEW_NOTICES[req.query.notice] : null,
  });
});

// Approve / reject. The WHERE clause only moves rows that are not already in
// the target state, so a double click changes (and logs) nothing.
const FROM_STATUSES = {
  approved: ["pending", "rejected"],
  rejected: ["pending", "verified", "approved"],
};
async function decide(req, ids, status, action) {
  const { rows } = await pool.query(
    `UPDATE book_awards SET status = $2, decided_at = now(), decided_by = $3
     WHERE id = ANY($1::int[]) AND status = ANY($4) AND source <> 'manual'
     RETURNING id, label, book_id`,
    [ids, status, req.session.user.id, FROM_STATUSES[status]]
  );
  for (const r of rows) await audit(req, { action, targetType: "book_award", targetId: r.id, detail: r.label });
  return rows;
}

router.post("/admin/awards/approve-bulk", requireAdmin, async (req, res) => {
  const raw = [].concat(req.body?.ids || []);
  const ids = [...new Set(raw.map((v) => parseId(String(v))).filter((n) => n !== null))].slice(0, 300);
  if (ids.length) await decide(req, ids, "approved", "award.approve");
  res.redirect("/admin/awards?notice=awards-updated");
});

router.post("/admin/awards/:id/approve", requireAdmin, async (req, res) => {
  const rows = await decide(req, [Number(req.params.id)], "approved", "award.approve");
  res.redirect(back(req, rows[0] ? rows[0].book_id : null, "awards-updated"));
});

router.post("/admin/awards/:id/reject", requireAdmin, async (req, res) => {
  const rows = await decide(req, [Number(req.params.id)], "rejected", "award.reject");
  res.redirect(back(req, rows[0] ? rows[0].book_id : null, "awards-updated"));
});

// Remove: typed-in (manual) rows only; the other kinds are rejected instead,
// so the same suggestion is not found and added again.
router.post("/admin/awards/:id/remove", requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    "DELETE FROM book_awards WHERE id = $1 AND source = 'manual' RETURNING id, label, book_id", [Number(req.params.id)]
  );
  if (!rows.length) return res.status(404).render("404");
  await audit(req, { action: "award.remove", targetType: "book_award", targetId: rows[0].id, detail: rows[0].label });
  res.redirect(`/admin/inventory/${rows[0].book_id}?notice=awards-removed`);
});

// ---------- Per book ----------

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
    // A typed-in award also replaces an AI suggestion that is pending or was rejected.
    const { rows: done } = await pool.query(
      `INSERT INTO book_awards (book_id, label, year, kind, source, status, decided_at, decided_by)
       VALUES ($1, $2, $3, $4, 'manual', 'verified', now(), $5)
       ON CONFLICT (book_id, lower(label), (COALESCE(year, 0))) DO UPDATE
         SET source = 'manual', status = 'verified', kind = EXCLUDED.kind, decided_at = now(), decided_by = $5
         WHERE book_awards.status IN ('pending', 'rejected')
       RETURNING id, label`,
      [bookId, it.label, it.year, it.kind, req.session.user.id]
    );
    if (done.length) await audit(req, { action: "award.add", targetType: "book_award", targetId: done[0].id, detail: done[0].label });
  }
  res.redirect(`/admin/inventory/${bookId}?notice=awards-added`);
});

module.exports = router;
