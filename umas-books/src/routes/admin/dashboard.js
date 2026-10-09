const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { countUnusedImages } = require("../../lib/imageCleanup");
const { salesStats, attentionCounts } = require("../../lib/dashboardStats");
const { outboxAttention } = require("../../lib/outboxAttention");
const till = require("../../lib/till");
const { runLimited, cachedFor } = require("../../lib/runLimited");

const DASHBOARD_CONCURRENCY = 3;

const router = express.Router();

// ---------- Overview ----------

// Every number on the dashboard is a real query against this app's own
// data — there's no analytics/traffic tracking anywhere in this
// app, so there's deliberately no "website traffic" stat here; showing
// one would mean making it up. Orders and sales count PAID orders on the day
// they were paid, in Paris time (lib/dashboardStats.js); refunded orders are
// left out. The book and account counts below use the database clock.
// Not money: the book, account and member counts and the unused-image count.
// They change slowly and cost the most scanning, so one computation is shared
// for 30 s per process (and by requests that arrive while it runs). Sales,
// order and "needs attention" numbers are never cached. Cached only when
// NODE_ENV=production (tests and local development always read fresh);
// DASHBOARD_COUNTS_CACHE_SECONDS overrides, 0 turns it off.
function countsTtlMs() {
  const raw = process.env.DASHBOARD_COUNTS_CACHE_SECONDS;
  if (raw !== undefined && raw !== "" && Number.isFinite(Number(raw)) && Number(raw) >= 0) return Number(raw) * 1000;
  return process.env.NODE_ENV === "production" ? 30000 : 0;
}

async function loadSlowCounts() {
  const [books, accounts, memberCount, unusedImages] = await runLimited([
    () => pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'in_stock')::int AS in_stock,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS added_this_month,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now() - interval '1 month')
                            AND created_at < date_trunc('month', now()))::int AS added_last_month
      FROM book_copies`),
    () => pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS new_this_month,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now() - interval '1 month')
                            AND created_at < date_trunc('month', now()))::int AS new_last_month
      FROM users`),
    () => pool.query("SELECT COUNT(*)::int AS n FROM users WHERE is_member = TRUE AND (member_expires_at IS NULL OR member_expires_at > now())"),
    // Read-only; a failure here must not take the dashboard down.
    () => countUnusedImages(pool).catch(() => 0),
  ], 1); // sequential: this task is one of the three slots the request itself uses
  return { books: books.rows[0], accounts: accounts.rows[0], memberCount: memberCount.rows[0].n, unusedImages };
}
const slowCounts = cachedFor(loadSlowCounts, countsTtlMs);

router.get("/admin", requireAdmin, async (req, res) => {
  // At most DASHBOARD_CONCURRENCY queries in flight per request: the pool is
  // shared with every other visitor and the background jobs, so a page that
  // grabs six connections at once starves them (one "timeout exceeded when
  // trying to connect" 500 was seen here).
  const [sales, attention, counts, attentionFromMail, tillDays, unrefunded] = await runLimited([
    () => salesStats(pool),
    () => attentionCounts(pool),
    () => slowCounts(),
    () => outboxAttention(pool).catch((err) => {
      console.error("Needs-attention query failed:", err.message);
      return [];
    }),
    // A past day with till sales that was never closed (counted and signed off).
    () => till.unclosedDays(pool).catch(() => []),
    // Voided card sales: the card must be refunded by hand on the SumUp reader or app.
    () => till.unrefundedVoids(pool).catch(() => []),
  ], DASHBOARD_CONCURRENCY);
  const { books, accounts, memberCount, unusedImages } = counts;

  const tillItems = tillDays.slice(0, 5).map((d) => ({ href: `/admin/till/day?day=${d}`, text: `Till: ${d} has sales but the day was never closed. Count the drawer and close it.` }));
  if (unrefunded.length) {
    const total = unrefunded.reduce((a, r) => a + r.total_cents, 0);
    tillItems.push({
      href: `/admin/till/day?day=${unrefunded[0].day}`,
      text: `Till: ${unrefunded.length} voided card sale${unrefunded.length === 1 ? "" : "s"} (€${(total / 100).toFixed(2)}) not marked as refunded. Refund the card on the SumUp reader or app, then tick "I refunded the card".`,
    });
  }

  res.render("admin/index", {
    active: "overview",
    outboxAttention: [...attentionFromMail, ...tillItems],
    stats: {
      ...sales,
      inStockCount: books.in_stock,
      booksAddedThisMonth: books.added_this_month,
      booksAddedLastMonth: books.added_last_month,
      totalAccounts: accounts.total,
      newAccountsThisMonth: accounts.new_this_month,
      newAccountsLastMonth: accounts.new_last_month,
      memberCount,
      unusedImages,
    },
    attention,
  });
});

module.exports = router;
