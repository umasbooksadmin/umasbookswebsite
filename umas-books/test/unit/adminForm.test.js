const { test } = require("node:test");
const assert = require("node:assert/strict");
const { lengthProblem, timeRangeProblem, typedButInvalid, LIMITS } = require("../../src/lib/adminForm");

test("lengthProblem names the first field over its limit, and nothing at the limit", () => {
  assert.equal(lengthProblem([["The title", "x".repeat(200), 200], ["The notes", null, 10], ["The agenda", undefined, 10]]), null);
  const msg = lengthProblem([["The title", "x".repeat(10), 20], ["The location", "y".repeat(2001), 200], ["The notes", "z".repeat(9999), 5]]);
  assert.match(msg, /^The location is too long \(2,001 characters; the limit is 200\)\. Nothing was saved\.$/);
  assert.ok(LIMITS.title <= LIMITS.text && LIMITS.text <= LIMITS.longText);
});

test("timeRangeProblem: an end equal to or before the start is a problem; no end, or a later end, is fine", () => {
  const a = new Date("2031-05-14T10:00:00Z");
  assert.equal(timeRangeProblem(a, null), null);
  assert.equal(timeRangeProblem(null, a), null);
  assert.equal(timeRangeProblem(a, new Date("2031-05-14T10:00:01Z")), null);
  assert.match(timeRangeProblem(a, a, "An event"), /^An event must end after it starts/);
  assert.match(timeRangeProblem(a, new Date("2031-05-14T09:00:00Z")), /^It must end after it starts/);
});

test("typedButInvalid tells a blank field from a bad value", () => {
  assert.equal(typedButInvalid("", null), false);
  assert.equal(typedButInvalid("  ", null), false);
  assert.equal(typedButInvalid(undefined, null), false);
  assert.equal(typedButInvalid("2031-02-30T10:00", null), true);
  assert.equal(typedButInvalid("2031-05-14T10:00", new Date()), false);
});
