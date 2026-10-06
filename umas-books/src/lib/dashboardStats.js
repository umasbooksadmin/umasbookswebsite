// Numbers on the admin dashboard (/admin). Sales are PAID orders only
// (refunded, pending, expired and cancelled orders never count), bucketed on
// the day they were PAID in Europe/Paris, like the reports (lib/reports.js):
// an order paid at 00:30 on the 1st in Paris belongs to the new month even
// though it is still the 30th in UTC, which is what the server clock reads.
// `now` is a parameter so tests can fix the clock.

const { SITE_TIME_ZONE } = require("./tz");
const { ORDER_VIEWS } = require("./orderActions");

const TZ = SITE_TIME_ZONE;

async function salesStats(pool, now = new Date()) {
  const { rows } = await pool.query(
    `WITH t AS (
       SELECT date_trunc('day', $1::timestamptz AT TIME ZONE '${TZ}') AS day_start,
              date_trunc('month', $1::timestamptz AT TIME ZONE '${TZ}') AS month_start
     ), paid AS (
       SELECT o.total_amount, o.paid_at AT TIME ZONE '${TZ}' AS at
       FROM orders o WHERE o.status = 'paid' AND o.paid_at IS NOT NULL AND o.paid_at <= $1::timestamptz
     ), refunded AS (
       SELECT o.total_amount, o.refunded_at AT TIME ZONE '${TZ}' AS at
       FROM orders o WHERE o.status = 'refunded' AND o.refunded_at IS NOT NULL AND o.refunded_at <= $1::timestamptz
     )
     SELECT
       (SELECT COUNT(*)::int FROM paid, t WHERE at >= t.day_start) AS orders_today,
       (SELECT COUNT(*)::int FROM paid, t WHERE at >= t.month_start) AS orders_this_month,
       (SELECT COUNT(*)::int FROM paid, t WHERE at >= t.month_start - interval '1 month' AND at < t.month_start) AS orders_last_month,
       (SELECT COALESCE(SUM(total_amount), 0) FROM paid, t WHERE at >= t.day_start) AS sales_today,
       (SELECT COALESCE(SUM(total_amount), 0) FROM paid, t WHERE at >= t.month_start) AS sales_this_month,
       (SELECT COALESCE(SUM(total_amount), 0) FROM paid, t WHERE at >= t.month_start - interval '1 month' AND at < t.month_start) AS sales_last_month,
       (SELECT COUNT(*)::int FROM refunded, t WHERE at >= t.month_start) AS refunds_this_month,
       (SELECT COALESCE(SUM(total_amount), 0) FROM refunded, t WHERE at >= t.month_start) AS refunds_amount_this_month`,
    [now]
  );
  const r = rows[0];
  return {
    ordersToday: r.orders_today, ordersThisMonth: r.orders_this_month, ordersLastMonth: r.orders_last_month,
    // NUMERIC comes back from pg as a string ("0.00"), which is truthy: the view's trend maths needs numbers.
    salesToday: Number(r.sales_today), salesThisMonth: Number(r.sales_this_month), salesLastMonth: Number(r.sales_last_month),
    refundsThisMonth: r.refunds_this_month, refundsAmountThisMonth: Number(r.refunds_amount_this_month),
  };
}

// The "needs attention" box: three counts, each a link target on /admin/orders.
async function attentionCounts(pool) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE ${ORDER_VIEWS.overdue.sql})::int AS overdue,
            COUNT(*) FILTER (WHERE ${ORDER_VIEWS.refund_detected.sql})::int AS refund_detected,
            COUNT(*) FILTER (WHERE ${ORDER_VIEWS.stale_pending.sql})::int AS stale_pending
     FROM orders o WHERE o.status IN ('paid', 'pending')`
  );
  return rows[0];
}

module.exports = { salesStats, attentionCounts };
