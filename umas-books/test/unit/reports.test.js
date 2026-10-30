const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  validDay, todayParis, subMonths, addDays, parseDateRange, parseGroup, agingCutoffs, agingBucket,
  formatCell, csvCell, toCsv, REPORTS, getReport,
} = require("../../src/lib/reports");
const { normalizeSource } = require("../../src/lib/inventory");

test("validDay accepts real calendar days only", () => {
  assert.equal(validDay("2024-02-29"), "2024-02-29");
  assert.equal(validDay("2023-02-29"), null);
  assert.equal(validDay("2024-13-01"), null);
  assert.equal(validDay("24-01-01"), null);
  assert.equal(validDay(undefined), null);
  assert.equal(validDay("2024-01-01; DROP TABLE"), null);
});

test("todayParis is the Paris calendar day, not the UTC one", () => {
  // 23:30 UTC on 30 June is 01:30 on 1 July in Paris (summer time).
  assert.equal(todayParis(new Date("2026-06-30T23:30:00Z")), "2026-07-01");
  assert.equal(todayParis(new Date("2026-01-15T23:30:00Z")), "2026-01-16");
  assert.equal(todayParis(new Date("2026-01-15T12:00:00Z")), "2026-01-15");
});

test("subMonths and addDays clamp to the end of shorter months and cross years", () => {
  assert.equal(subMonths("2026-05-31", 3), "2026-02-28");
  assert.equal(subMonths("2024-05-31", 3), "2024-02-29");
  assert.equal(subMonths("2026-01-15", 1), "2025-12-15");
  assert.equal(subMonths("2026-03-10", 12), "2025-03-10");
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2024-02-28", 1), "2024-02-29");
});

test("parseDateRange defaults to the last 12 months and repairs bad input", () => {
  const now = new Date("2026-10-04T10:00:00Z");
  assert.deepEqual(parseDateRange({}, now), { from: "2025-10-04", to: "2026-10-04" });
  assert.deepEqual(parseDateRange({ from: "2026-01-01", to: "2026-01-31" }, now), { from: "2026-01-01", to: "2026-01-31" });
  // Only `to` given: 12 months before it.
  assert.deepEqual(parseDateRange({ to: "2024-12-31" }, now), { from: "2023-12-31", to: "2024-12-31" });
  // Invalid values fall back to the defaults; reversed dates are swapped.
  assert.deepEqual(parseDateRange({ from: "nope", to: "2026-02-31" }, now), { from: "2025-10-04", to: "2026-10-04" });
  assert.deepEqual(parseDateRange({ from: "2026-03-01", to: "2026-02-01" }, now), { from: "2026-02-01", to: "2026-03-01" });
  assert.deepEqual(parseDateRange({ from: ["2026-01-01"], to: {} }, now), { from: "2025-10-04", to: "2026-10-04" });
});

test("parseGroup only accepts day, week, month, year", () => {
  for (const g of ["day", "week", "month", "year"]) assert.equal(parseGroup(g), g);
  assert.equal(parseGroup("decade"), "month");
  assert.equal(parseGroup(undefined), "month");
  assert.equal(parseGroup("month'; --"), "month");
});

test("aging buckets: exactly 3, 6 and 12 months back fall in the older bucket", () => {
  const today = "2026-10-04";
  assert.deepEqual(agingCutoffs(today), { m3: "2026-07-04", m6: "2026-04-04", m12: "2025-10-04" });
  assert.equal(agingBucket("2026-10-04", today), "0-3");
  assert.equal(agingBucket("2026-07-05", today), "0-3");
  assert.equal(agingBucket("2026-07-04", today), "3-6", "exactly 3 months old");
  assert.equal(agingBucket("2026-04-05", today), "3-6");
  assert.equal(agingBucket("2026-04-04", today), "6-12", "exactly 6 months old");
  assert.equal(agingBucket("2025-10-05", today), "6-12");
  assert.equal(agingBucket("2025-10-04", today), "12+", "exactly 12 months old");
  assert.equal(agingBucket("2019-01-01", today), "12+");
  assert.equal(agingBucket("2027-01-01", today), "0-3", "a date in the future is new stock");
  // End-of-month clamping: 31 May minus 3 months is 28 February.
  assert.equal(agingCutoffs("2026-05-31").m3, "2026-02-28");
});

test("csvCell: no quotes, | becomes /, line breaks become a space, spreadsheet formulas are neutralised", () => {
  assert.equal(csvCell("plain"), "plain");
  assert.equal(csvCell('say "hi", ok; fine'), "say 'hi', ok; fine", "double quotes become apostrophes; commas and semicolons are left alone");
  assert.equal(csvCell("a|b|c"), "a/b/c");
  assert.equal(csvCell("line\nbreak"), "line break");
  assert.equal(csvCell("a\r\n\r\nb\t\tc"), "a b c");
  assert.equal(csvCell("=cmd"), "'=cmd");
  assert.equal(csvCell("+1+1"), "'+1+1");
  assert.equal(csvCell("-2+3"), "'-2+3");
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
  assert.equal(csvCell("\t=cmd"), "'\t=cmd".replace("\t", " "));
  assert.equal(csvCell("\n=cmd"), "' =cmd");
  assert.equal(csvCell("a=b"), "a=b", "only a leading character matters");
  assert.equal(csvCell("café"), "café");
  assert.equal(csvCell(12.5), "12.5");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
});

test("formatCell: euros with 2 decimals, integers, percentages, blanks", () => {
  assert.equal(formatCell(5, "eur"), "€5.00");
  assert.equal(formatCell(5, "eur", { csv: true }), "5.00");
  assert.equal(formatCell(6.875, "eur"), "€6.88");
  assert.equal(formatCell("3", "int"), "3");
  assert.equal(formatCell(66.666, "pct"), "66.7%");
  assert.equal(formatCell(66.666, "pct", { csv: true }), "66.7");
  assert.equal(formatCell(null, "eur"), "");
  assert.equal(formatCell(0, "int"), "0");
});

test("toCsv: BOM, header row, unquoted text, | separator, decimal point, totals row, CRLF", () => {
  const csv = toCsv({
    columns: [{ key: "t", label: "Title", type: "text" }, { key: "n", label: "Copies", type: "int" }, { key: "v", label: "Value", type: "eur" }],
    rows: [{ t: "=evil()", n: 2, v: 10 }, { t: 'A "quoted", title', n: 1, v: 0.5 }, { t: "Empty", n: 0, v: null }],
    totals: { t: "Total", n: 3, v: 10.5 },
  });
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.deepEqual(csv.slice(1).split("\r\n"), [
    "Title|Copies|Value",
    "'=evil()|2|10.00",
    "A 'quoted', title|1|0.50",
    "Empty|0|",
    "Total|3|10.50",
    "",
  ]);
});

test("every report has a slug, title, one-line summary and a run function; slugs are unique", () => {
  const slugs = REPORTS.map((r) => r.slug);
  assert.deepEqual(slugs, ["inventory", "aging", "sales", "reservations", "sellthrough", "membership", "intake", "accounts", "accounting", "lookup-sources"]);
  assert.equal(new Set(slugs).size, slugs.length);
  for (const r of REPORTS) {
    assert.ok(r.title && r.summary && typeof r.run === "function");
    assert.equal(getReport(r.slug), r);
  }
  assert.equal(getReport("nope"), null);
});

test("normalizeSource keeps the four known sources and maps everything else to unknown", () => {
  for (const s of ["donation", "purchase", "lot", "other"]) assert.equal(normalizeSource(s), s);
  assert.equal(normalizeSource(""), null);
  assert.equal(normalizeSource("DONATION"), null);
  assert.equal(normalizeSource(undefined), null);
});
