const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { countUnusedImages } = require("../../lib/imageCleanup");
const { salesStats, attentionCounts } = require("../../lib/dashboardStats");
const { outboxAttention } = require("../../lib/outboxAttention");

const router = express.Router();

// ---------- Overview ----------

// Every number on the dashboard is a real query against this app's own
// data — there's no analytics/traffic tracking anywhere in this
// app, so there's deliberately no "website traffic" stat here; showing
// one would mean making it up. Orders and sales count PAID orders on the day
// they were paid, in Paris time (lib/dashboardStats.js); refunded orders are
// left out. The book and account counts below use the database clock.
router.get("/admin", requireAdmin, async (req, res) => {
  const [sales, attention, books, accounts, memberCount, unusedImages] = await Promise.all([
    salesStats(pool),
    attentionCounts(pool),
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status = 'in_stock')::int AS in_stock,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS added_this_month,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now() - interval '1 month')
                            AND created_at < date_trunc('month', now()))::int AS added_last_month
      FROM book_copies`),
    pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS new_this_month,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now() - interval '1 month')
                            AND created_at < date_trunc('month', now()))::int AS new_last_month
      FROM users`),
    pool.query("SELECT COUNT(*)::int AS n FROM users WHERE is_member = TRUE AND (member_expires_at IS NULL OR member_expires_at > now())"),
    // Read-only; a failure here must not take the dashboard down.
    countUnusedImages(pool).catch(() => 0),
  ]);

  const attentionFromMail = await outboxAttention(pool).catch((err) => {
    console.error("Needs-attention query failed:", err.message);
    return [];
  });

  // A past day with till sales that was never closed (counted and signed off).
  const tillDays = await require("../../lib/till").unclosedDays(pool).catch(() => []);
  const tillItems = tillDays.slice(0, 5).map((d) => ({ href: `/admin/till/day?day=${d}`, text: `Till: ${d} has sales but the day was never closed. Count the drawer and close it.` }));

  res.render("admin/index", {
    active: "overview",
    outboxAttention: [...attentionFromMail, ...tillItems],
    stats: {
      ...sales,
      inStockCount: books.rows[0].in_stock,
      booksAddedThisMonth: books.rows[0].added_this_month,
      booksAddedLastMonth: books.rows[0].added_last_month,
      totalAccounts: accounts.rows[0].total,
      newAccountsThisMonth: accounts.rows[0].new_this_month,
      newAccountsLastMonth: accounts.rows[0].new_last_month,
      memberCount: memberCount.rows[0].n,
      unusedImages,
    },
    attention,
  });
});

module.exports = router;
