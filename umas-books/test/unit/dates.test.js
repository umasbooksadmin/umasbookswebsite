const { test } = require("node:test");
const assert = require("node:assert/strict");
const { formatTime, formatDate, formatDateTime, parseLocalDateTime, weeklyDateTimes } = require("../../src/lib/dates");

// Uma's Books is in Albi: typed times mean Europe/Paris (UTC+2 in summer,
// UTC+1 in winter), never UTC. See lib/tz.js and migration 033.

test("a typed summer time is read as Paris time (UTC+2)", () => {
  const d = parseLocalDateTime("2026-07-15", "18:00");
  assert.equal(d.toISOString(), "2026-07-15T16:00:00.000Z");
  assert.equal(formatTime(d), "18:00");
});

test("a typed winter time is read as Paris time (UTC+1)", () => {
  const d = parseLocalDateTime("2026-01-15T18:00");
  assert.equal(d.toISOString(), "2026-01-15T17:00:00.000Z");
  assert.equal(formatTime(d), "18:00");
});

test("display is Paris time whatever the stored instant, and independent of the host timezone", () => {
  const instant = new Date("2026-07-15T16:00:00.000Z");
  assert.equal(formatTime(instant), "18:00");
  assert.equal(formatDate(instant), "15/07/2026");
  assert.match(formatDateTime(instant), /15\/07\/2026.*18:00/);
  // Late evening UTC is already the next day in Paris.
  assert.equal(formatDate(new Date("2026-07-15T22:30:00.000Z")), "16/07/2026");
});

test("anything that is not a real date/time is rejected instead of stored", () => {
  for (const bad of [undefined, null, "", "nope", "2026-13-45T99:99", "2026-07-15", "2026-07-15T25:00", ["2026-07-15T18:00"]]) {
    assert.equal(parseLocalDateTime(bad), null, JSON.stringify(bad));
  }
  assert.equal(parseLocalDateTime("2026-07-15", ""), null, "date alone is not a date-time");
});

test("a weekly repeat keeps the same Paris wall-clock time across the October clock change", () => {
  // Sunday 25 Oct 2026 is when Paris moves from UTC+2 to UTC+1.
  const weeks = weeklyDateTimes("2026-10-20", "18:00", 3);
  assert.deepEqual(weeks.map((d) => d.toISOString()), [
    "2026-10-20T16:00:00.000Z", // summer time, UTC+2
    "2026-10-27T17:00:00.000Z", // winter time, UTC+1 — still 18:00 in Paris
    "2026-11-03T17:00:00.000Z",
  ]);
  for (const d of weeks) assert.equal(formatTime(d), "18:00");
});

test("weeklyDateTimes returns nothing for an invalid start", () => {
  assert.deepEqual(weeklyDateTimes("bogus", "18:00", 4), []);
});
