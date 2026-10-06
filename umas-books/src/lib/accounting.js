// Accounting export: one row per Paris day, category and payment method, for
// the treasurer. No customer names, emails or order numbers appear anywhere.
// Sources, each counted once:
//   - till sales (till_sale_items of completed sales; voided ones are excluded)
//   - older "Sell in shop" sales (shop_sales rows with no till sale)
//   - paid online orders (status 'paid': refunded/cancelled ones are excluded), HelloAsso
//   - membership payments (HelloAsso)
//   - refunded online orders: the original sale stays on its day, and a NEGATIVE row dated at the
//     refund (same category and method) corrects it in the export of the month the refund happened
//   - over/short from the day closing (till_days.difference_cents), as its own row
// The opening float is a loan to the drawer, never revenue: it appears nowhere here.
// Each row also carries a label (libellé), debit account, credit account and journal from the
// editable table accounting_map (defaults below; page /admin/reports/accounting/mapping).
// A report in the lib/reports.js sense: run(db, ctx) -> { sections, notes }.

const { SITE_TIME_ZONE } = require("./tz");
const TZ = SITE_TIME_ZONE;

const CATEGORY_ORDER = ["Books used", "Books new", "Merchandise", "Refreshments", "Class seats", "Membership", "Donation", "Other"];
const METHOD_ORDER = ["Cash", "Card at the till", "HelloAsso", "Other / not recorded"];

const OVER = "Cash over/short";
const OVER_IN = "Cash over";
const OVER_OUT = "Cash short";

// Defaults, to confirm with the treasurer. Debit: where the money lands; credit: the income account.
const DEBIT_DEFAULT = { Cash: ["530", "CA"], "Card at the till": ["511", "BQ"], HelloAsso: ["511", "BQ"], "Other / not recorded": ["471", "OD"] };
const CREDIT_DEFAULT = {
  "Books used": "707", "Books new": "707", Merchandise: "707", Refreshments: "707", "Class seats": "706", Membership: "756", Donation: "754", Other: "708",
};
function defaultMapping(category, method) {
  if (category === OVER) return method === OVER_IN ? { debit: "530", credit: "758", journal: "OD" } : { debit: "658", credit: "530", journal: "OD" };
  const [debit, journal] = DEBIT_DEFAULT[method] || DEBIT_DEFAULT["Other / not recorded"];
  return { debit, credit: CREDIT_DEFAULT[category] || "708", journal };
}
// Every (category, method) the mapping page lists.
function mappingKeys() {
  const keys = [];
  for (const c of CATEGORY_ORDER) for (const m of METHOD_ORDER) keys.push([c, m]);
  keys.push([OVER, OVER_IN], [OVER, OVER_OUT]);
  return keys;
}
async function loadMapping(db) {
  const { rows } = await db.query("SELECT category, method, debit_account, credit_account, journal FROM accounting_map");
  const stored = new Map(rows.map((r) => [`${r.category}|${r.method}`, r]));
  return mappingKeys().map(([category, method]) => {
    const d = defaultMapping(category, method);
    const r = stored.get(`${category}|${method}`);
    return { category, method, debit: r ? r.debit_account : d.debit, credit: r ? r.credit_account : d.credit, journal: r ? r.journal : d.journal, custom: Boolean(r) };
  });
}
const ACCOUNT_RE = /^[0-9A-Za-z]{1,20}$/;
const JOURNAL_RE = /^[0-9A-Za-z]{1,10}$/;

const FR_CATEGORY = {
  "Books used": "livres d'occasion", "Books new": "livres neufs", Merchandise: "marchandises", Refreshments: "boissons et restauration",
  "Class seats": "places de cours", Membership: "adhésions", Donation: "dons", Other: "autres ventes",
};
const FR_METHOD = { Cash: "espèces", "Card at the till": "carte (caisse)", HelloAsso: "HelloAsso", "Other / not recorded": "mode non enregistré" };
function labelFor(category, method, date, refund) {
  if (category === OVER) return `${method === OVER_IN ? "Écart de caisse en plus" : "Écart de caisse en moins"} ${date}`;
  return `${refund ? "Remboursement" : "Ventes"} ${FR_CATEGORY[category] || category}, ${FR_METHOD[method] || method}, ${date}`;
}

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
       WHERE o.status IN ('paid', 'refunded') AND o.paid_at IS NOT NULL AND ${inRange("o.paid_at", 1, 2)}
       UNION ALL
       SELECT (o.refunded_at AT TIME ZONE '${TZ}')::date,
              CASE WHEN oi.class_dropin_seat_id IS NOT NULL THEN 'Class seats'
                   WHEN oi.book_copy_id IS NOT NULL AND c.condition = 'new' THEN 'Books new'
                   WHEN oi.book_copy_id IS NOT NULL THEN 'Books used' ELSE 'Other' END,
              'HelloAsso', -1, -ROUND(oi.price * 100)::bigint
       FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN book_copies c ON c.id = oi.book_copy_id
       WHERE o.status = 'refunded' AND o.paid_at IS NOT NULL AND o.refunded_at IS NOT NULL AND ${inRange("o.refunded_at", 1, 2)}
       UNION ALL
       SELECT (mp.paid_at AT TIME ZONE '${TZ}')::date, 'Membership', 'HelloAsso', 1, mp.amount_cents::bigint
       FROM membership_payments mp
       WHERE mp.amount_cents IS NOT NULL AND ${inRange("mp.paid_at", 1, 2)}
     )
     SELECT to_char(d, 'YYYY-MM-DD') AS date, category, method, SUM(n)::int AS count, SUM(cents)::bigint AS cents, (SUM(n) < 0) AS refund
     FROM lines GROUP BY d, category, method, (n < 0)`,
    params
  );
  const { rows: diffs } = await db.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS date, difference_cents FROM till_days
     WHERE closed_at IS NOT NULL AND difference_cents IS NOT NULL AND difference_cents <> 0 AND day >= $1::date AND day <= $2::date`, params
  );
  const map = new Map((await loadMapping(db)).map((m) => [`${m.category}|${m.method}`, m]));
  const mapFor = (category, method) => map.get(`${category}|${method}`) || { ...(() => { const d = defaultMapping(category, method); return { debit: d.debit, credit: d.credit, journal: d.journal }; })() };
  const rank = (list, v) => { const i = list.indexOf(v); return i < 0 ? list.length : i; };
  const out = rows
    .map((r) => ({ date: r.date, category: r.category, method: r.method, count: r.count, total: Number(r.cents) / 100, refund: r.refund }))
    .concat(diffs.map((r) => ({
      date: r.date, category: OVER, method: r.difference_cents > 0 ? OVER_IN : OVER_OUT, count: 0, total: r.difference_cents / 100, refund: false,
    })))
    .sort((a, b) => a.date.localeCompare(b.date) || rank(CATEGORY_ORDER, a.category) - rank(CATEGORY_ORDER, b.category) || rank(METHOD_ORDER, a.method) - rank(METHOD_ORDER, b.method) || Number(a.refund) - Number(b.refund))
    .map((r) => {
      const m = mapFor(r.category, r.method);
      return { ...r, label: labelFor(r.category, r.method, r.date, r.refund), debit: m.debit, credit: m.credit, journal: m.journal };
    });
  const totals = {
    date: "Total", category: "", method: "",
    count: out.reduce((a, r) => a + r.count, 0),
    total: Math.round(out.reduce((a, r) => a + Math.round(r.total * 100), 0)) / 100,
  };
  const { rows: nulls } = await db.query(
    `SELECT COUNT(*)::int AS n FROM membership_payments WHERE amount_cents IS NULL AND ${inRange("paid_at", 1, 2)}`, params
  );
  const notes = [
    "Days are Paris days. Voided till sales and cancelled online orders are not included. No customer data appears here.",
    "A refunded online order keeps its row on the day it was paid and gets a NEGATIVE row (negative count and total) on the day it was refunded, so a month already given to the treasurer is corrected in the month of the refund.",
    "A closed day with a cash difference adds one \"Cash over/short\" row (positive: over, negative: short). The opening float is never revenue and is not in this export.",
    "Class seats and Books are paid online through HelloAsso; Membership comes from the HelloAsso membership payments; the till rows are Cash or Card at the till.",
    "Older \"Sell in shop\" sales paid by card are shown as Card at the till; those with no payment method as Other / not recorded.",
    "The label, debit account, credit account and journal come from the table at /admin/reports/accounting/mapping. The defaults are a starting point: ask the treasurer to confirm the account numbers and the import layout.",
  ];
  if (nulls[0].n) notes.push(`${nulls[0].n} membership payment(s) in this period have no amount recorded and are not in the totals.`);
  return {
    sections: [{
      key: "export", title: "Accounting export",
      columns: [
        { key: "date", label: "Date", type: "text" }, { key: "category", label: "Category", type: "text" },
        { key: "method", label: "Payment method", type: "text" }, { key: "count", label: "Count", type: "int" },
        { key: "total", label: "Total (EUR)", type: "eur" },
        { key: "label", label: "Libell\u00e9", type: "text" }, { key: "debit", label: "Compte d\u00e9bit", type: "text" },
        { key: "credit", label: "Compte cr\u00e9dit", type: "text" }, { key: "journal", label: "Journal", type: "text" },
      ],
      rows: out, totals, csvTotals: false, // the CSV is for import: data rows only
    }],
    notes,
  };
}

module.exports = {
  accountingExportReport, loadMapping, defaultMapping, mappingKeys, ACCOUNT_RE, JOURNAL_RE, CATEGORY_ORDER, METHOD_ORDER, OVER, OVER_IN, OVER_OUT,
};
