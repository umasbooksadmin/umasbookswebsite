const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { countUnusedImages } = require("../../lib/imageCleanup");
const { salesStats, attentionCounts } = require("../../lib/dashboardStats");
const { outboxAttention } = require("../../lib/outboxAttention");
const { todayParis } = require("../../lib/reports");
const { formatTime } = require("../../lib/dates");
const tillLib = require("../../lib/till");

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

  // Voided card sales: the card must be refunded by hand on the SumUp reader or app.
  const unrefunded = await require("../../lib/till").unrefundedVoids(pool).catch(() => []);
  if (unrefunded.length) {
    const total = unrefunded.reduce((a, r) => a + r.total_cents, 0);
    tillItems.push({
      href: `/admin/till/day?day=${unrefunded[0].day}`,
      text: `Till: ${unrefunded.length} voided card sale${unrefunded.length === 1 ? "" : "s"} (€${(total / 100).toFixed(2)}) not marked as refunded. Refund the card on the SumUp reader or app, then tick "I refunded the card".`,
    });
  }

  // Every void made today (who, when, how much, why): a till-only account has no two-step
  // verification, so an admin should see them.
  const today = todayParis();
  const voidsToday = await tillLib.voidsOfDay(pool, today).catch(() => []);
  for (const v of voidsToday.slice(0, 10)) {
    tillItems.push({
      href: `/admin/till/day?day=${today}`,
      text: `Till void today: sale ${v.id}, €${(v.total_cents / 100).toFixed(2)} ${v.payment_method}, by ${v.voided_by_name}${v.by_admin ? "" : " (till account)"} at ${formatTime(v.voided_at)}: ${v.void_reason}`,
    });
  }
  if (voidsToday.length > 10) tillItems.push({ href: `/admin/till/day?day=${today}`, text: `Till: ${voidsToday.length - 10} more void(s) today. See the end of day.` });

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
