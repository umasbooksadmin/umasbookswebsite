// Admin Reports (/admin/reports). Everything here only READS the database:
// each report is a handful of aggregate queries (never one query per book),
// every list has a LIMIT, and nothing returns an email address or a buyer's
// name (the one exception is the Accounts report, the admins' list of who has
// an account, which shows names and emails; see accountsReport). Dates are Europe/Paris days (see lib/tz.js): a range "2026-01-01 to
// 2026-01-31" means from midnight Paris on the 1st to midnight Paris on the
// 1st of February, whatever time zone the server runs in.
//
// A report's run(db, ctx) takes anything with a pg-style .query() (the pool in
// the app, a client in tests) and returns { sections, notes }. A section is
// { key, title, columns: [{ key, label, type }], rows, totals, note }, shown as
// a table on the page and exported by toCsv().

const { SITE_TIME_ZONE, parisPlusDaysSql } = require("./tz");
const { CONDITIONS, SOURCES } = require("./inventory");
const { TYPE_LABELS, parseTypeFilter, typeFilterSql, typeCaseSql } = require("./accountTypes");
const { activeMemberSql } = require("./memberStatus");
const { likeContains, parseIntParam } = require("./parseParams");

const TZ = SITE_TIME_ZONE;
const LIST_LIMIT = 500;
const INTAKE_LATEST = 50;
const GROUPS = ["day", "week", "month", "year"];

// ---------- dates ----------

const pad2 = (n) => String(n).padStart(2, "0");
const isoDay = (y, m, d) => `${String(y).padStart(4, "0")}-${pad2(m)}-${pad2(d)}`;

// "YYYY-MM-DD" only if it is a real calendar day (not 2026-02-31).
function validDay(value) {
  const m = typeof value === "string" ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(value) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  return m[0];
}

// Today's date in Paris as YYYY-MM-DD.
function todayParis(now = new Date()) {
  return now.toLocaleDateString("en-CA", { timeZone: TZ });
}

// n calendar months before a day; the day is clamped to the end of a shorter
// month (31 March minus 1 month is 28/29 February).
function subMonths(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const total = y * 12 + (m - 1) - n;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  const last = new Date(Date.UTC(ny, nm, 0)).getUTCDate();
  return isoDay(ny, nm, Math.min(d, last));
}

function addDays(day, n) {
  const [y, m, d] = day.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + n));
  return isoDay(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

// ?from=&to= as two Paris days, default the last 12 months up to today. An
// invalid or missing value falls back to its default; from after to are
// swapped.
function parseDateRange(query = {}, now = new Date()) {
  const today = todayParis(now);
  let to = validDay(query.to) || today;
  let from = validDay(query.from) || subMonths(to, 12);
  if (from > to) [from, to] = [to, from];
  return { from, to };
}

function parseGroup(value) {
  return GROUPS.includes(value) ? value : "month";
}

// Where the aging buckets split, as days: a copy acquired on or before
// `m12` is 12+ months old, after `m3` it is under 3 months old, and so on.
function agingCutoffs(today) {
  return { m3: subMonths(today, 3), m6: subMonths(today, 6), m12: subMonths(today, 12) };
}

// The age bucket of a copy acquired on `day` (YYYY-MM-DD), for tests and
// anywhere a single copy needs placing; the SQL uses the same cutoffs.
function agingBucket(day, today) {
  const c = agingCutoffs(today);
  if (day > c.m3) return "0-3";
  if (day > c.m6) return "3-6";
  if (day > c.m12) return "6-12";
  return "12+";
}

// ---------- number / cell formatting ----------

const money = (n) => Math.round(Number(n || 0) * 100) / 100;

function formatCell(value, type, { csv = false } = {}) {
  if (value === null || value === undefined || value === "") return "";
  switch (type) {
    case "int": return String(Math.round(Number(value)));
    case "usd": return csv ? Number(value).toFixed(4) : `$${Number(value).toFixed(4)}`;
    case "eur4": return csv ? Number(value).toFixed(4) : `€${Number(value).toFixed(4)}`;
    case "eur": return csv ? Number(value).toFixed(2) : `€${Number(value).toFixed(2)}`;
    case "pct": return Number(value).toFixed(1) + (csv ? "" : "%");
    case "dec1": return Number(value).toFixed(1);
    default: return String(value);
  }
}

// ---------- CSV ----------

// THE CSV FORMAT (every CSV the system produces, since 2026-10-30): "|" between
// values, NO text qualifier (no quote marks anywhere, header included), a decimal
// POINT in money and numbers (8.00), UTF-8 BOM (so Excel shows accents) and CRLF
// line ends. Open in Excel with Data > From Text/CSV, Delimiter: Custom, |.
// Because there is no quoting, a value must never contain the delimiter or a line
// break, and Excel's From Text/CSV treats a double quote as a qualifier: csvCell() turns
// "|" into "/", any double quote (straight or typographic) into an apostrophe, and any
// run of CR / LF / tab into one space.
// Spreadsheet formula protection is kept: a text cell that starts with = + - @
// (or a tab / CR, or those after leading whitespace) gets a leading apostrophe so
// it stays plain text. Numbers are written bare.
const CSV_SEP = "|";
function csvCell(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const raw = String(value);
  let s = raw.replace(/\|/g, "/").replace(/["\u201C\u201D\u201E]/g, "'").replace(/[\r\n\t]+/g, " ");
  if (/^[=+\-@\t\r]/.test(raw) || /^\s*[=+\-@]/.test(s)) s = `'${s}`;
  return s;
}

// Kept for old bookmarks: ?locale=fr and ?format=csv-fr are still accepted but
// give the same pipe file as every other download.
const wantsFrenchCsv = (query = {}) => query.locale === "fr" || query.format === "csv-fr";

// A section as CSV text: header row, data rows, then the totals row (BOM first, CRLF).
function toCsv(section) {
  const lines = [section.columns.map((c) => csvCell(c.label)).join(CSV_SEP)];
  const asRow = (row) => section.columns.map((c) => {
    const cell = formatCell(row[c.key], c.type, { csv: true });
    return c.type === "text" || c.type === "date" ? csvCell(cell) : cell;
  }).join(CSV_SEP);
  for (const row of section.rows) lines.push(asRow(row));
  if (section.totals && section.csvTotals !== false) lines.push(asRow(section.totals));
  return "\uFEFF" + lines.join("\r\n") + "\r\n";
}

// ---------- SQL pieces ----------

// A copy's acquisition day: the date typed at intake, else the day it was added.
const COPY_DAY = `COALESCE(c.acquired_at, (c.created_at AT TIME ZONE '${TZ}')::date)`;
// First genre of books.categories ("Fantasy, Fiction" -> "Fantasy").
const GENRE = `COALESCE(NULLIF(btrim(split_part(b.categories, ',', 1)), ''), '(no genre)')`;
// A timestamp range [from midnight Paris, midnight Paris after `to`) for params $a and $b.
const inRange = (col, a, b) =>
  `${col} >= ($${a}::date)::timestamp AT TIME ZONE '${TZ}' AND ${col} < (($${b}::date) + 1)::timestamp AT TIME ZONE '${TZ}'`;

const conditionLabel = (v) => (CONDITIONS.find((c) => c.value === v) || {}).label || v;
const sourceLabel = (v) => (SOURCES.find((s) => s.value === v) || {}).label || "(unknown)";

function sumRows(rows, keys) {
  const t = {};
  for (const k of keys) t[k] = money(rows.reduce((a, r) => a + Number(r[k] || 0), 0));
  return t;
}

// ---------- 1. inventory ----------

async function inventoryBy(db, { groupExpr, labelExpr, labelAgg, mapLabel = (x) => x, title, key, firstLabel }) {
  const { rows } = await db.query(
    `SELECT ${labelAgg || `MIN((${labelExpr}) COLLATE "C")`} AS label,
            COUNT(*) FILTER (WHERE c.status = 'in_stock')::int AS in_stock_count,
            COALESCE(SUM(c.price) FILTER (WHERE c.status = 'in_stock'), 0)::float8 AS in_stock_value,
            COUNT(*) FILTER (WHERE c.status = 'reserved')::int AS reserved_count,
            COALESCE(SUM(c.price) FILTER (WHERE c.status = 'reserved'), 0)::float8 AS reserved_value
     FROM book_copies c JOIN books b ON b.id = c.book_id
     WHERE c.status = ANY($1)
     GROUP BY ${groupExpr}`,
    [["in_stock", "reserved"]]
  );
  const out = rows.map((r) => ({
    label: mapLabel(r.label),
    in_stock_count: r.in_stock_count, in_stock_value: money(r.in_stock_value),
    reserved_count: r.reserved_count, reserved_value: money(r.reserved_value),
    total_count: r.in_stock_count + r.reserved_count, total_value: money(r.in_stock_value + r.reserved_value),
  }));
  out.sort((a, b) => b.total_count - a.total_count || String(a.label).localeCompare(String(b.label)));
  return {
    key, title,
    columns: [
      { key: "label", label: firstLabel, type: "text" },
      { key: "in_stock_count", label: "In stock", type: "int" },
      { key: "in_stock_value", label: "In stock value", type: "eur" },
      { key: "reserved_count", label: "Reserved", type: "int" },
      { key: "reserved_value", label: "Reserved value", type: "eur" },
      { key: "total_count", label: "Total copies", type: "int" },
      { key: "total_value", label: "Total value", type: "eur" },
    ],
    rows: out,
    totals: { label: "Total", ...sumRows(out, ["in_stock_count", "in_stock_value", "reserved_count", "reserved_value", "total_count", "total_value"]) },
  };
}

async function inventoryReport(db) {
  const sections = await Promise.all([
    inventoryBy(db, { key: "genre", title: "By genre", firstLabel: "Genre", groupExpr: `lower(${GENRE})`, labelExpr: GENRE }),
    inventoryBy(db, { key: "condition", title: "By condition", firstLabel: "Condition", groupExpr: "c.condition", labelExpr: "c.condition", mapLabel: conditionLabel }),
    inventoryBy(db, { key: "location", title: "By location", firstLabel: "Location", groupExpr: "lower(COALESCE(c.location, ''))", labelExpr: "COALESCE(c.location, '(no location)')", labelAgg: "MODE() WITHIN GROUP (ORDER BY COALESCE(c.location, '(no location)') COLLATE \"C\")" }),
    inventoryBy(db, { key: "source", title: "By source", firstLabel: "Source", groupExpr: "COALESCE(c.source, '')", labelExpr: "COALESCE(c.source, '')", mapLabel: sourceLabel }),
  ]);
  return {
    sections,
    notes: ["Copies on the shelf (in stock) and set aside for a customer (reserved). Value is the asking price; a copy with no price counts as zero."],
  };
}

// ---------- 2. aging ----------

const AGING_BUCKETS = [
  { key: "0-3", label: "0 to 3 months" },
  { key: "3-6", label: "3 to 6 months" },
  { key: "6-12", label: "6 to 12 months" },
  { key: "12+", label: "12 months or more" },
];

async function agingReport(db, ctx) {
  const today = ctx.today || todayParis();
  const cut = agingCutoffs(today);
  const { rows } = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE d > $1::date)::int AS n0,
       COALESCE(SUM(price) FILTER (WHERE d > $1::date), 0)::float8 AS v0,
       COUNT(*) FILTER (WHERE d <= $1::date AND d > $2::date)::int AS n1,
       COALESCE(SUM(price) FILTER (WHERE d <= $1::date AND d > $2::date), 0)::float8 AS v1,
       COUNT(*) FILTER (WHERE d <= $2::date AND d > $3::date)::int AS n2,
       COALESCE(SUM(price) FILTER (WHERE d <= $2::date AND d > $3::date), 0)::float8 AS v2,
       COUNT(*) FILTER (WHERE d <= $3::date)::int AS n3,
       COALESCE(SUM(price) FILTER (WHERE d <= $3::date), 0)::float8 AS v3
     FROM (SELECT ${COPY_DAY} AS d, c.price FROM book_copies c WHERE c.status = 'in_stock') x`,
    [cut.m3, cut.m6, cut.m12]
  );
  const r = rows[0];
  const summaryRows = AGING_BUCKETS.map((b, i) => ({ bucket: b.label, count: r[`n${i}`], value: money(r[`v${i}`]) }));
  const { rows: old } = await db.query(
    `SELECT b.title, b.authors, c.price, c.location, to_char(${COPY_DAY}, 'YYYY-MM-DD') AS acquired
     FROM book_copies c JOIN books b ON b.id = c.book_id
     WHERE c.status = 'in_stock' AND ${COPY_DAY} <= $1::date
     ORDER BY ${COPY_DAY} ASC, c.id ASC LIMIT ${LIST_LIMIT}`,
    [cut.m12]
  );
  const listRows = old.map((o) => ({
    title: o.title, author: o.authors || "", price: o.price == null ? null : Number(o.price),
    location: o.location || "", acquired: o.acquired,
  }));
  const oldTotal = summaryRows[3].count;
  return {
    sections: [
      {
        key: "buckets", title: "Copies in stock by age",
        columns: [{ key: "bucket", label: "Time in stock", type: "text" }, { key: "count", label: "Copies", type: "int" }, { key: "value", label: "Asking value", type: "eur" }],
        rows: summaryRows,
        totals: { bucket: "Total", ...sumRows(summaryRows, ["count", "value"]) },
      },
      {
        key: "oldest", title: "Copies in stock for 12 months or more, oldest first",
        columns: [
          { key: "title", label: "Title", type: "text" }, { key: "author", label: "Author", type: "text" },
          { key: "price", label: "Price", type: "eur" }, { key: "location", label: "Location", type: "text" },
          { key: "acquired", label: "Acquired", type: "date" },
        ],
        rows: listRows, totals: null,
        note: oldTotal > listRows.length ? `Showing the oldest ${listRows.length} of ${oldTotal}.` : null,
      },
    ],
    notes: ["Age is counted from the acquisition date (or the day the copy was added when no date was entered)."],
  };
}

// ---------- 3. sales over time ----------

function periodLabel(iso, group) {
  if (group === "year") return iso.slice(0, 4);
  if (group === "month") return iso.slice(0, 7);
  return iso; // day, or the Monday that starts the week
}

async function salesReport(db, ctx) {
  const group = ctx.group;
  const params = [group, ctx.from, ctx.to];
  const { rows } = await db.query(
    `WITH disc AS (${require("./accounting").DISCOUNT_ORDERS_SQL}), online AS (
       SELECT date_trunc($1::text, o.paid_at AT TIME ZONE '${TZ}') AS p, COUNT(*)::int AS n, COALESCE(SUM(oi.price), 0)::float8 AS rev
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
       WHERE o.status = 'paid' AND oi.book_copy_id IS NOT NULL AND ${inRange("o.paid_at", 2, 3)}
       GROUP BY 1
     ), shop AS (
       SELECT date_trunc($1::text, s.sold_at AT TIME ZONE '${TZ}') AS p, COUNT(*)::int AS n, COALESCE(SUM(s.price), 0)::float8 AS rev
       FROM shop_sales s
       WHERE ${inRange("s.sold_at", 2, 3)}
       GROUP BY 1
     ), discounts AS (
       -- discounts given at pickup on orders still paid (a refunded order is not in the sales at all), in cents
       SELECT date_trunc($1::text, disc.paid_at AT TIME ZONE '${TZ}') AS p, SUM(disc.cents)::bigint AS cents
       FROM disc WHERE disc.status = 'paid' AND ${inRange("disc.paid_at", 2, 3)}
       GROUP BY 1
     ), periods AS (
       SELECT p FROM online UNION SELECT p FROM shop UNION SELECT p FROM discounts
     )
     SELECT to_char(periods.p, 'YYYY-MM-DD') AS period,
            COALESCE(online.n, 0) AS online_items, COALESCE(online.rev, 0) AS online_revenue,
            COALESCE(shop.n, 0) AS shop_items, COALESCE(shop.rev, 0) AS shop_revenue,
            COALESCE(discounts.cents, 0)::bigint AS discount_cents
     FROM periods LEFT JOIN online ON online.p = periods.p LEFT JOIN shop ON shop.p = periods.p LEFT JOIN discounts ON discounts.p = periods.p
     ORDER BY 1`,
    params
  );
  const out = rows.map((r) => {
    const items = r.online_items + r.shop_items;
    const discounts = -Number(r.discount_cents) / 100;
    const revenue = money(r.online_revenue + r.shop_revenue + discounts);
    return {
      period: periodLabel(r.period, group),
      online_items: r.online_items, online_revenue: money(r.online_revenue),
      shop_items: r.shop_items, shop_revenue: money(r.shop_revenue), discounts: money(discounts),
      total_revenue: revenue, average: items ? money(revenue / items) : null,
    };
  });
  const t = sumRows(out, ["online_items", "online_revenue", "shop_items", "shop_revenue", "discounts", "total_revenue"]);
  const hasDiscounts = out.some((r) => r.discounts !== 0);
  const totalItems = t.online_items + t.shop_items;
  const totals = { period: "Total", ...t, average: totalItems ? money(t.total_revenue / totalItems) : null };

  const { rows: dropin } = await db.query(
    `SELECT to_char(date_trunc($1::text, o.paid_at AT TIME ZONE '${TZ}'), 'YYYY-MM-DD') AS period,
            COUNT(*)::int AS seats, COALESCE(SUM(oi.price), 0)::float8 AS revenue
     FROM order_items oi JOIN orders o ON o.id = oi.order_id
     WHERE o.status = 'paid' AND oi.class_dropin_seat_id IS NOT NULL AND ${inRange("o.paid_at", 2, 3)}
     GROUP BY 1 ORDER BY 1`,
    params
  );
  const dropinRows = dropin.map((r) => ({ period: periodLabel(r.period, group), seats: r.seats, revenue: money(r.revenue) }));
  // Refunds are their own line, counted on the day the admin marked the order
  // refunded (orders.refunded_at). A refunded order is NOT in the sales above.
  const { rows: refunds } = await db.query(
    `SELECT to_char(date_trunc($1::text, o.refunded_at AT TIME ZONE '${TZ}'), 'YYYY-MM-DD') AS period,
            COUNT(*)::int AS orders, COALESCE(SUM(o.total_amount), 0)::float8 AS amount
     FROM orders o
     WHERE o.status = 'refunded' AND o.refunded_at IS NOT NULL AND ${inRange("o.refunded_at", 2, 3)}
     GROUP BY 1 ORDER BY 1`,
    params
  );
  const refundRows = refunds.map((r) => ({ period: periodLabel(r.period, group), orders: r.orders, amount: money(r.amount) }));
  const periodHeader = group === "week" ? "Week starting (Monday)" : "Period";
  return {
    sections: [
      {
        key: "books", title: "Book sales",
        columns: [
          { key: "period", label: periodHeader, type: "text" },
          { key: "online_items", label: "Reserved-online items", type: "int" }, { key: "online_revenue", label: "Reserved-online revenue", type: "eur" },
          { key: "shop_items", label: "Shop items", type: "int" }, { key: "shop_revenue", label: "Shop revenue", type: "eur" },
          // only when a discount exists in the range, so a range without one is exactly the report it always was
          ...(hasDiscounts ? [{ key: "discounts", label: "Pickup discounts", type: "eur" }] : []),
          { key: "total_revenue", label: "Total revenue", type: "eur" }, { key: "average", label: "Average per item", type: "eur" },
        ],
        rows: out, totals,
      },
      {
        key: "dropin", title: "Drop-in class seats (not included in the book sales above)",
        columns: [{ key: "period", label: periodHeader, type: "text" }, { key: "seats", label: "Seats sold", type: "int" }, { key: "revenue", label: "Revenue", type: "eur" }],
        rows: dropinRows, totals: { period: "Total", ...sumRows(dropinRows, ["seats", "revenue"]) },
      },
      {
        key: "refunds", title: "Refunds (reservations refunded in the shop; not included in the sales above)",
        columns: [{ key: "period", label: periodHeader, type: "text" }, { key: "orders", label: "Reservations refunded", type: "int" }, { key: "amount", label: "Amount refunded", type: "eur" }],
        rows: refundRows, totals: { period: "Total", ...sumRows(refundRows, ["orders", "amount"]) },
        note: "Counted on the day the reservation was marked refunded. A refunded reservation no longer appears in the reserved-online sales and drop-in figures.",
      },
    ],
    notes: ["Reserved-online = books reserved on the website and paid in the shop (\"Mark collected and paid\"), counted on the day the payment was recorded. Shop = books sold at the Till (and older sales from the retired Sell in shop page). Days are Paris days.", "Pickup discounts: when a reservation is collected for less than its list price, the difference is shown here as a negative amount (on the day it was paid) and deducted from Total revenue, so the total is what was really received. The discount applies to the whole reservation, so it is not split between books and drop-in seats."],
  };
}

// ---------- 4. sell-through by genre ----------

async function sellthroughReport(db, ctx) {
  const { rows } = await db.query(
    `WITH base AS (
       SELECT c.id, c.status, c.price, ${COPY_DAY} AS acq, ${GENRE} AS genre
       FROM book_copies c JOIN books b ON b.id = c.book_id
       WHERE ${COPY_DAY} >= $1::date AND ${COPY_DAY} <= $2::date
     ), sold_when AS (
       SELECT copy_id, MIN(moment) AS moment FROM (
         SELECT s.copy_id, s.sold_at AS moment FROM shop_sales s
         UNION ALL
         SELECT oi.book_copy_id, o.paid_at FROM order_items oi JOIN orders o ON o.id = oi.order_id
         WHERE o.status = 'paid' AND oi.book_copy_id IS NOT NULL AND o.paid_at IS NOT NULL
       ) u GROUP BY copy_id
     )
     SELECT MIN(base.genre COLLATE "C") AS genre,
            COUNT(*)::int AS acquired,
            COUNT(*) FILTER (WHERE base.status = 'sold')::int AS sold,
            COUNT(w.moment) FILTER (WHERE base.status = 'sold')::int AS days_n,
            COALESCE(SUM(GREATEST(0, (w.moment AT TIME ZONE '${TZ}')::date - base.acq)) FILTER (WHERE base.status = 'sold'), 0)::float8 AS days_sum,
            COUNT(base.price)::int AS price_n,
            COALESCE(SUM(base.price), 0)::float8 AS price_sum
     FROM base LEFT JOIN sold_when w ON w.copy_id = base.id
     GROUP BY lower(base.genre)`,
    [ctx.from, ctx.to]
  );
  const shape = (r, label) => ({
    genre: label, acquired: r.acquired, sold: r.sold,
    sell_through: r.acquired ? (100 * r.sold) / r.acquired : null,
    avg_days: r.days_n ? r.days_sum / r.days_n : null,
    avg_price: r.price_n ? money(r.price_sum / r.price_n) : null,
  });
  const out = rows.map((r) => shape(r, r.genre));
  out.sort((a, b) => b.acquired - a.acquired || String(a.genre).localeCompare(String(b.genre)));
  const sum = (k) => rows.reduce((a, r) => a + Number(r[k]), 0);
  const totals = shape({
    acquired: sum("acquired"), sold: sum("sold"), days_n: sum("days_n"), days_sum: sum("days_sum"), price_n: sum("price_n"), price_sum: sum("price_sum"),
  }, "Total");
  return {
    sections: [{
      key: "genres", title: "Copies acquired in the date range, by genre",
      columns: [
        { key: "genre", label: "Genre", type: "text" }, { key: "acquired", label: "Copies acquired", type: "int" },
        { key: "sold", label: "Sold so far", type: "int" }, { key: "sell_through", label: "Sell-through %", type: "pct" },
        { key: "avg_days", label: "Average days to sell", type: "dec1" }, { key: "avg_price", label: "Average asking price", type: "eur" },
      ],
      rows: out, totals,
    }],
    notes: [
      "A copy counts as sold when its status is Sold. Days to sell run from the acquisition date to the shop sale or the day the online reservation was paid; sold copies with no recorded sale date are left out of the average.",
    ],
  };
}

// ---------- 5. membership ----------

async function membershipReport(db, ctx) {
  const [active, joins, expiries, due] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS n FROM users WHERE is_member AND (member_expires_at IS NULL OR member_expires_at > now())`),
    db.query(
      `SELECT to_char(date_trunc('month', first_paid AT TIME ZONE '${TZ}'), 'YYYY-MM') AS month, COUNT(*)::int AS n
       FROM (
         SELECT MIN(paid_at) AS first_paid FROM membership_payments WHERE reversed_at IS NULL
         GROUP BY COALESCE('u' || user_id::text, 'e' || lower(payer_email))
       ) f
       WHERE ${inRange("first_paid", 1, 2)}
       GROUP BY 1 ORDER BY 1`,
      [ctx.from, ctx.to]
    ),
    db.query(
      `SELECT to_char(date_trunc('month', member_expires_at AT TIME ZONE '${TZ}'), 'YYYY-MM') AS month, COUNT(*)::int AS n
       FROM users WHERE member_expires_at IS NOT NULL AND ${inRange("member_expires_at", 1, 2)}
       GROUP BY 1 ORDER BY 1`,
      [ctx.from, ctx.to]
    ),
    db.query(
      `SELECT display_name, to_char(member_expires_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS expires
       FROM users
       WHERE is_member AND member_expires_at IS NOT NULL
         AND member_expires_at >= now() AND member_expires_at < ${parisPlusDaysSql("now()", 30)}
       ORDER BY member_expires_at ASC, id ASC LIMIT ${LIST_LIMIT}`
    ),
  ]);
  const monthRows = (res) => res.rows.map((r) => ({ month: r.month, count: r.n }));
  const joinRows = monthRows(joins);
  const expiryRows = monthRows(expiries);
  const dueRows = due.rows.map((r) => ({
    name: r.display_name || "",
    expires: r.expires,
  }));
  return {
    sections: [
      {
        key: "now", title: "Members now",
        columns: [{ key: "measure", label: "Measure", type: "text" }, { key: "count", label: "Count", type: "int" }],
        rows: [{ measure: "Active members", count: active.rows[0].n }], totals: null,
      },
      {
        key: "joins", title: "New members per month (first payment)",
        columns: [{ key: "month", label: "Month", type: "text" }, { key: "count", label: "New members", type: "int" }],
        rows: joinRows, totals: { month: "Total", ...sumRows(joinRows, ["count"]) },
      },
      {
        key: "expiries", title: "Memberships ending per month",
        columns: [{ key: "month", label: "Month", type: "text" }, { key: "count", label: "Ending", type: "int" }],
        rows: expiryRows, totals: { month: "Total", ...sumRows(expiryRows, ["count"]) },
      },
      {
        key: "renewals", title: "Renewals due in the next 30 days",
        columns: [{ key: "name", label: "Name", type: "text" }, { key: "expires", label: "Expires", type: "date" }],
        rows: dueRows, totals: null,
      },
    ],
    notes: ["Active = marked as a member and not expired. Only names and dates are shown: no email addresses."],
  };
}

// ---------- 6. intake log ----------

async function intakeReport(db, ctx) {
  const range = inRange("c.created_at", 1, 2);
  const [perMonth, perSource, latest] = await Promise.all([
    db.query(
      `SELECT to_char(date_trunc('month', c.created_at AT TIME ZONE '${TZ}'), 'YYYY-MM') AS label,
              COUNT(*)::int AS copies, COALESCE(SUM(c.acquisition_cost), 0)::float8 AS cost
       FROM book_copies c WHERE ${range} GROUP BY 1 ORDER BY 1`,
      [ctx.from, ctx.to]
    ),
    db.query(
      `SELECT COALESCE(c.source, '') AS label, COUNT(*)::int AS copies, COALESCE(SUM(c.acquisition_cost), 0)::float8 AS cost
       FROM book_copies c WHERE ${range} GROUP BY 1 ORDER BY 2 DESC, 1`,
      [ctx.from, ctx.to]
    ),
    db.query(
      `SELECT to_char(c.created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS added, b.title, b.authors, c.source, c.condition, c.price, c.acquisition_cost, c.location
       FROM book_copies c JOIN books b ON b.id = c.book_id
       ORDER BY c.created_at DESC, c.id DESC LIMIT ${INTAKE_LATEST}`
    ),
  ]);
  const grouped = (res, map = (x) => x) => res.rows.map((r) => ({ label: map(r.label), copies: r.copies, cost: money(r.cost) }));
  const monthRows = grouped(perMonth);
  const sourceRows = grouped(perSource, sourceLabel);
  const latestRows = latest.rows.map((r) => ({
    added: r.added,
    title: r.title, author: r.authors || "", source: sourceLabel(r.source), condition: conditionLabel(r.condition),
    price: r.price == null ? null : Number(r.price), cost: r.acquisition_cost == null ? null : Number(r.acquisition_cost),
    location: r.location || "",
  }));
  const cols = (first) => [
    { key: "label", label: first, type: "text" }, { key: "copies", label: "Copies added", type: "int" },
    { key: "cost", label: "Acquisition cost", type: "eur" },
  ];
  return {
    sections: [
      { key: "months", title: "Copies added per month", columns: cols("Month"), rows: monthRows, totals: { label: "Total", ...sumRows(monthRows, ["copies", "cost"]) } },
      { key: "sources", title: "Copies added by source", columns: cols("Source"), rows: sourceRows, totals: { label: "Total", ...sumRows(sourceRows, ["copies", "cost"]) } },
      {
        key: "latest", title: `Latest ${INTAKE_LATEST} copies added (any date)`,
        columns: [
          { key: "added", label: "Added", type: "date" }, { key: "title", label: "Title", type: "text" }, { key: "author", label: "Author", type: "text" },
          { key: "source", label: "Source", type: "text" }, { key: "condition", label: "Condition", type: "text" },
          { key: "price", label: "Price", type: "eur" }, { key: "cost", label: "Acquisition cost", type: "eur" }, { key: "location", label: "Location", type: "text" },
        ],
        rows: latestRows, totals: null,
      },
    ],
    notes: ["Acquisition cost is only counted for copies where it was entered."],
  };
}

// ---------- 7. accounts ----------

const ACCOUNTS_PAGE_SIZE = 50;
const ACCOUNTS_CSV_LIMIT = 50000;

// Paid orders per account, pre-aggregated once and hash-joined (see accountsReport).
// An order belongs to the account in orders.user_id; the buyer email is used ONLY for
// older orders that have no user_id (placed before accounts were required, migration
// 058), matched to the account with that email. The first version matched every order
// to every account with a per-user EXISTS(... lower(buyer_email) = lower(email)):
// 10 s for 5,000 accounts, headed for the 30 s statement timeout at about 10,000.
// Needs idx_orders_user (058), idx_orders_legacy_buyer_email and idx_users_lower_email (082).
const PAID_ORDERS_BY_ACCOUNT_SQL = `
  SELECT acct.uid, COUNT(*) AS n, SUM(acct.total_amount) AS spent
  FROM (
    SELECT o.user_id AS uid, o.total_amount FROM orders o
     WHERE o.status = 'paid' AND o.user_id IS NOT NULL
    UNION ALL
    SELECT u2.id, o.total_amount FROM orders o
      JOIN users u2 ON lower(u2.email) = lower(o.buyer_email)
     WHERE o.status = 'paid' AND o.user_id IS NULL
  ) acct
  GROUP BY acct.uid`;

// Everyone with an account, by type. Types come from lib/accountTypes.js, the
// same definitions as the admin accounts list. Orders are matched to an
// account by orders.user_id (older orders without one: by email); refunded
// orders (status 'refunded') and unpaid ones are not counted.
async function accountsReport(db, ctx) {
  const q = ctx.query || {};
  const type = parseTypeFilter(q.type);
  const text = String(q.q || "").trim().slice(0, 100);
  const from = validDay(q.from);
  const to = validDay(q.to);
  const page = parseIntParam(q.page, { min: 1, max: 1000000, default: 1 });

  const where = [];
  const params = [];
  const tf = typeFilterSql(type, "u");
  if (tf) where.push(tf);
  if (text) {
    params.push(likeContains(text));
    where.push(`(u.display_name ILIKE $${params.length} OR u.email ILIKE $${params.length})`);
  }
  if (from) { params.push(from); where.push(`u.created_at >= ($${params.length}::date)::timestamp AT TIME ZONE '${TZ}'`); }
  if (to) { params.push(to); where.push(`u.created_at < (($${params.length}::date) + 1)::timestamp AT TIME ZONE '${TZ}'`); }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const [summaryRes, countRes] = await Promise.all([
    db.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE u.is_admin)::int AS admins,
              COUNT(*) FILTER (WHERE u.is_volunteer)::int AS volunteers,
              COUNT(*) FILTER (WHERE u.is_till)::int AS till,
              COUNT(*) FILTER (WHERE ${activeMemberSql("u")})::int AS members,
              COUNT(*) FILTER (WHERE u.is_member AND NOT ${activeMemberSql("u")})::int AS expired,
              COUNT(*) FILTER (WHERE ${typeFilterSql("account", "u")})::int AS holders,
              COUNT(*) FILTER (WHERE u.email_verified_at IS NULL)::int AS unconfirmed,
              COUNT(*) FILTER (WHERE u.created_at >= now() - interval '7 days')::int AS new7,
              COUNT(*) FILTER (WHERE u.created_at >= now() - interval '30 days')::int AS new30,
              COUNT(ord.uid)::int AS buyers
       FROM users u
       LEFT JOIN (SELECT DISTINCT uid FROM (${PAID_ORDERS_BY_ACCOUNT_SQL}) paid) ord ON ord.uid = u.id`
    ),
    db.query(`SELECT COUNT(*)::int AS n FROM users u ${whereSql}`, params),
  ]);
  const s = summaryRes.rows[0];
  const total = countRes.rows[0].n;
  const pages = Math.max(1, Math.ceil(total / ACCOUNTS_PAGE_SIZE));
  const current = Math.min(page, pages);
  const limit = ctx.csv ? ACCOUNTS_CSV_LIMIT : ACCOUNTS_PAGE_SIZE;
  const offset = ctx.csv ? 0 : (current - 1) * ACCOUNTS_PAGE_SIZE;

  const { rows } = await db.query(
    `SELECT u.display_name, u.email, ${typeCaseSql("u")} AS type,
            u.is_member, u.member_expires_at, u.is_till,
            to_char(u.member_expires_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS member_until,
            u.email_verified_at IS NOT NULL AS confirmed,
            to_char(u.created_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS created,
            to_char(u.last_login_at AT TIME ZONE '${TZ}', 'YYYY-MM-DD') AS last_login,
            COALESCE(ord.n, 0)::int AS orders, COALESCE(ord.spent, 0)::float8 AS spent, u.is_disabled
     FROM users u
     LEFT JOIN (${PAID_ORDERS_BY_ACCOUNT_SQL}) ord ON ord.uid = u.id
     ${whereSql}
     ORDER BY u.created_at DESC, u.id DESC
     LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  const list = rows.map((r) => ({
    name: r.display_name, email: r.email, type: TYPE_LABELS[r.type] + (r.is_till ? " + Till" : ""),
    member_until: r.is_member ? (r.member_until || "no end date") : "",
    confirmed: r.confirmed ? "yes" : "no",
    created: r.created, last_login: r.last_login || "never",
    orders: r.orders, spent: money(r.spent), disabled: r.is_disabled ? "yes" : "no",
  }));
  const summaryRows = [
    ["Total accounts", s.total], ["Admins", s.admins], ["Volunteers", s.volunteers], ["Till access (can use the till without being an admin)", s.till],
    ["Members (paying or granted)", s.members], ["Members whose membership has expired", s.expired],
    ["Account holders (not a member, admin or volunteer)", s.holders],
    ["Unconfirmed (email never confirmed)", s.unconfirmed],
    ["Created in the last 7 days", s.new7], ["Created in the last 30 days", s.new30],
    ["With at least one paid reservation", s.buyers],
  ].map(([label, count]) => ({ label, count }));
  return {
    sections: [
      {
        key: "summary", title: "Summary (all accounts)",
        columns: [{ key: "label", label: "Measure", type: "text" }, { key: "count", label: "Accounts", type: "int" }],
        rows: summaryRows, totals: null,
        note: "An account can count in several lines (an admin who is also a volunteer, for example). Each account has one type in the list below: Admin, else Volunteer, else Member, else Account, else Unconfirmed; \"+ Till\" is added when the account has Till access.",
      },
      {
        key: "accounts", title: `Accounts (${total})`,
        columns: [
          { key: "name", label: "Name", type: "text" }, { key: "email", label: "Email", type: "text" }, { key: "type", label: "Type", type: "text" },
          { key: "member_until", label: "Member until", type: "text" }, { key: "confirmed", label: "Email confirmed", type: "text" },
          { key: "created", label: "Created", type: "date" }, { key: "last_login", label: "Last login", type: "text" },
          { key: "orders", label: "Paid reservations", type: "int" }, { key: "spent", label: "Total spent", type: "eur" },
          { key: "disabled", label: "Disabled", type: "text" },
        ],
        rows: list, totals: null,
        pagination: ctx.csv ? null : { page: current, pages, total, pageSize: ACCOUNTS_PAGE_SIZE },
        note: "Paid reservations are counted for the account that made them (older ones without an account: matched by email); refunded and unpaid reservations are not counted. Dates are Paris days.",
      },
    ],
    notes: ["This report shows names and email addresses. Handle the CSV with care."],
  };
}

// ---------- Reservations ----------

// Reservations made in the period (orders with a deadline, created in the
// range), by month and in total: how many were reserved, how many ended in a
// sale in the shop (collected: orders that are now paid or refunded), expired
// (not collected in time, or marked no-show), cancelled, and still open; and the
// conversion rate = collected / (collected + expired + cancelled), i.e. of the
// reservations that are over, the share that became a sale. The rest of a
// partly collected reservation (split_from_order_id) is not counted twice.
// Revenue itself is in "Sales over time" (counted at the day paid).
async function reservationsReport(db, ctx) {
  const { rows } = await db.query(
    `SELECT to_char(date_trunc('month', o.created_at AT TIME ZONE '${TZ}'), 'YYYY-MM') AS month,
            COUNT(*)::int AS reserved,
            COUNT(*) FILTER (WHERE o.status IN ('paid', 'refunded'))::int AS collected,
            COUNT(*) FILTER (WHERE o.status = 'expired')::int AS expired,
            COUNT(*) FILTER (WHERE o.status = 'cancelled')::int AS cancelled,
            COUNT(*) FILTER (WHERE o.status = 'reserved')::int AS open,
            COALESCE(SUM(o.total_amount) FILTER (WHERE o.status IN ('paid', 'refunded')), 0)::float8 AS collected_value
     FROM orders o
     WHERE o.reserved_until IS NOT NULL AND o.split_from_order_id IS NULL AND ${inRange("o.created_at", 1, 2)}
     GROUP BY 1 ORDER BY 1`,
    [ctx.from, ctx.to]
  );
  const rate = (r) => {
    const over = r.collected + r.expired + r.cancelled;
    return over ? (100 * r.collected) / over : null;
  };
  const byMonth = rows.map((r) => ({ ...r, collected_value: money(r.collected_value), conversion: rate(r) }));
  const t = { reserved: 0, collected: 0, expired: 0, cancelled: 0, open: 0, collected_value: 0 };
  for (const r of rows) for (const k of Object.keys(t)) t[k] += Number(r[k]);
  const totals = { month: "Total", ...t, collected_value: money(t.collected_value), conversion: rate(t) };
  const columns = [
    { key: "month", label: "Month", type: "text" }, { key: "reserved", label: "Reserved", type: "int" },
    { key: "collected", label: "Collected (sold)", type: "int" }, { key: "expired", label: "Expired / no-show", type: "int" },
    { key: "cancelled", label: "Cancelled", type: "int" }, { key: "open", label: "Still open", type: "int" },
    { key: "collected_value", label: "Value collected", type: "eur" }, { key: "conversion", label: "Conversion", type: "pct" },
  ];
  return {
    sections: [
      {
        key: "reservations", title: "Reservations by month", columns, rows: byMonth, totals,
        note: "Counted by the month the reservation was made (Paris time). Conversion = collected / (collected + expired + cancelled): of the reservations that are over, the share that became a sale. Customers pay in the shop; revenue is counted when the payment is recorded (see Sales over time).",
      },
    ],
    notes: ["No names or email addresses appear in this report."],
  };
}

const REPORTS = [
  { slug: "inventory", title: "Inventory on hand", summary: "Copies in stock and reserved, with their asking value, by genre, condition, location and source.", run: inventoryReport },
  { slug: "aging", title: "Aging stock", summary: "How long copies have been in stock (0-3, 3-6, 6-12, 12+ months), and the oldest ones.", run: agingReport },
  { slug: "sales", title: "Sales over time", summary: "Book sales (reserved online, paid in the shop) and walk-in shop sales by day, week, month or year, plus drop-in seats separately.", usesRange: true, usesGroup: true, run: salesReport },
  { slug: "reservations", title: "Reservations", summary: "Reserved online, collected and paid in the shop, expired and cancelled, by month, with the conversion rate.", usesRange: true, run: reservationsReport },
  { slug: "sellthrough", title: "Sell-through by genre", summary: "Of the copies acquired in a period, how many have sold, and how fast.", usesRange: true, run: sellthroughReport },
  { slug: "membership", title: "Membership", summary: "Active members, new members and endings per month, and renewals due soon.", usesRange: true, run: membershipReport },
  { slug: "intake", title: "Intake log", summary: "Copies added per month and by source, with acquisition cost, and the latest additions.", usesRange: true, run: intakeReport },
  { slug: "accounts", title: "Accounts", summary: "Everyone with an account by type (admin, volunteer, member, account holder, unconfirmed), with reservations and spend. Shows names and emails.", filters: "accounts", csvTable: "accounts", run: accountsReport },
  { slug: "accounting", title: "Accounting export", summary: "For the treasurer: one row per day, category and payment method (till, shop, online, membership), no customer data. Download the CSV.", usesRange: true, run: (db, ctx) => require("./accounting").accountingExportReport(db, ctx) },
  { slug: "lookup-sources", title: "Book lookup sources used", summary: "How often each book catalog (Open Library, BnF, Google Books, Open Library data API, ISBNdb) was asked, supplied the title, failed or was slow, with cache hits and ISBNs not found; then what the AI features used (calls, tokens, errors, credit). Counts only.", usesPeriod: true, csvTable: "sources", run: (db, ctx) => require("./lookupSourcesReport").run(db, ctx) },
];

const getReport = (slug) => REPORTS.find((r) => r.slug === slug) || null;

// Runs a report for a request's query string.
async function runReport(db, report, query = {}, now = new Date(), { csv = false } = {}) {
  const range = parseDateRange(query, now);
  const ctx = { ...range, group: parseGroup(query.group), today: todayParis(now), query, csv };
  const result = await report.run(db, ctx);
  return { ...result, range, group: ctx.group };
}

module.exports = {
  PAID_ORDERS_BY_ACCOUNT_SQL,
  REPORTS, GROUPS, LIST_LIMIT, ACCOUNTS_PAGE_SIZE, getReport, runReport,
  validDay, todayParis, subMonths, addDays, parseDateRange, parseGroup, agingCutoffs, agingBucket,
  formatCell, csvCell, toCsv, CSV_SEP, wantsFrenchCsv,
};
