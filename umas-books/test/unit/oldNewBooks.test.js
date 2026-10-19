// A New-condition book published MORE than 2 years ago is free-priced (publisher's price optional, no 95-100% rule);
// everything else about New books is unchanged (lib/inventory.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveCopyPricing, isPublishedOverTwoYearsAgo: old } = require("../../src/lib/inventory");

test("isPublishedOverTwoYearsAgo: exact boundary of a full date and a month", () => {
  // Published 2024-03-15: exactly 2 years on 2026-03-15 (not more), more than 2 years the day after.
  assert.equal(old("2024-03-15", "2026-03-15"), false);
  assert.equal(old("2024-03-15", "2026-03-16"), true);
  assert.equal(old("2024-03-15", "2026-03-14"), false);
  // A month is judged by its END (31 March 2024): old from 1 April 2026.
  assert.equal(old("2024-03", "2026-03-31"), false);
  assert.equal(old("2024-03", "2026-04-01"), true);
  assert.equal(old("2024-02-29", "2026-02-28"), false);
  assert.equal(old("2024-02-29", "2026-03-01"), true);
});

test("isPublishedOverTwoYearsAgo: a year-only value counts from the END of that year (conservative)", () => {
  assert.equal(old(2024, "2026-12-31"), false); // 31 Dec 2024 is exactly 2 years back
  assert.equal(old(2024, "2027-01-01"), true);
  assert.equal(old("2023", "2026-01-01"), true);
  assert.equal(old("2023", "2025-12-31"), false);
  assert.equal(old(2024, "2026-01-01"), false, "published sometime in 2024 may be under 2 years old");
  assert.equal(old(2000, "2026-10-19"), true);
});

test("isPublishedOverTwoYearsAgo: missing, invalid and future dates keep the rule", () => {
  for (const v of [null, undefined, "", "abc", "20x4", "2024-13", "2024-00-10", "2024-02-30", 12, "0999", "2024-1-2-3", NaN]) {
    assert.equal(old(v, "2030-01-01"), false, String(v));
  }
  assert.equal(old(2099, "2026-10-19"), false);
});

test("isPublishedOverTwoYearsAgo: today defaults to the Europe/Paris date", () => {
  const y = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric" }).format(new Date()));
  assert.equal(old(y - 3), true);
  assert.equal(old(y - 2), false);
});

test("resolveCopyPricing (new, recent or unknown date): the loi Lang rules are unchanged", () => {
  for (const opts of [undefined, {}, { publishedYear: null }, { publishedYear: "" }, { publishedYear: "junk" }, { publishedYear: 2024, today: "2026-12-31" }, { publishedYear: 2099 }]) {
    assert.match(resolveCopyPricing("new", "", "", opts).error, /publisher's price/, JSON.stringify(opts));
    assert.match(resolveCopyPricing("new", "5", "", opts).error, /publisher's price/);
    assert.match(resolveCopyPricing("new", "5", "20", opts).error, /between €19\.00 and €20\.00/);
    assert.deepEqual(resolveCopyPricing("new", "", "14.00", opts), { price: 14, publisherPrice: 14 });
    assert.deepEqual(resolveCopyPricing("new", "19", "20", opts), { price: 19, publisherPrice: 20 });
  }
});

test("resolveCopyPricing (new, over 2 years old): publisher's price optional, any price allowed", () => {
  const o = { publishedYear: 2024, today: "2027-01-01" };
  assert.deepEqual(resolveCopyPricing("new", "5", "", o), { price: 5, publisherPrice: null });
  assert.deepEqual(resolveCopyPricing("new", "5", undefined, o), { price: 5, publisherPrice: null });
  assert.deepEqual(resolveCopyPricing("new", "5", null, o), { price: 5, publisherPrice: null });
  // blank price and no publisher's price: stays null (manual review), like used books
  assert.deepEqual(resolveCopyPricing("new", "", "", o), { price: null, publisherPrice: null });
  // a typed publisher's price is stored; a blank price defaults to it as before
  assert.deepEqual(resolveCopyPricing("new", "", "20", o), { price: 20, publisherPrice: 20 });
  assert.deepEqual(resolveCopyPricing("new", "5", "20", o), { price: 5, publisherPrice: 20 });
  assert.deepEqual(resolveCopyPricing("new", "25", "20", o), { price: 25, publisherPrice: 20 });
});

test("resolveCopyPricing (new, over 2 years old): typed values are still validated", () => {
  const o = { publishedYear: 2000 };
  assert.match(resolveCopyPricing("new", "5", "abc", o).error, /Publisher's price/);
  assert.match(resolveCopyPricing("new", "5", "-3", o).error, /Publisher's price/);
  assert.match(resolveCopyPricing("new", "5", "0", o).error, /above 0/);
  assert.match(resolveCopyPricing("new", "5", "1.999", o).error, /Publisher's price/);
  assert.ok(resolveCopyPricing("new", "abc", "", o).error);
  assert.ok(resolveCopyPricing("new", "-1", "", o).error);
});

test("resolveCopyPricing: used books are untouched by the date", () => {
  assert.deepEqual(resolveCopyPricing("good", "", "", { publishedYear: 2000 }), { price: null, publisherPrice: null });
  assert.deepEqual(resolveCopyPricing("good", "4", "9", { publishedYear: 2026 }), { price: 4, publisherPrice: null });
});
