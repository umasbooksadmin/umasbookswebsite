// Numbers on the admin dashboard (/admin). The ORDER counts are PAID orders only
// (reserved, refunded, pending, expired and cancelled orders never count: a
// reservation becomes a sale when it is collected and paid in the shop), bucketed on
// the day they were PAID in Europe/Paris, like the reports (lib/reports.js):
// an order paid at 00:30 on the 1st in Paris belongs to the new month even
// though it is still the 30th in UTC, which is what the server clock reads.
// The SALES figures ("Sales this month") are the accounting export's own total
// (lib/accounting.js salesTotals: till sales, older shop sales, paid online orders,
// membership payments and non-book items, minus voids and refunds), so the
// Dashboard, Reports, End of day and the export can never disagree.
// `now` is a parameter so tests can fix the clock.

const { SITE_TIME_ZONE } = require("./tz");
const { ORDER_VIEWS } = require("./orderActions");
const { salesTotals } = require("./accounting");

const TZ = SITE_TIME_ZONE;

// Paris dates (YYYY-MM-DD) around `now`: today, the first of this month, and last month's
// first and last day.
async function parisRanges(pool, now) {
  const { rows } = await pool.query(
    `WITH t AS (SELECT ($1::timestamptz AT TIME ZONE '${TZ}')::date AS today)
     SELECT today::text AS today, date_trunc('month', today)::date::text AS month_start,
            (date_trunc('month', today) - interval '1 month')::date::text AS last_start,
            (date_trunc('month', today)::date - 1)::text AS last_end FROM t`,
    [now]
  );
  return rows[0];
}

async function salesStats(pool, now = new Date()) {
  const ranges = await parisRanges(pool, now);
  const [today, month, last] = [
    await salesTotals(pool, ranges.today, ranges.today),
    await salesTotals(pool, ranges.month_start, ranges.today),
    await salesTotals(pool, ranges.last_start, ranges.last_end),
  ];
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
       (SELECT COUNT(*)::int FROM refunded, t WHERE at >= t.month_start) AS refunds_this_month,
       (SELECT COALESCE(SUM(total_amount), 0) FROM refunded, t WHERE at >= t.month_start) AS refunds_amount_this_month`,
    [now]
  );
  const r = rows[0];
  return {
    ordersToday: r.orders_today, ordersThisMonth: r.orders_this_month, ordersLastMonth: r.orders_last_month,
    // Euros (numbers: the view's trend maths needs numbers), from the accounting export's lines.
    salesToday: today.totalCents / 100, salesThisMonth: month.totalCents / 100, salesLastMonth: last.totalCents / 100,
    salesBreakdown: { till: month.tillCents / 100, online: month.onlineCents / 100, membership: month.membershipCents / 100 },
    refundsThisMonth: r.refunds_this_month, refundsAmountThisMonth: Number(r.refunds_amount_this_month),
  };
}

// The "needs attention" box: counts, each a link target on /admin/orders.
// Reservations expiring within 3 days, and reservations already past their
// deadline that nobody collected (released automatically soon), plus the old
// online-checkout leftovers.
async function attentionCounts(pool) {
  const { rows } = await pool.query(
    `SELECT COUNT(*) FILTER (WHERE ${ORDER_VIEWS.expiring_soon.sql})::int AS expiring_soon,
            COUNT(*) FILTER (WHERE ${ORDER_VIEWS.past_deadline.sql})::int AS past_deadline,
            COUNT(*) FILTER (WHERE ${ORDER_VIEWS.overdue.sql})::int AS overdue,
            COUNT(*) FILTER (WHERE ${ORDER_VIEWS.stale_pending.sql})::int AS stale_pending
     FROM orders o WHERE o.status IN ('reserved', 'paid', 'pending')`
  );
  return rows[0];
}

module.exports = { salesStats, attentionCounts };
