const express = require("express");
const config = require("../../lib/config");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { makeDashboardUnusedCount } = require("../../lib/imageCleanup");
const { salesStats, attentionCounts } = require("../../lib/dashboardStats");
const { outboxAttention } = require("../../lib/outboxAttention");
const till = require("../../lib/till");
const tillLib = till;
const { todayParis } = require("../../lib/reports");
const { formatTime } = require("../../lib/dates");
const { runLimited, cachedFor } = require("../../lib/runLimited");
const { checkNodeVersion } = require("../../lib/nodeVersion");

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
  return config.get("DASHBOARD_COUNTS_CACHE_SECONDS") * 1000;
}

// The unused-image count is its own slower, longer-lived number: bounded to 3 s
// (the query holds its connection only that long, then releases it), cached
// 10 min in production, and on a timeout the last good value (or "n/a").
const unusedImageCount = makeDashboardUnusedCount(pool, {
  ttlMs: () => (countsTtlMs() > 0 ? 10 * 60 * 1000 : 0),
  timeoutMs: 3000,
});

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
    () => unusedImageCount(),
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

  // A stale Node.js runtime (older than the table in lib/nodeVersion.js): no query, no network.
  const node = checkNodeVersion();
  const nodeItems = node.ok ? [] : [{ href: "/admin/diagnostics/client-ip", text: `Node.js ${node.version} is older than ${node.minimum} (security fixes). See the runbook, "Node.js security updates".` }];

  res.render("admin/index", {
    active: "overview",
    outboxAttention: [...attentionFromMail, ...tillItems, ...nodeItems],
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
