// Review F, F5: a membership lasts ONE CALENDAR YEAR in Paris time and ends at the last instant of that Paris day
// (not 365 days: a leap year ended a day early, and the end hour drifted across a clock change). Renewal chaining
// (a payment made while the membership still runs starts when it ends) is kept.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { expiryFromPayments } = require("../../src/lib/membership");

const end = (paid) => expiryFromPayments(Array.isArray(paid) ? paid : [paid]).toISOString();

test("the review's example: paid 2027-03-01 runs through 2028-03-01 (the old 365 days gave 2028-02-29 11:00Z)", () => {
  assert.equal(end("2027-03-01T12:00:00+01:00"), "2028-03-01T22:59:59.999Z"); // 23:59:59.999 Paris, CET
});

test("paid on 29 February: the end is the last day of February the next year", () => {
  assert.equal(end("2028-02-29T10:00:00+01:00"), "2029-02-28T22:59:59.999Z");
});

test("the end is the end of the Paris day, in summer time too", () => {
  assert.equal(end("2026-07-14T09:00:00+02:00"), "2027-07-14T21:59:59.999Z"); // 23:59:59.999 CEST
});

test("clock-change days: 2026-10-25 and 2027-03-28 (the end hour does not drift)", () => {
  assert.equal(end("2026-10-25T01:30:00+02:00"), "2027-10-25T21:59:59.999Z"); // paid on the day summer time ended; a year later it is summer time again
  assert.equal(end("2026-11-05T10:00:00+01:00"), "2027-11-05T22:59:59.999Z"); // paid in winter time, ends 23:59 Paris winter time
  assert.equal(end("2027-03-28T12:00:00+02:00"), "2028-03-28T21:59:59.999Z"); // paid on the day summer time began
});

test("a payment just after midnight Paris counts as that Paris day, not the UTC day before", () => {
  assert.equal(end("2026-09-15T00:10:00+02:00"), "2027-09-15T21:59:59.999Z");
  assert.equal(end("2026-09-15T23:50:00+02:00"), "2027-09-15T21:59:59.999Z");
});

test("renewal chaining: paying early starts from the old last day, losing no time", () => {
  assert.equal(end(["2026-09-15T10:00:00+02:00", "2027-01-10T10:00:00+01:00"]), "2028-09-15T21:59:59.999Z");
  assert.equal(end(["2027-01-10T10:00:00+01:00", "2026-09-15T10:00:00+02:00"]), "2028-09-15T21:59:59.999Z", "order of the list does not matter");
});

test("renewing ON the last day still chains; the day after starts a new year", () => {
  assert.equal(end(["2026-09-15T10:00:00+02:00", "2027-09-15T20:00:00+02:00"]), "2028-09-15T21:59:59.999Z");
  assert.equal(end(["2026-09-15T10:00:00+02:00", "2027-09-16T00:05:00+02:00"]), "2028-09-16T21:59:59.999Z");
});

test("renewing after the membership lapsed starts from the payment day", () => {
  assert.equal(end(["2024-01-05T10:00:00+01:00", "2026-03-02T10:00:00+01:00"]), "2027-03-02T22:59:59.999Z");
});

test("three chained renewals and idempotence (the same payments always give the same end)", () => {
  const list = ["2026-01-10T10:00:00+01:00", "2026-06-01T10:00:00+02:00", "2026-12-24T10:00:00+01:00"];
  assert.equal(end(list), "2029-01-10T22:59:59.999Z");
  assert.equal(end(list), end([...list].reverse()));
});

test("no payments: null", () => {
  assert.equal(expiryFromPayments([]), null);
});
