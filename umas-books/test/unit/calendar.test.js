const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseMonthParam, groupByDate, calendarBackQuery, resolveCalendarRange } = require("../../src/lib/calendar");

test("parseMonthParam parses a valid YYYY-MM", () => {
  assert.deepEqual(parseMonthParam("2026-03"), { year: 2026, month: 2 }); // month is 0-indexed
});

test("parseMonthParam falls back to the current month for garbage input", () => {
  const now = new Date();
  assert.deepEqual(parseMonthParam("not-a-month"), { year: now.getFullYear(), month: now.getMonth() });
  assert.deepEqual(parseMonthParam(undefined), { year: now.getFullYear(), month: now.getMonth() });
});

test("groupByDate buckets rows by their date field's calendar day", () => {
  const rows = [
    { id: 1, starts_at: new Date(2026, 2, 15, 9, 0) },
    { id: 2, starts_at: new Date(2026, 2, 15, 18, 0) },
    { id: 3, starts_at: new Date(2026, 2, 16, 9, 0) },
  ];
  const grouped = groupByDate(rows, "starts_at");
  assert.equal(grouped["2026-03-15"].length, 2);
  assert.equal(grouped["2026-03-16"].length, 1);
});

test("calendarBackQuery reconstructs a month query", () => {
  assert.equal(calendarBackQuery({ month: "2026-03" }), "month=2026-03");
});

test("calendarBackQuery reconstructs a week query", () => {
  assert.equal(calendarBackQuery({ view: "week", week: "2026-03-15" }), "view=week&week=2026-03-15");
});

test("calendarBackQuery is empty when neither is present", () => {
  assert.equal(calendarBackQuery({}), "");
});

test("resolveCalendarRange month view covers the full calendar month", () => {
  const range = resolveCalendarRange({ month: "2026-03" }, 0);
  assert.equal(range.view, "month");
  assert.equal(range.start.getFullYear(), 2026);
  assert.equal(range.start.getMonth(), 2);
  assert.equal(range.start.getDate(), 1);
  assert.equal(range.end.getMonth(), 3); // exclusive end is the 1st of the next month
});

test("resolveCalendarRange week view covers exactly 7 days", () => {
  const range = resolveCalendarRange({ view: "week", week: "2026-03-15" }, 0);
  assert.equal(range.view, "week");
  const diffDays = (range.end - range.start) / (1000 * 60 * 60 * 24);
  assert.equal(diffDays, 7);
});
