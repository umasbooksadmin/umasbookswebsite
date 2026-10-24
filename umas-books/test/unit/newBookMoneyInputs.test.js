// Review C (C-M3): a new book's prices go through the shared parseMoney (comma or dot, 2 decimals, digits only),
// then the 95-100% rule is computed in whole cents. The same strictness for the other money inputs found with
// the same weakness: the cash received on a reservation, the pricing settings form, a publisher's price text.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { resolveCopyPricing } = require("../../src/lib/inventory");
const { validateSettingsInput } = require("../../src/lib/pricing/settings");
const { suggestFromRules } = require("../../src/lib/pricing/rules");

const recent = { publishedYear: 2026, today: "2026-10-24" };
const nw = (price, pub) => resolveCopyPricing("new", price, pub, recent);

test("new book: a comma price is accepted like a dot price", () => {
  assert.deepEqual(nw("9,50", "10.00"), { price: 9.5, publisherPrice: 10 });
  assert.deepEqual(nw("", "10,00"), { price: 10, publisherPrice: 10 });
  assert.deepEqual(nw("9,50", "10,00"), nw("9.50", "10.00"));
  assert.deepEqual(nw(" 9,50 ", "10.00"), { price: 9.5, publisherPrice: 10 });
  assert.deepEqual(nw("9,5", "10"), { price: 9.5, publisherPrice: 10 });
});

test("new book: hex, exponent, 3+ decimals, negative and junk are refused, never coerced", () => {
  for (const bad of ["0x0A", "1e1", "10.005", "9,500", "-9", "abc", "Infinity", "9..5"]) {
    assert.ok(nw(bad, "10").error, `typed price ${bad}`);
    assert.ok(nw("", bad).error, `publisher price ${bad}`);
  }
  assert.match(nw("", "").error, /need the publisher's price/);
  assert.match(nw("0x0A", "10").error, /number/);
});

test("new book: the 95-100% rule and its euro-formatted message are unchanged", () => {
  assert.equal(nw("9.49", "10").error, "A new book must be sold at the publisher's price (€10.00), with at most 5% off: the price must be between €9.50 and €10.00.");
  assert.ok(nw("10.01", "10").error);
  assert.equal(nw("9.50", "10").price, 9.5);
  assert.equal(nw("12.26", "12.90").price, 12.26);
});

test("an old new book keeps the 2-year rule and NULL handling", () => {
  const old = { publishedYear: 2020, today: "2026-10-24" };
  assert.deepEqual(resolveCopyPricing("new", "4,50", "", old), { price: 4.5, publisherPrice: null });
  assert.deepEqual(resolveCopyPricing("new", "", "", old), { price: null, publisherPrice: null });
  assert.deepEqual(resolveCopyPricing("new", "", "10,00", old), { price: 10, publisherPrice: 10 });
});

test("pricing settings form: hex and exponent are not numbers; comma decimals still work", () => {
  const GOOD = {
    levels: "3, 5, 10", mass_market_price: "5", trade_price: "5", hardcover_min_price: "10", a_max: "6", a_price: "5", b_max: "20", b_price: "10",
    c_max: "50", c_factor: "0.75", used_fraction: "0.35", rounding_step: "0.5",
    fallback_hardcover: "12", fallback_trade: "5", fallback_mass_market: "5", fallback_unknown: "5",
    usd_eur: "0.92", gbp_eur: "1.15", clearance_after_copies: "2", clearance_price: "1",
    clearance_scope: "extra", clearance_applies_to: "set_a",
  };
  assert.equal(validateSettingsInput({ ...GOOD, a_price: "4,5" }).values.a_price, 4.5);
  for (const bad of ["0x0A", "1e1", "Infinity"]) {
    assert.match(validateSettingsInput({ ...GOOD, trade_price: bad }).error, /enter a number/, bad);
  }
  assert.ok(validateSettingsInput({ ...GOOD, levels: "3, 0x5, 10" }).error);
  assert.deepEqual(validateSettingsInput({ ...GOOD, levels: "3, 5.50, 10" }).values.levels, [3, 5.5, 10]);
});

test("a publisher's price typed with a comma still feeds the price suggestion; hex/exponent do not", () => {
  const base = { condition: "new", binding: "paperback", comparables: [], marketEur: null, existingCopies: 0 };
  const withPub = (p) => JSON.stringify(suggestFromRules({ ...base, publisherPrice: p }));
  assert.equal(withPub("12,90"), withPub("12.90"));
  assert.notEqual(withPub("12,90"), withPub(""));
  assert.equal(withPub("0x0A"), withPub(""));
  assert.equal(withPub("1e1"), withPub(""));
});
