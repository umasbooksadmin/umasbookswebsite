// Accounting export: one row per Paris day, category and payment method, for
// the treasurer. No customer names, emails or order numbers appear anywhere.
// Sources, each counted once:
//   - till sales (till_sale_items of completed sales; voided ones are excluded)
//   - older "Sell in shop" sales (shop_sales rows with no till sale)
//   - collected reservations (orders paid in person), counted ONCE:
//       * collected at the till: from their till_sale_items (tagged reservation_order_id), never
//         again from the order;
//       * collected with the admin "Mark collected and paid" button: from the order, under the
//         method the staff chose (orders.payment_method: cash, card, cheque, other);
//       * old orders paid online through HelloAsso (payment_method empty / helloasso / online): HelloAsso
//   - a DISCOUNT given when the staff collected a reservation for less than its list price
//     ("Amount received" below the total): the reservation's lines stay at their list price and ONE negative
//     "Discount" row per day and method carries the difference, so the export of that order is exactly
//     what was received (cash or card). Refunding such an order reverses what was RECEIVED: the list-price
//     lines are reversed and the discount row is reversed (a positive "Discount" refund row) on the refund day.
//     Orders without a discount produce no discount row at all.
//   - membership payments (HelloAsso); one refunded or lost in a dispute keeps its row on the day it was paid and
//     gets a NEGATIVE Membership row (a refund row, same wording as the other refunds) on the day the reversal was
//     seen (membership_payments.reversed_at), exactly like a refunded reservation
//   - refunded reservations: the original sale stays on its day, and a NEGATIVE row dated at the
//     refund (same category as the sale) corrects it in the export of the month the refund happened.
//     The refund row's METHOD is how the money was given back (orders.refund_method, migration 095):
//     cash from the drawer -> Cash (530), card refund on the terminal -> Card at the till, bank transfer
//     -> Bank transfer, other -> Other / not recorded. So a card sale refunded in cash lowers Cash, exactly
//     like the drawer count (lib/till.js daySummary). Only a refund with no recorded method (every refund
//     made before migration 095) falls back to the sale's own method, as before.
//   - over/short from the day closing (till_days.difference_cents), as its own row
// The opening float is a loan to the drawer, never revenue: it appears nowhere here.
// Each row also carries a label (libellé), debit account, credit account and journal from the
// editable table accounting_map (defaults below; page /admin/reports/accounting/mapping).
// A report in the lib/reports.js sense: run(db, ctx) -> { sections, notes }.

const { SITE_TIME_ZONE } = require("./tz");
const TZ = SITE_TIME_ZONE;

const CATEGORY_ORDER = ["Books used", "Books new", "Merchandise", "Refreshments", "Class seats", "Membership", "Donation", "Other", "Discount"];
// "Bank transfer" only ever appears on refund rows (a refund paid by transfer): nothing is SOLD by transfer.
const TRANSFER = "Bank transfer";
const METHOD_ORDER = ["Cash", "Card at the till", "Cheque", "HelloAsso", TRANSFER, "Other / not recorded"];

const OVER = "Cash over/short";
const OVER_IN = "Cash over";
const OVER_OUT = "Cash short";
const DISCOUNT = "Discount";

// Defaults, to confirm with the treasurer. Debit: where the money lands; credit: the income account.
// A refund paid by bank transfer leaves the bank: by default the same bank-side account and journal as the other
// bank methods (511, BQ); the treasurer may prefer 512 (Banque) and can change it on the mapping page.
const DEBIT_DEFAULT = {
  Cash: ["530", "CA"], "Card at the till": ["511", "BQ"], Cheque: ["511", "BQ"], HelloAsso: ["511", "BQ"], [TRANSFER]: ["511", "BQ"], "Other / not recorded": ["471", "OD"],
};
const CREDIT_DEFAULT = {
  "Books used": "707", "Books new": "707", Merchandise: "707", Refreshments: "707", "Class seats": "706", Membership: "756", Donation: "754", Other: "708",
  // 709 = rabais, remises et ristournes accordes. The discount row is NEGATIVE, so the income stays at list price in 707
  // and 709 carries the reduction; the cash or bank debit nets to what was really received. Confirm with the treasurer.
  Discount: "709",
};
function defaultMapping(category, method) {
  if (category === OVER) return method === OVER_IN ? { debit: "530", credit: "758", journal: "OD" } : { debit: "658", credit: "530", journal: "OD" };
  const [debit, journal] = DEBIT_DEFAULT[method] || DEBIT_DEFAULT["Other / not recorded"];
  return { debit, credit: CREDIT_DEFAULT[category] || "708", journal };
}
// Every (category, method) the mapping page lists.
function mappingKeys() {
  const keys = [];
  // A discount is only ever given when collecting a reservation in person, never online (HelloAsso).
  for (const c of CATEGORY_ORDER) for (const m of METHOD_ORDER) if (!(c === DISCOUNT && m === "HelloAsso")) keys.push([c, m]);
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
  "Class seats": "places de cours", Membership: "adhésions", Donation: "dons", Other: "autres ventes", Discount: "remises",
};
const FR_METHOD = { Cash: "espèces", "Card at the till": "carte (caisse)", Cheque: "chèque", HelloAsso: "HelloAsso", [TRANSFER]: "virement", "Other / not recorded": "mode non enregistré" };
function labelFor(category, method, date, refund) {
  if (category === OVER) return `${method === OVER_IN ? "Écart de caisse en plus" : "Écart de caisse en moins"} ${date}`;
  if (category === DISCOUNT) return `${refund ? "Annulation de remise au retrait d'une réservation" : "Remise accordée au retrait d'une réservation"}, ${FR_METHOD[method] || method}, ${date}`;
  return `${refund ? "Remboursement" : "Ventes"} ${FR_CATEGORY[category] || category}, ${FR_METHOD[method] || method}, ${date}`;
}

const inRange = (col, a, b) =>
  `${col} >= ($${a}::date)::timestamp AT TIME ZONE '${TZ}' AND ${col} < (($${b}::date) + 1)::timestamp AT TIME ZONE '${TZ}'`;

const METHOD_SQL = (col) => `CASE ${col} WHEN 'cash' THEN 'Cash' WHEN 'card' THEN 'Card at the till' ELSE 'Other / not recorded' END`;
// How an ORDER was paid. Reservations are paid in person, so the staff's choice is the method;
// an order with no method (or helloasso / online) is an old online-checkout order: HelloAsso.
// An unknown value is "Other / not recorded" (account 471), never silently HelloAsso.
const ORDER_METHOD_SQL = `CASE WHEN o.payment_method IS NULL OR o.payment_method IN ('helloasso', 'online') THEN 'HelloAsso'
  WHEN o.payment_method = 'cash' THEN 'Cash' WHEN o.payment_method = 'card' THEN 'Card at the till'
  WHEN o.payment_method = 'cheque' THEN 'Cheque' ELSE 'Other / not recorded' END`;
// How a reservation REFUND was paid out (orders.refund_method), as an export method; `fallback` (the sale's own
// method) only when no refund method was recorded (refunds made before migration 095).
const REFUND_METHOD_SQL = (fallback) => `CASE o.refund_method WHEN 'cash' THEN 'Cash' WHEN 'card' THEN 'Card at the till'
  WHEN 'transfer' THEN '${TRANSFER}' WHEN 'other' THEN 'Other / not recorded' ELSE ${fallback} END`;
// Orders collected at the till are counted from the till's own lines (exactly once).
const TILL_COLLECTED = "EXISTS (SELECT 1 FROM till_sale_items ti WHERE ti.reservation_order_id = o.id)";
const CATEGORY_SQL = `CASE i.category WHEN 'books_used' THEN 'Books used' WHEN 'books_new' THEN 'Books new' WHEN 'merchandise' THEN 'Merchandise'
  WHEN 'refreshments' THEN 'Refreshments' WHEN 'donation' THEN 'Donation' WHEN 'class_seats' THEN 'Class seats' ELSE 'Other' END`;

// Orders collected for LESS than the list price of their lines (the "Amount received" discount of
// "Mark collected and paid"): { id, status, paid_at, refunded_at, method, refund_method (how a refund was paid
// out, as an export method; the sale's method when not recorded), cents = list price - received }.
// Only orders that record the discount (reserved_total and amount_received set by collectReservationTx)
// and were not collected at the till; whole cents on both sides, so no rounding drift for any number of lines.
const DISCOUNT_ORDERS_SQL = `SELECT o.id, o.status, o.paid_at, o.refunded_at, ${ORDER_METHOD_SQL} AS method, ${REFUND_METHOD_SQL(ORDER_METHOD_SQL)} AS refund_method,
         (SUM(ROUND(oi.price * 100))::bigint - ROUND(o.total_amount * 100)::bigint) AS cents
       FROM orders o JOIN order_items oi ON oi.order_id = o.id
       WHERE o.status IN ('paid', 'refunded') AND o.paid_at IS NOT NULL AND o.reserved_total IS NOT NULL
         AND o.amount_received IS NOT NULL AND NOT ${TILL_COLLECTED}
       GROUP BY o.id HAVING SUM(ROUND(oi.price * 100)) > ROUND(o.total_amount * 100)`;

const rank = (list, v) => { const i = list.indexOf(v); return i < 0 ? list.length : i; };

// The lines of the export for a Paris date range, before the account mapping:
// [{ date, category, method, count, cents, total (euros), refund }], sorted. The ONE place
// that decides what counts as a sale: the Accounting export, the Dashboard's "Sales this
// month" and the end-of-day figures all come from these lines (see salesTotals below).
async function accountingRows(db, from, to) {
  const params = [from, to];
  const { rows } = await db.query(
    `WITH disc AS (${DISCOUNT_ORDERS_SQL}), lines AS (
       SELECT (s.created_at AT TIME ZONE '${TZ}')::date AS d, ${CATEGORY_SQL} AS category, ${METHOD_SQL("s.payment_method")} AS method,
              i.quantity::int AS n, (i.quantity * i.unit_price_cents)::bigint AS cents, false AS rf
       FROM till_sale_items i JOIN till_sales s ON s.id = i.sale_id
       WHERE s.status = 'completed' AND ${inRange("s.created_at", 1, 2)}
       UNION ALL
       SELECT (ss.sold_at AT TIME ZONE '${TZ}')::date, CASE WHEN c.condition = 'new' THEN 'Books new' ELSE 'Books used' END, ${METHOD_SQL("ss.payment_method")},
              1, ROUND(ss.price * 100)::bigint, false
       FROM shop_sales ss JOIN book_copies c ON c.id = ss.copy_id
       WHERE ss.till_sale_id IS NULL AND ${inRange("ss.sold_at", 1, 2)}
       UNION ALL
       SELECT (o.paid_at AT TIME ZONE '${TZ}')::date,
              CASE WHEN oi.class_dropin_seat_id IS NOT NULL THEN 'Class seats'
                   WHEN oi.book_copy_id IS NOT NULL AND c.condition = 'new' THEN 'Books new'
                   WHEN oi.book_copy_id IS NOT NULL THEN 'Books used' ELSE 'Other' END,
              ${ORDER_METHOD_SQL}, 1, ROUND(oi.price * 100)::bigint, false
       FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN book_copies c ON c.id = oi.book_copy_id
       WHERE o.status IN ('paid', 'refunded') AND o.paid_at IS NOT NULL AND NOT ${TILL_COLLECTED} AND ${inRange("o.paid_at", 1, 2)}
       UNION ALL
       SELECT (o.refunded_at AT TIME ZONE '${TZ}')::date,
              CASE WHEN oi.class_dropin_seat_id IS NOT NULL THEN 'Class seats'
                   WHEN oi.book_copy_id IS NOT NULL AND c.condition = 'new' THEN 'Books new'
                   WHEN oi.book_copy_id IS NOT NULL THEN 'Books used' ELSE 'Other' END,
              ${REFUND_METHOD_SQL(ORDER_METHOD_SQL)}, -1, -ROUND(oi.price * 100)::bigint, true
       FROM order_items oi JOIN orders o ON o.id = oi.order_id LEFT JOIN book_copies c ON c.id = oi.book_copy_id
       WHERE o.status = 'refunded' AND o.paid_at IS NOT NULL AND o.refunded_at IS NOT NULL AND NOT ${TILL_COLLECTED} AND ${inRange("o.refunded_at", 1, 2)}
       UNION ALL
       -- a refunded reservation that was collected at the till: the sale is already a till row, so only the
       -- reversal is added here, from the same till lines (same category), on the refund day, under the method the
       -- refund was paid out with (the till sale's method only when none was recorded)
       SELECT (o.refunded_at AT TIME ZONE '${TZ}')::date, ${CATEGORY_SQL}, ${REFUND_METHOD_SQL(METHOD_SQL("s.payment_method"))},
              -i.quantity::int, -(i.quantity * i.unit_price_cents)::bigint, true
       FROM till_sale_items i JOIN till_sales s ON s.id = i.sale_id JOIN orders o ON o.id = i.reservation_order_id
       WHERE s.status = 'completed' AND o.status = 'refunded' AND o.refunded_at IS NOT NULL AND ${inRange("o.refunded_at", 1, 2)}
       UNION ALL
       SELECT (mp.paid_at AT TIME ZONE '${TZ}')::date, 'Membership', 'HelloAsso', 1, mp.amount_cents::bigint, false
       FROM membership_payments mp
       WHERE mp.amount_cents IS NOT NULL AND ${inRange("mp.paid_at", 1, 2)}
       UNION ALL
       -- a membership payment HelloAsso later refunded (or lost in a dispute): the payment keeps its row on the day
       -- it was paid (a month already exported never changes) and a NEGATIVE row, same category and method, is dated
       -- the day we saw the reversal (membership_payments.reversed_at, set once by lib/membership.js)
       SELECT (mp.reversed_at AT TIME ZONE '${TZ}')::date, 'Membership', 'HelloAsso', -1, -mp.reversed_amount_cents::bigint, true
       FROM membership_payments mp
       WHERE mp.reversed_at IS NOT NULL AND mp.reversed_amount_cents IS NOT NULL AND ${inRange("mp.reversed_at", 1, 2)}
       UNION ALL
       -- the discount given at pickup (list price of the lines minus what was received), one negative amount per order
       -- on the day it was paid, reversed (positive, a refund row) on the day the reservation was refunded, under the
       -- refund's method like the reversed lines, so the refund nets to what was received
       SELECT (disc.paid_at AT TIME ZONE '${TZ}')::date, '${DISCOUNT}', disc.method, 0, -disc.cents, false
       FROM disc WHERE ${inRange("disc.paid_at", 1, 2)}
       UNION ALL
       SELECT (disc.refunded_at AT TIME ZONE '${TZ}')::date, '${DISCOUNT}', disc.refund_method, 0, disc.cents, true
       FROM disc WHERE disc.status = 'refunded' AND disc.refunded_at IS NOT NULL AND ${inRange("disc.refunded_at", 1, 2)}
     )
     SELECT to_char(d, 'YYYY-MM-DD') AS date, category, method, SUM(n)::int AS count, SUM(cents)::bigint AS cents, rf AS refund
     FROM lines GROUP BY d, category, method, rf`,
    params
  );
  const { rows: diffs } = await db.query(
    `SELECT to_char(day, 'YYYY-MM-DD') AS date, difference_cents FROM till_days
     WHERE closed_at IS NOT NULL AND difference_cents IS NOT NULL AND difference_cents <> 0 AND day >= $1::date AND day <= $2::date`, params
  );
  return rows
    .map((r) => ({ date: r.date, category: r.category, method: r.method, count: r.count, cents: Number(r.cents), total: Number(r.cents) / 100, refund: r.refund }))
    .concat(diffs.map((r) => ({
      date: r.date, category: OVER, method: r.difference_cents > 0 ? OVER_IN : OVER_OUT, count: 0, cents: r.difference_cents, total: r.difference_cents / 100, refund: false,
    })))
    .sort((a, b) => a.date.localeCompare(b.date) || rank(CATEGORY_ORDER, a.category) - rank(CATEGORY_ORDER, b.category) || rank(METHOD_ORDER, a.method) - rank(METHOD_ORDER, b.method) || Number(a.refund) - Number(b.refund));
}

// Totals for a range, in CENTS, split the way the Dashboard shows them (refunds are the
// export's negative rows, so they are netted in; voided till sales are not in it at all):
//   membership = the Membership category; online = the other HelloAsso rows (old orders paid
//   online before reservations); till = everything taken in person (cash, card, cheque, reservations
//   collected at the till or with the admin button, older shop sales, cash over/short).
async function salesTotals(db, from, to) {
  const rows = await accountingRows(db, from, to);
  const t = { totalCents: 0, tillCents: 0, onlineCents: 0, membershipCents: 0 };
  for (const r of rows) {
    t.totalCents += r.cents;
    if (r.category === "Membership") t.membershipCents += r.cents;
    else if (r.method === "HelloAsso") t.onlineCents += r.cents;
    else t.tillCents += r.cents;
  }
  return t;
}

async function accountingExportReport(db, ctx) {
  const params = [ctx.from, ctx.to];
  const base = await accountingRows(db, ctx.from, ctx.to);
  const map = new Map((await loadMapping(db)).map((m) => [`${m.category}|${m.method}`, m]));
  const mapFor = (category, method) => map.get(`${category}|${method}`) || { ...(() => { const d = defaultMapping(category, method); return { debit: d.debit, credit: d.credit, journal: d.journal }; })() };
  const out = base
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
    "Days are Paris days. Voided till sales and cancelled reservations are not included. No customer data appears here.",
    "A refunded reservation keeps its row on the day it was paid and gets a NEGATIVE row (negative count and total) on the day it was refunded, so a month already given to the treasurer is corrected in the month of the refund.",
    "The negative refund row is under the way the money was GIVEN BACK, as recorded with \"Mark refunded\": cash from the till drawer is Cash, a card refund on the terminal is Card at the till, a bank transfer is Bank transfer, anything else is Other / not recorded. So a card sale refunded in cash lowers Cash (as the drawer count does), not Card. A refund recorded before the method was asked keeps the method of the sale.",
    "A reservation collected for less than its list price (a discount given at pickup) keeps its lines at the list price and adds one NEGATIVE \"Discount\" row per day and payment method (credit account 709 by default), so the export of that reservation is exactly what was received. If it is refunded, the refund reverses what was received: the lines are reversed and the discount row is reversed too (a positive Discount refund row) on the refund day.",
    "A closed day with a cash difference adds one \"Cash over/short\" row (positive: over, negative: short). The opening float is never revenue and is not in this export.",
    "Books and class seats are reserved on the website and paid IN PERSON: a reservation collected at the till is counted once, from the till, and one collected with \"Mark collected and paid\" is counted under the method the staff chose (Cash, Card at the till, Cheque, or Other / not recorded). Only Membership comes from HelloAsso (the membership payments); a HelloAsso row for books is an old order paid online before reservations existed.",
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
  accountingExportReport, accountingRows, salesTotals, loadMapping, defaultMapping, mappingKeys, ACCOUNT_RE, JOURNAL_RE, CATEGORY_ORDER, METHOD_ORDER, OVER, OVER_IN, OVER_OUT, DISCOUNT, TRANSFER, DISCOUNT_ORDERS_SQL, TILL_COLLECTED,
};
