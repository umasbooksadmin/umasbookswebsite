const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { countUnusedImages } = require("../../lib/imageCleanup");

const router = express.Router();

// ---------- Overview ----------

// Every number on the dashboard is a real query against this app's own
// data — there's no analytics/traffic tracking anywhere in this
// app, so there's deliberately no "website traffic" stat here; showing
// one would mean making it up. "This month" vs "last month" comparisons
// use calendar-month boundaries in the server's local time.
router.get("/admin", requireAdmin, async (req, res) => {
  const [orders, sales, books, accounts, memberCount, unusedImages] = await Promise.all([
    pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE created_at >= CURRENT_DATE)::int AS today,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now()))::int AS this_month,
        COUNT(*) FILTER (WHERE created_at >= date_trunc('month', now() - interval '1 month')
                            AND created_at < date_trunc('month', now()))::int AS last_month
      FROM orders`),
    pool.query(`
      SELECT
        COALESCE(SUM(total_amount) FILTER (WHERE created_at >= CURRENT_DATE), 0) AS today,
        COALESCE(SUM(total_amount) FILTER (WHERE created_at >= date_trunc('month', now())), 0) AS this_month,
        COALESCE(SUM(total_amount) FILTER (WHERE created_at >= date_trunc('month', now() - interval '1 month')
                            AND created_at < date_trunc('month', now())), 0) AS last_month
      FROM orders WHERE status = 'paid'`),
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
    pool.query("SELECT COUNT(*)::int AS n FROM users WHERE is_member = TRUE"),
    // Read-only; a failure here must not take the dashboard down.
    countUnusedImages(pool).catch(() => 0),
  ]);

  res.render("admin/index", {
    active: "overview",
    stats: {
      ordersToday: orders.rows[0].today,
      ordersThisMonth: orders.rows[0].this_month,
      ordersLastMonth: orders.rows[0].last_month,
      salesToday: sales.rows[0].today,
      salesThisMonth: sales.rows[0].this_month,
      salesLastMonth: sales.rows[0].last_month,
      inStockCount: books.rows[0].in_stock,
      booksAddedThisMonth: books.rows[0].added_this_month,
      booksAddedLastMonth: books.rows[0].added_last_month,
      totalAccounts: accounts.rows[0].total,
      newAccountsThisMonth: accounts.rows[0].new_this_month,
      newAccountsLastMonth: accounts.rows[0].new_last_month,
      memberCount: memberCount.rows[0].n,
      unusedImages,
    },
  });
});

// ---------- Orders ----------

router.get("/admin/orders", requireAdmin, async (req, res) => {
  const { rows: orders } = await pool.query(`
    SELECT o.*, (
      SELECT json_agg(json_build_object('title', i.item_title, 'price', i.price) ORDER BY i.id)
      FROM order_items i WHERE i.order_id = o.id
    ) AS items
    FROM orders o ORDER BY o.created_at DESC LIMIT 200`);
  res.render("admin/orders", { active: "orders", orders });
});

module.exports = router;
