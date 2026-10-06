// Accounting export: one row per Paris day, category and payment method, for
// the treasurer. No customer names, emails or order numbers appear anywhere.
// Sources, each counted once:
//   - till sales (till_sale_items of completed sales; voided ones are excluded)
//   - older "Sell in shop" sales (shop_sales rows with no till sale)
//   - paid online orders (status 'paid': refunded/cancelled ones are excluded), HelloAsso
//   - membership payments (HelloAsso)
// A report in the lib/reports.js sense: run(db, ctx) -> { sections, notes }.

const { SITE_TIME_ZONE } = require("./tz");
const TZ = SITE_TIME_ZONE;

const CATEGORY_ORDER = ["Books used", "Books new", "Merchandise", "Refreshments", "Class seats", "Membership", "Donation", "Other"];
const METHOD_ORDER = ["Cash", "Card at the till", "HelloAsso", "Other / not recorded"];

const inRange = (col, a, b) =>
  `${col} >= ($${a}::date)::timestamp AT TIME ZONE '${TZ}' AND ${col} < (($${b}::date) + 1)::timestamp AT TIME ZONE '${TZ}'`;

const METHOD_SQL = (col) => `CASE ${col} WHEN 'cash' THEN 'Cash' WHEN 'card' THEN 'Card at the till' ELSE 'Other / not recorded' END`;
const CATEGORY_SQL = `CASE i.category WHEN 'books_used' THEN 'Books used' WHEN 'books_new' THEN 'Books new' WHEN 'merchandise' THEN 'Merchandise'
  WHEN 'refreshments' THEN 'Refreshments' WHEN 'donation' THEN 'Donation' ELSE 'Other' END`;

async function accountingExportReport(db, ctx) {
  const params = [ctx.from, ctx.to];
  const { rows } = await db.query(
    `WITH lines AS (
       SELECT (s.created_at AT TIME ZONE '${TZ}')::date AS d, ${CATEGORY_SQL} AS category, ${METHOD_SQL("s.payment_method")} AS method,
              i.quantity::int AS n, (i.quantity * i.unit_price_cents)::bigint AS cents
       FROM till_sale_items i JOIN till_sales s ON s.id = i.sale_id
       WHERE s.status = 'completed' AND ${inRange("s.created_at", 1, 2)}
       UNION ALL
       SELECT (ss.sold_at AT TIME ZONE '${TZ}')::date, CASE WHEN c.condition = 'new' THEN 'Books new' ELSE 'Books used' END, ${METHOD_SQL("ss.payment_method")},
              1, ROUND(ss.price * 100)::bigint
       FROM shop_sales ss JOIN book_copies c ON c.id = ss.copy_id
       WHERE ss.till_sale_id IS NULL AND ${inRange("ss.sold_at", 1, 2)}
       UNION ALL
       SELECT (o.paid_at AT TIME ZONE '${TZ}')::date,
              CASE WHEN oi.class_dropin_seat_id IS NOT NULL THEN 'Class seats'
                   WHEN oi.book_copy_id IS NOT NULL AND c.condition = 'new' THEN 'Books new'
                   WHEN oi.book_copy_id IS NOT NULL THEN 'Books used' ELSE 'Other' END,
              'HelloAsso', 1, ROUND(oi.price * 100)::bigint
       FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN book_copies c ON c.id = oi.book_copy_id
       WHERE o.status = 'paid' AND o.paid_at IS NOT NULL AND ${inRange("o.paid_at", 1, 2)}
       UNION ALL
       SELECT (mp.paid_at AT TIME ZONE '${TZ}')::date, 'Membership', 'HelloAsso', 1, mp.amount_cents::bigint
       FROM membership_payments mp
       WHERE mp.amount_cents IS NOT NULL AND ${inRange("mp.paid_at", 1, 2)}
     )
     SELECT to_char(d, 'YYYY-MM-DD') AS date, category, method, SUM(n)::int AS count, SUM(cents)::bigint AS cents
     FROM lines GROUP BY d, category, method`,
    params
  );
  const rank = (list, v) => { const i = list.indexOf(v); return i < 0 ? list.length : i; };
  const out = rows
    .map((r) => ({ date: r.date, category: r.category, method: r.method, count: r.count, total: Number(r.cents) / 100 }))
    .sort((a, b) => a.date.localeCompare(b.date) || rank(CATEGORY_ORDER, a.category) - rank(CATEGORY_ORDER, b.category) || rank(METHOD_ORDER, a.method) - rank(METHOD_ORDER, b.method));
  const totals = {
    date: "Total", category: "", method: "",
    count: out.reduce((a, r) => a + r.count, 0),
    total: Math.round(out.reduce((a, r) => a + Math.round(r.total * 100), 0)) / 100,
  };
  const { rows: nulls } = await db.query(
    `SELECT COUNT(*)::int AS n FROM membership_payments WHERE amount_cents IS NULL AND ${inRange("paid_at", 1, 2)}`, params
  );
  const notes = [
    "Days are Paris days. Voided till sales, refunded or cancelled online orders are not included. No customer data appears here.",
    "Class seats and Books are paid online through HelloAsso; Membership comes from the HelloAsso membership payments; the till rows are Cash or Card at the till.",
    "Older \"Sell in shop\" sales paid by card are shown as Card at the till; those with no payment method as Other / not recorded.",
  ];
  if (nulls[0].n) notes.push(`${nulls[0].n} membership payment(s) in this period have no amount recorded and are not in the totals.`);
  return {
    sections: [{
      key: "export", title: "Accounting export",
      columns: [
        { key: "date", label: "Date", type: "text" }, { key: "category", label: "Category", type: "text" },
        { key: "method", label: "Payment method", type: "text" }, { key: "count", label: "Count", type: "int" },
        { key: "total", label: "Total (EUR)", type: "eur" },
      ],
      rows: out, totals, csvTotals: false, // the CSV is for import: data rows only
    }],
    notes,
  };
}

module.exports = { accountingExportReport, CATEGORY_ORDER, METHOD_ORDER };
