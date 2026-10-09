"use strict";

// The month / year boundary logic of the accounting export (lib/accountingExport.js): Paris time,
// not the server's, including DST edges and the turn of the year. No database needed except that
// the module requires the till code, which reads DATABASE_URL at load time.
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://localhost:5432/never_connected";

const test = require("node:test");
const assert = require("node:assert/strict");
const ax = require("../../src/lib/accountingExport");

const at = (iso) => new Date(iso);

test("previousMonth uses the Paris calendar, not UTC", () => {
  // 00:30 on 1 November in Paris is still 31 October 23:30 UTC.
  assert.equal(ax.previousMonth(at("2026-10-31T23:30:00Z")), "2026-10");
  assert.equal(ax.currentMonth(at("2026-10-31T23:30:00Z")), "2026-11");
  assert.equal(ax.previousMonth(at("2026-10-31T22:30:00Z")), "2026-09"); // 23:30 Paris, still October
  assert.equal(ax.previousMonth(at("2026-11-01T06:00:00Z")), "2026-10");
});

test("previousMonth across the turn of the year", () => {
  assert.equal(ax.previousMonth(at("2027-01-01T06:00:00Z")), "2026-12");
  assert.equal(ax.previousMonth(at("2026-12-31T23:30:00Z")), "2026-12"); // already 1 January in Paris
  assert.equal(ax.previousMonth(at("2027-01-31T12:00:00Z")), "2026-12");
  assert.equal(ax.previousMonth(at("2027-02-01T06:00:00Z")), "2027-01");
});

test("monthRange: inclusive Paris dates, leap years, 30/31-day months", () => {
  assert.deepEqual(ax.monthRange("2026-10"), { kind: "month", label: "2026-10", folderYear: 2026, from: "2026-10-01", to: "2026-10-31" });
  assert.equal(ax.monthRange("2027-02").to, "2027-02-28");
  assert.equal(ax.monthRange("2028-02").to, "2028-02-29");
  assert.equal(ax.monthRange("2026-04").to, "2026-04-30");
  assert.equal(ax.monthRange("2026-12").to, "2026-12-31");
  // the DST months have no special handling in the dates: Postgres converts Paris midnights
  assert.equal(ax.monthRange("2026-03").to, "2026-03-31");
  assert.equal(ax.monthRange("2026-10").from, "2026-10-01");
});

test("parseMonth rejects anything that is not YYYY-MM", () => {
  for (const bad of ["2026-13", "2026-00", "2026-1", "26-10", "2026/10", "", undefined, "2026-10-01"]) assert.throws(() => ax.parseMonth(bad), /not a month/);
});

test("a month in the future or the current month is refused unless forced", () => {
  const now = at("2026-10-09T10:00:00Z");
  assert.throws(() => ax.checkMonthAllowed("2026-10", now), /current month/);
  assert.throws(() => ax.checkMonthAllowed("2026-11", now), /future/);
  assert.throws(() => ax.checkMonthAllowed("2027-01", now), /future/);
  assert.doesNotThrow(() => ax.checkMonthAllowed("2026-09", now));
  assert.doesNotThrow(() => ax.checkMonthAllowed("2026-10", now, true));
  // in Paris it is already November at 23:30 UTC on 31 October
  assert.doesNotThrow(() => ax.checkMonthAllowed("2026-10", at("2026-10-31T23:30:00Z")));
  assert.throws(() => ax.checkMonthAllowed("2026-10", at("2026-10-31T22:30:00Z")), /current month/);
});

test("yearRange: calendar year by default, a configurable financial year start", () => {
  assert.deepEqual(ax.yearRange(2026), { kind: "year", label: "2026-full-year", folderYear: 2026, startMonth: 1, from: "2026-01-01", to: "2026-12-31" });
  const fy = ax.yearRange(2026, 7);
  assert.equal(fy.from, "2026-07-01");
  assert.equal(fy.to, "2027-06-30");
  assert.equal(ax.yearRange(2027, 3).to, "2028-02-29"); // leap February closes a year starting in March
  assert.throws(() => ax.yearRange(2026, 13), /FISCAL_YEAR_START_MONTH/);
  assert.throws(() => ax.yearRange(2026, "abc"), /FISCAL_YEAR_START_MONTH/);
  assert.throws(() => ax.yearRange("x"), /not a year/);
});

test("lastFiscalYearStart: the most recent year that has fully ended", () => {
  assert.equal(ax.lastFiscalYearStart(at("2027-01-02T04:00:00Z"), 1), 2026);
  assert.equal(ax.lastFiscalYearStart(at("2026-12-31T22:00:00Z"), 1), 2025); // 31 Dec 23:00 Paris: 2026 is not over yet
  assert.equal(ax.lastFiscalYearStart(at("2026-12-31T23:30:00Z"), 1), 2026); // 1 Jan 2027 00:30 Paris: 2026 just ended
  assert.equal(ax.lastFiscalYearStart(at("2027-01-02T04:00:00Z"), 7), 2025); // FY Jul 2025 - Jun 2026
  assert.equal(ax.lastFiscalYearStart(at("2027-08-02T04:00:00Z"), 7), 2026);
});

test("the Paris hour gate: exactly one of the two UTC schedules passes on the 1st, summer and winter", () => {
  // The workflow runs at 05:00 and 06:00 UTC; the first step only lets 07:xx Paris on day 1 through.
  for (let month = 1; month <= 12; month++) {
    const day = `2027-${String(month).padStart(2, "0")}-01`;
    const passes = ["05", "06"].filter((h) => ax.isMonthlyRunTime(at(`${day}T${h}:00:00Z`)));
    assert.equal(passes.length, 1, `${day}: ${passes}`);
    const expected = [4, 5, 6, 7, 8, 9, 10].includes(month) ? "05" : "06"; // CEST 28 Mar - 31 Oct 2027
    assert.deepEqual(passes, [expected], day);
  }
  // DST edges: Sunday 28 March 2027 (spring forward) and 31 October 2027 (fall back) are not the 1st,
  // but the days around them must still behave.
  assert.equal(ax.isMonthlyRunTime(at("2027-04-01T05:00:00Z")), true);
  assert.equal(ax.isMonthlyRunTime(at("2027-03-01T06:00:00Z")), true);
  assert.equal(ax.isMonthlyRunTime(at("2027-11-01T06:00:00Z")), true);
  assert.equal(ax.isMonthlyRunTime(at("2027-11-01T05:00:00Z")), false);
  assert.equal(ax.isMonthlyRunTime(at("2027-04-02T05:00:00Z")), false);
});

test("parisParts at the spring-forward and fall-back instants", () => {
  assert.deepEqual(ax.parisParts(at("2026-03-29T00:59:59Z")), { y: 2026, m: 3, d: 29, h: 1 });
  assert.deepEqual(ax.parisParts(at("2026-03-29T01:00:00Z")), { y: 2026, m: 3, d: 29, h: 3 });
  assert.deepEqual(ax.parisParts(at("2026-10-25T00:30:00Z")), { y: 2026, m: 10, d: 25, h: 2 });
  assert.deepEqual(ax.parisParts(at("2026-10-25T01:30:00Z")), { y: 2026, m: 10, d: 25, h: 2 });
  assert.deepEqual(ax.parisParts(at("2026-12-31T23:00:00Z")), { y: 2027, m: 1, d: 1, h: 0 });
});

test("assertNoPersonalData: exact header, no email, no phone-like number; ordinary figures pass", () => {
  const ok = "﻿" + ax.ACCOUNTING_HEADER.map((h) => `"${h}"`).join(";") + "\r\n" +
    '"2026-09-10";"Books used";"Cash";2;10,00;"Ventes livres, espèces, 2026-09-10";"530";"707";"CA"\r\n';
  assert.doesNotThrow(() => ax.assertNoPersonalData("t", ok, ax.ACCOUNTING_HEADER));
  assert.throws(() => ax.assertNoPersonalData("t", ok.replace("Journal", "Buyer email"), ax.ACCOUNTING_HEADER), /not the expected list/);
  assert.throws(() => ax.assertNoPersonalData("t", ok + '"x@example.org"\r\n', ax.ACCOUNTING_HEADER), /email/);
  assert.throws(() => ax.assertNoPersonalData("t", ok + '"05 63 12 34 56"\r\n', ax.ACCOUNTING_HEADER), /phone/);
  assert.throws(() => ax.assertNoPersonalData("t", ok + '"+33 6 12 34 56 78"\r\n', ax.ACCOUNTING_HEADER), /phone/);
  assert.throws(() => ax.assertNoPersonalData("t", ok + '"0612345678"\r\n', ax.ACCOUNTING_HEADER), /phone/);
  assert.doesNotThrow(() => ax.assertNoPersonalData("t", "Receipt numbers: 2026-0001 to 2026-0412\r\nTotal 12 345,67 EUR 2026-10-01"));
});

test("eurText: decimal comma, sign, thousands", () => {
  assert.equal(ax.eurText(0), "0,00");
  assert.equal(ax.eurText(-50), "-0,50");
  assert.equal(ax.eurText(123456), "1 234,56");
});

test("the email says the months before October 2026 were overstated, and only those", () => {
  const stats = { accountingRows: 3, tillDays: 2, totalCents: 1000, sales: 2, refunds: 0, voids: 0, firstReceipt: "", lastReceipt: "", unclosedDays: 0 };
  assert.match(ax.emailBody(ax.monthRange("2026-09"), stats), /overstated/);
  assert.match(ax.emailBody(ax.monthRange("2026-09"), stats), /#265/);
  assert.doesNotMatch(ax.emailBody(ax.monthRange("2026-10"), stats), /overstated/);
  assert.match(ax.emailBody(ax.yearRange(2026), stats), /overstated/);
  assert.doesNotMatch(ax.emailBody(ax.yearRange(2027), stats), /overstated/);
  assert.match(ax.emailBody(ax.monthRange("2026-11"), { ...stats, accountingRows: 0, tillDays: 0 }), /No sales were recorded/);
});
