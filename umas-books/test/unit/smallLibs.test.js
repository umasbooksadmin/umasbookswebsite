// Small pure helpers: sessionTone, classCapacity, inventory vocab and the
// calendar helpers' remaining branches.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { toneForClassTitle } = require("../../src/lib/sessionTone");
const { seatsTakenExpr, spotsLeft } = require("../../src/lib/classCapacity");
const inv = require("../../src/lib/inventory");
const cal = require("../../src/lib/calendar");

test("toneForClassTitle maps each track keyword to its tone", () => {
  assert.equal(toneForClassTitle("Little Explorers"), "tone-a");
  assert.equal(toneForClassTitle("Explorer club"), "tone-a");
  assert.equal(toneForClassTitle("Éveil musical"), "tone-b");
  assert.equal(toneForClassTitle("Eveil"), "tone-b");
  assert.equal(toneForClassTitle("Adventurers"), "tone-c");
  assert.equal(toneForClassTitle("Readers' circle"), "tone-d");
  assert.equal(toneForClassTitle("Teen talk"), "tone-e");
  assert.equal(toneForClassTitle("Café conversation"), "tone-f");
  assert.equal(toneForClassTitle("Adult evening"), "tone-f");
});

test("toneForClassTitle is case-insensitive and defaults to tone-a for unknown/missing titles", () => {
  assert.equal(toneForClassTitle("TEEN"), "tone-e");
  assert.equal(toneForClassTitle("Pottery"), "tone-a");
  assert.equal(toneForClassTitle(""), "tone-a");
  assert.equal(toneForClassTitle(null), "tone-a");
  assert.equal(toneForClassTitle(undefined), "tone-a");
});

test("spotsLeft: unlimited capacity is null, never negative, tolerates string counts", () => {
  assert.equal(spotsLeft({ capacity: null, seats_taken: 3 }), null);
  assert.equal(spotsLeft({ capacity: undefined }), null);
  assert.equal(spotsLeft({ capacity: 10, seats_taken: 4 }), 6);
  assert.equal(spotsLeft({ capacity: 10, seats_taken: "4" }), 6);
  assert.equal(spotsLeft({ capacity: 10 }), 10);
  assert.equal(spotsLeft({ capacity: 3, seats_taken: 9 }), 0, "oversold never shows negative spots");
  assert.equal(spotsLeft({ capacity: 0, seats_taken: 0 }), 0);
});

test("seatsTakenExpr counts both legacy sign-ups and in_cart/reserved/sold drop-in seats for the alias (a reserved seat holds its place; a released one does not)", () => {
  const sql = seatsTakenExpr("cl");
  assert.match(sql, /class_signups s WHERE s\.class_id = cl\.id/);
  assert.match(sql, /class_dropin_seats d WHERE d\.class_id = cl\.id AND d\.status IN \('in_cart', 'reserved', 'sold'\)/);
  assert.doesNotMatch(sql, /released/);
});

test("inventory vocab: normalizers accept exactly the listed values", () => {
  for (const c of inv.CONDITIONS) assert.equal(inv.normalizeCondition(c.value), c.value);
  for (const s of inv.STATUSES) assert.equal(inv.normalizeStatus(s.value), s.value);
  assert.deepEqual(inv.CONDITIONS.map((c) => c.value), ["new", "very_good", "good", "acceptable"]);
  assert.deepEqual(inv.STATUSES.map((s) => s.value), ["in_stock", "reserved", "sold", "donated", "damaged"]);
});

test("inventory normalizers reject near-misses and non-strings", () => {
  assert.equal(inv.normalizeCondition("Like_New"), "very_good");
  assert.equal(inv.normalizeCondition("NEW"), "very_good", "no case folding");
  assert.equal(inv.normalizeCondition(null), "very_good");
  assert.equal(inv.normalizeCondition({}), "very_good");
  assert.equal(inv.normalizeStatus("SOLD"), "in_stock");
  assert.equal(inv.normalizeStatus(" sold"), "in_stock");
  assert.equal(inv.normalizeStatus(["sold"]), "in_stock");
});

test("normalizeGenres copes with non-string input", () => {
  assert.equal(inv.normalizeGenres(null), null);
  assert.equal(inv.normalizeGenres(["a", "b"]), "a, b");
});

test("calendar: dateKey accepts Date and ISO string, zero-pads", () => {
  assert.equal(cal.dateKey(new Date(2026, 0, 5)), "2026-01-05");
  assert.equal(cal.dateKey("2026-03-09T12:00:00"), "2026-03-09");
});

test("calendar: monthParam/shiftMonth wrap across year boundaries", () => {
  assert.equal(cal.monthParam(2026, 0), "2026-01");
  assert.deepEqual(cal.shiftMonth(2026, 11, 1), { year: 2027, month: 0 });
  assert.deepEqual(cal.shiftMonth(2026, 0, -1), { year: 2025, month: 11 });
});

test("calendar: monthLabel, monthRange and monthNav", () => {
  assert.equal(cal.monthLabel(2026, 2), "March 2026");
  const { start, end } = cal.monthRange(2026, 11);
  assert.equal(cal.dateKey(start), "2026-12-01");
  assert.equal(cal.dateKey(end), "2027-01-01");
  assert.deepEqual(cal.monthNav(2026, 0), { monthLabel: "January 2026", prevMonth: "2025-12", nextMonth: "2026-02", currentMonth: "2026-01" });
});

test("calendar: monthGrid pads to whole Sunday-first weeks and places items", () => {
  // March 2026 starts on a Sunday and has 31 days -> 5 rows, 4 trailing nulls.
  const weeks = cal.monthGrid(2026, 2, { "2026-03-10": [{ id: 1 }] });
  assert.equal(weeks.length, 5);
  assert.ok(weeks.every((w) => w.length === 7));
  assert.equal(weeks[0][0].day, 1);
  assert.equal(weeks[4].filter((c) => c === null).length, 4);
  const cell = weeks.flat().find((c) => c && c.dateKey === "2026-03-10");
  assert.deepEqual(cell.items, [{ id: 1 }]);
  // April 2026 starts on a Wednesday -> 3 leading nulls
  const apr = cal.monthGrid(2026, 3, {});
  assert.deepEqual(apr[0].map((c) => c === null), [true, true, true, false, false, false, false]);
});

test("calendar: monthGrid marks today", () => {
  const now = new Date();
  const flat = cal.monthGrid(now.getFullYear(), now.getMonth(), {}).flat().filter(Boolean);
  assert.equal(flat.filter((c) => c.isToday).length, 1);
  assert.equal(flat.find((c) => c.isToday).day, now.getDate());
});

test("calendar: mondayFirstWeeks re-chunks so weeks run Monday to Sunday", () => {
  // April 2026: 1st is a Wednesday -> Monday-first has 2 leading nulls.
  const weeks = cal.mondayFirstWeeks(cal.monthGrid(2026, 3, {}));
  assert.deepEqual(weeks[0].map((c) => c && c.day), [null, null, 1, 2, 3, 4, 5]);
  assert.ok(weeks.every((w) => w.length === 7));
  // A month starting on Sunday (March 2026) gets 6 leading nulls Monday-first.
  const mar = cal.mondayFirstWeeks(cal.monthGrid(2026, 2, {}));
  assert.equal(mar[0].filter((c) => c === null).length, 6);
  assert.equal(mar[0][6].day, 1);
});

test("calendar: week helpers", () => {
  const wed = new Date(2026, 2, 18); // a Wednesday
  assert.equal(cal.dateKey(cal.parseWeekParam("2026-03-18", 0)), "2026-03-15", "Sunday start");
  assert.equal(cal.dateKey(cal.parseWeekParam("2026-03-18", 1)), "2026-03-16", "Monday start");
  assert.equal(cal.dateKey(cal.parseWeekParam("2026-03-15", 0)), "2026-03-15", "already a week start");
  assert.equal(cal.dateKey(cal.parseWeekParam("2026-03-15", 1)), "2026-03-09", "Sunday belongs to the previous Monday-first week");
  assert.equal(cal.parseWeekParam("garbage", 1).getDay(), 1);
  assert.equal(cal.dateKey(cal.shiftWeek(wed, 1)), "2026-03-25");
  assert.equal(cal.dateKey(cal.shiftWeek(wed, -2)), "2026-03-04");
  const { start, end } = cal.weekRange(cal.parseWeekParam("2026-03-18", 1));
  assert.equal(cal.dateKey(start), "2026-03-16");
  assert.equal(cal.dateKey(end), "2026-03-23");
});

test("calendar: weekLabel covers same-month, cross-month and cross-year weeks", () => {
  assert.equal(cal.weekLabel(new Date(2026, 2, 9)), "March 9–15, 2026");
  assert.equal(cal.weekLabel(new Date(2026, 2, 30)), "March 30 – April 5, 2026");
  assert.equal(cal.weekLabel(new Date(2025, 11, 29)), "December 29, 2025 – January 4, 2026");
});

test("calendar: weekGrid is 7 real days with items; weekNav links prev/next", () => {
  const start = new Date(2026, 2, 9);
  const days = cal.weekGrid(start, { "2026-03-11": [{ id: 7 }] });
  assert.deepEqual(days.map((d) => d.day), [9, 10, 11, 12, 13, 14, 15]);
  assert.deepEqual(days[2].items, [{ id: 7 }]);
  assert.deepEqual(days[0].items, []);
  const nav = cal.weekNav(start);
  assert.deepEqual([nav.prevWeek, nav.currentWeek, nav.nextWeek], ["2026-03-02", "2026-03-09", "2026-03-16"]);
  assert.equal(nav.weekLabel, "March 9–15, 2026");
});

test("calendar: resolveCalendarRange builds weeks for both views", () => {
  const wk = cal.resolveCalendarRange({ view: "week", week: "2026-03-18" }, 1);
  const grid = wk.buildWeeks({});
  assert.equal(grid.length, 1);
  assert.equal(grid[0].length, 7);
  assert.equal(wk.nav.currentWeek, "2026-03-16");
  const mo = cal.resolveCalendarRange({ month: "2026-04" }, 0);
  assert.equal(mo.nav.currentMonth, "2026-04");
  assert.equal(mo.buildWeeks({})[0].filter((c) => c === null).length, 3);
  assert.equal(cal.resolveCalendarRange({ view: "bogus", month: "2026-04" }, 0).view, "month", "unknown view falls back to month");
});

test("calendar: calendarBackQuery needs a week value for week view", () => {
  assert.equal(cal.calendarBackQuery({ view: "week" }), "");
  assert.equal(cal.calendarBackQuery({ view: "week", month: "2026-03" }), "month=2026-03");
});
