// The treasurer's records, produced without anyone opening the admin: the SAME accounting
// code as Admin > Reports > Accounting export (lib/accounting.js accountingExportReport and
// lib/reports.js toCsv in the French Excel dialect), plus the till end-of-day figures and a short
// summary. Used by scripts/export-accounting-month.js (the monthly GitHub workflow and the
// yearly export of the nightly backup workflow). Read-only: SELECTs only.
//
// NO personal data: the accounting export has none by construction, the till figures are totals
// only, and assertNoPersonalData() refuses to produce a file whose header is not exactly the
// expected one or whose text contains an email address or a phone-like number.

const { SITE_TIME_ZONE } = require("./tz");
const { accountingExportReport } = require("./accounting");
const { toCsv } = require("./reports");
const till = require("./till");

const TZ = SITE_TIME_ZONE;

// Before this month the accounting export double counted refunded reservations (fixed in PR #265,
// October 2026): the months before it were overstated.
const FIX_MONTH = "2026-10";

const ACCOUNTING_HEADER = ["Date", "Category", "Payment method", "Count", "Total (EUR)", "Libellé", "Compte débit", "Compte crédit", "Journal"];
const TILL_COLUMNS = [
  { key: "date", label: "Date", type: "text" },
  { key: "opening", label: "Opening float (EUR)", type: "eur" },
  { key: "counted", label: "Cash counted (EUR)", type: "eur" },
  { key: "expected", label: "Expected cash (EUR)", type: "eur" },
  { key: "difference", label: "Difference (EUR)", type: "eur" },
  { key: "cash", label: "Cash sales (EUR)", type: "eur" },
  { key: "card", label: "Card sales (EUR)", type: "eur" },
  { key: "total", label: "Total sales (EUR)", type: "eur" },
  { key: "sales", label: "Sales", type: "int" },
  { key: "voided", label: "Voided sales", type: "int" },
  { key: "firstReceipt", label: "First receipt", type: "text" },
  { key: "lastReceipt", label: "Last receipt", type: "text" },
  { key: "closed", label: "Closed", type: "text" },
];
const TILL_HEADER = TILL_COLUMNS.map((c) => c.label);

// ---------- Paris dates (never the server's own clock zone) ----------

const pad = (n, w = 2) => String(n).padStart(w, "0");

// { y, m, d, h } of an instant on the Paris wall clock.
function parisParts(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(now);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get("year"), m: get("month"), d: get("day"), h: get("hour") };
}

const MONTH_RE = /^(\d{4})-(0[1-9]|1[0-2])$/;
function parseMonth(text) {
  const m = MONTH_RE.exec(String(text || "").trim());
  if (!m) throw new Error(`"${text}" is not a month: use YYYY-MM (for example 2026-10).`);
  return { y: Number(m[1]), m: Number(m[2]), label: `${m[1]}-${m[2]}` };
}
const currentMonth = (now = new Date()) => { const p = parisParts(now); return `${p.y}-${pad(p.m)}`; };
function previousMonth(now = new Date()) {
  const p = parisParts(now);
  return p.m === 1 ? `${p.y - 1}-12` : `${p.y}-${pad(p.m - 1)}`;
}
const lastDayOf = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m is 1-12

// { label, from, to } with inclusive Paris dates (accountingRows turns them into Paris midnights,
// so a 23-hour or 25-hour DST day is handled by Postgres, not here).
function monthRange(text) {
  const { y, m, label } = parseMonth(text);
  return { kind: "month", label, folderYear: y, from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(lastDayOf(y, m))}` };
}

const startMonthOf = (v) => {
  const n = v === undefined || v === null || v === "" ? 1 : Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 12) throw new Error(`FISCAL_YEAR_START_MONTH must be a number from 1 to 12 (got "${v}").`);
  return n;
};
// The financial year that STARTS in `year`, in the month `startMonth` (1 = the calendar year).
function yearRange(year, startMonth = 1) {
  const y = Number(year);
  if (!Number.isInteger(y) || y < 2000 || y > 2200) throw new Error(`"${year}" is not a year.`);
  const sm = startMonthOf(startMonth);
  const endY = sm === 1 ? y : y + 1;
  const endM = sm === 1 ? 12 : sm - 1;
  return {
    kind: "year", label: `${y}-full-year`, folderYear: y, startMonth: sm,
    from: `${y}-${pad(sm)}-01`, to: `${endY}-${pad(endM)}-${pad(lastDayOf(endY, endM))}`,
  };
}
// The most recent financial year that has fully ended (on the Paris calendar).
function lastFiscalYearStart(now = new Date(), startMonth = 1) {
  const sm = startMonthOf(startMonth);
  const p = parisParts(now);
  return p.m >= sm ? p.y - 1 : p.y - 2;
}

// The month must be over in Paris, unless forced.
function checkMonthAllowed(label, now = new Date(), force = false) {
  const { label: ym } = parseMonth(label);
  if (force) return;
  const cur = currentMonth(now);
  if (ym > cur) throw new Error(`${ym} is in the future. Nothing was exported. (Use --force only for a test.)`);
  if (ym === cur) throw new Error(`${ym} is the current month and is not over yet. Nothing was exported. (Use --force only for a test.)`);
}

// Mirrors the first step of the monthly workflow: 07:xx Paris on the 1st.
const isMonthlyRunTime = (now = new Date()) => { const p = parisParts(now); return p.d === 1 && p.h === 7; };

// ---------- money / text ----------

const eurText = (cents) => {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, "\u00A0");
  return `${neg ? "-" : ""}${whole},${pad(abs % 100)}`;
};
const receiptText = (year, no) => (no ? `${year}-${String(no).padStart(4, "0")}` : "");

// ---------- guard: no personal data ----------

const EMAIL_RE = /[^\s@]+@[^\s@]+/;
// 10+ digits in a row (with spaces, dots, dashes or a leading +/00), or the French 0X XX XX XX XX shape.
// Amounts (at most 7 digits with a comma), dates (2026-10-01) and receipts (2026-0007) never match.
const PHONE_RES = [/(?:\+|\b00)\d[\d .-]{7,}\d/, /\b0[1-9](?:[ .-]?\d{2}){4}\b/, /\d{10,}/];
function assertNoPersonalData(name, text, expectedHeader) {
  if (expectedHeader) {
    const first = text.replace(/^\uFEFF/, "").split("\r\n")[0];
    const header = first.split(";").map((c) => c.replace(/^"|"$/g, "").replace(/""/g, '"'));
    if (JSON.stringify(header) !== JSON.stringify(expectedHeader)) {
      throw new Error(`${name}: the columns are not the expected list (a column was added or changed). Refusing to write it until it is reviewed for personal data.`);
    }
  }
  if (EMAIL_RE.test(text)) throw new Error(`${name}: contains something that looks like an email address. Refusing to write it.`);
  for (const re of PHONE_RES) if (re.test(text)) throw new Error(`${name}: contains something that looks like a phone number. Refusing to write it.`);
}

// ---------- the till end-of-day figures ----------

const rangeSql = (col) => `${col} >= ($1::date)::timestamp AT TIME ZONE '${TZ}' AND ${col} < (($2::date) + 1)::timestamp AT TIME ZONE '${TZ}'`;

// One row per Paris day that has till sales or a till_days row. Reuses till.daySummary (the same
// figures as the end-of-day page). Cheques and online payments are not at the till.
async function tillDays(db, range) {
  const params = [range.from, range.to];
  const { rows: days } = await db.query(
    `SELECT to_char(d, 'YYYY-MM-DD') AS day FROM (
       SELECT (created_at AT TIME ZONE '${TZ}')::date AS d FROM till_sales WHERE ${rangeSql("created_at")}
       UNION SELECT day FROM till_days WHERE day >= $1::date AND day <= $2::date) x ORDER BY d`, params);
  const { rows: receipts } = await db.query(
    `SELECT to_char((created_at AT TIME ZONE '${TZ}')::date, 'YYYY-MM-DD') AS day, MIN(receipt_year) AS y, MIN(receipt_no) AS lo, MAX(receipt_no) AS hi
     FROM till_sales WHERE receipt_no IS NOT NULL AND ${rangeSql("created_at")} GROUP BY 1`, params);
  const rec = new Map(receipts.map((r) => [r.day, r]));
  const out = [];
  for (const { day } of days) {
    const s = await till.daySummary(db, day);
    const r = rec.get(day);
    const dr = s.dayRow;
    out.push({
      date: day,
      opening: s.hasFloat ? s.floatCents / 100 : null,
      counted: s.closed && dr.counted_cash_cents !== null ? dr.counted_cash_cents / 100 : null,
      expected: s.closed && dr.expected_cash_cents !== null ? dr.expected_cash_cents / 100 : null,
      difference: s.closed && dr.difference_cents !== null ? dr.difference_cents / 100 : null,
      cash: s.cash.total / 100, card: s.card.total / 100, total: s.total / 100,
      cashCents: s.cash.total, cardCents: s.card.total, totalCents: s.total,
      sales: s.count, voided: s.voided.n,
      firstReceipt: r ? receiptText(r.y, r.lo) : "", lastReceipt: r ? receiptText(r.y, r.hi) : "",
      closed: s.closed ? "yes" : "no",
    });
  }
  return out;
}

// ---------- the summary ----------

async function counts(db, range) {
  const params = [range.from, range.to];
  const one = async (sql) => (await db.query(sql, params)).rows[0];
  const sales = await one(`SELECT COUNT(*) FILTER (WHERE status = 'completed')::int AS sales, COUNT(*) FILTER (WHERE status = 'voided')::int AS voids
                           FROM till_sales WHERE ${rangeSql("created_at")}`);
  const refunds = await one(`SELECT COUNT(*)::int AS n FROM orders WHERE status = 'refunded' AND refunded_at IS NOT NULL AND ${rangeSql("refunded_at")}`);
  const first = await one(`SELECT receipt_year AS y, receipt_no AS no FROM till_sales WHERE receipt_no IS NOT NULL AND ${rangeSql("created_at")}
                           ORDER BY receipt_year, receipt_no LIMIT 1`);
  const last = await one(`SELECT receipt_year AS y, receipt_no AS no FROM till_sales WHERE receipt_no IS NOT NULL AND ${rangeSql("created_at")}
                          ORDER BY receipt_year DESC, receipt_no DESC LIMIT 1`);
  return {
    sales: sales.sales, voids: sales.voids, refunds: refunds.n,
    firstReceipt: first ? receiptText(first.y, first.no) : "", lastReceipt: last ? receiptText(last.y, last.no) : "",
  };
}

function sumBy(rows, keyFn) {
  const m = new Map();
  for (const r of rows) m.set(keyFn(r), (m.get(keyFn(r)) || 0) + r.cents);
  return [...m.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

function summaryText({ range, rows, tillRows, counts: c, generatedOn }) {
  const total = rows.reduce((a, r) => a + r.cents, 0);
  const lines = [
    `Uma's Books - accounting summary ${range.kind === "year" ? "for the year" : "for the month"} ${range.label}`,
    `Period: ${range.from} to ${range.to} (Paris days). Generated on ${generatedOn}.`,
    "No personal data is in this file or in the CSV files that go with it.",
    "",
  ];
  if (!rows.length && !tillRows.length) {
    lines.push("No sales were recorded in this period. The CSV files contain only their header row.", "");
  }
  lines.push(`Accounting rows: ${rows.length}`, `Total (EUR, refunds and cash over/short included): ${eurText(total)}`, "");
  lines.push("Totals by credit account and payment method (EUR):");
  const byAcc = sumBy(rows, (r) => `${r.credit} | ${r.method}`);
  if (!byAcc.length) lines.push("  (none)");
  for (const [k, v] of byAcc) lines.push(`  ${k}: ${eurText(v)}`);
  lines.push("", "Totals by credit account (EUR):");
  const accOnly = sumBy(rows, (r) => r.credit);
  if (!accOnly.length) lines.push("  (none)");
  for (const [k, v] of accOnly) lines.push(`  ${k}: ${eurText(v)}`);
  lines.push("", "Totals by payment method (EUR):");
  const methOnly = sumBy(rows, (r) => r.method);
  if (!methOnly.length) lines.push("  (none)");
  for (const [k, v] of methOnly) lines.push(`  ${k}: ${eurText(v)}`);
  const unclosed = tillRows.filter((d) => d.closed === "no" && d.sales > 0).map((d) => d.date);
  lines.push(
    "", `Till sales: ${c.sales}`, `Refunded reservations (refund dated in this period): ${c.refunds}`, `Voided till sales: ${c.voids}`,
    `Receipt numbers (voided ones keep theirs): ${c.firstReceipt ? `${c.firstReceipt} to ${c.lastReceipt}` : "none"}`,
    `Till days with sales that were not closed: ${unclosed.length}${unclosed.length ? ` (${unclosed.join(", ")})` : ""}`, ""
  );
  return lines.join("\r\n");
}

// ---------- everything for one range ----------

async function buildExport(db, range, { now = new Date() } = {}) {
  const report = await accountingExportReport(db, { from: range.from, to: range.to });
  const section = report.sections[0];
  const accountingCsv = toCsv(section, { locale: "fr" });
  const tRows = await tillDays(db, range);
  const tillCsv = toCsv({ columns: TILL_COLUMNS, rows: tRows, csvTotals: false }, { locale: "fr" });
  const c = await counts(db, range);
  const p = parisParts(now);
  const summary = summaryText({ range, rows: section.rows, tillRows: tRows, counts: c, generatedOn: `${p.y}-${pad(p.m)}-${pad(p.d)}` });
  assertNoPersonalData("accounting CSV", accountingCsv, ACCOUNTING_HEADER);
  assertNoPersonalData("till days CSV", tillCsv, TILL_HEADER);
  assertNoPersonalData("summary", summary);
  const totalCents = section.rows.reduce((a, r) => a + r.cents, 0);
  return {
    range, accountingCsv, tillCsv, summary,
    stats: {
      accountingRows: section.rows.length, tillDays: tRows.length, totalCents, ...c,
      unclosedDays: tRows.filter((d) => d.closed === "no" && d.sales > 0).length,
    },
  };
}

function fileNames(range) {
  const l = range.label;
  return { accounting: `accounting_${l}.csv`, till: `till_days_${l}.csv`, summary: `summary_${l}.txt`, email: "email_body.txt" };
}

// The plain-English body of the email that carries the CSV files.
function emailBody(range, stats, { runUrl = "" } = {}) {
  const names = fileNames(range);
  const what = range.kind === "year" ? `the year ${range.label.replace("-full-year", "")}${range.startMonth > 1 ? ` (financial year starting in month ${range.startMonth})` : ""}` : `the month ${range.label}`;
  const lines = [
    `Attached are the accounting files for ${what} (Paris days ${range.from} to ${range.to}).`,
    "",
    `- ${names.accounting}: the accounting export (the same file as Admin > Reports > Accounting export, French Excel format).`,
    `- ${names.till}: the end-of-day summary of the till, one row per day.`,
    "",
    `Rows in the accounting export: ${stats.accountingRows}. Total: ${eurText(stats.totalCents)} EUR.`,
    `Till sales: ${stats.sales}. Refunded reservations: ${stats.refunds}. Voided till sales: ${stats.voids}.`,
    `Receipt numbers: ${stats.firstReceipt ? `${stats.firstReceipt} to ${stats.lastReceipt}` : "none"}.`,
    `Till days with sales that were not closed: ${stats.unclosedDays}.`,
  ];
  if (!stats.accountingRows && !stats.tillDays) lines.push("", "No sales were recorded in this period: the files contain only their header row.");
  lines.push(
    "", "What to do: save these files in the accounting folder (or in Paheko) and send them to the treasurer if needed. They contain no personal data.",
    "A copy is also kept for 10 years in the Backblaze bucket, in the folder accounting-exports/ (readable without any key).",
  );
  if (stats.unclosedDays) lines.push("", "Some till days with sales were not closed: ask the volunteers to close them (Till > End of day) and, if needed, run this export again from the Actions tab.");
  const firstMonth = range.kind === "month" ? range.label : range.from.slice(0, 7);
  if (firstMonth < FIX_MONTH) {
    lines.push("", `NOTE: figures before October 2026 are not reliable. Until the accounting fix of October 2026 (PR #265) the export counted some refunded reservations twice, so months before ${FIX_MONTH} were overstated. Check ${range.kind === "year" ? "this period" : "this month"} against the till and bank records before using it.`);
  }
  if (runUrl) lines.push("", `Run: ${runUrl}`);
  return lines.join("\n") + "\n";
}

module.exports = {
  ACCOUNTING_HEADER, TILL_HEADER, FIX_MONTH,
  parisParts, parseMonth, currentMonth, previousMonth, monthRange, yearRange, lastFiscalYearStart, checkMonthAllowed, isMonthlyRunTime,
  eurText, assertNoPersonalData, tillDays, buildExport, fileNames, emailBody,
};
