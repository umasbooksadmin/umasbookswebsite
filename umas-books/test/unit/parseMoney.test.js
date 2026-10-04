// One shared check for every admin money / number input (lib/validation.js),
// and its use in resolveCopyPricing (lib/inventory.js).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseMoney, parseWholeNumber } = require("../../src/lib/validation");
const { resolveCopyPricing, isPurchasablePrice } = require("../../src/lib/inventory");

test("parseMoney accepts plain amounts, comma decimals and whitespace", () => {
  assert.deepEqual(parseMoney("4.5"), { value: 4.5 });
  assert.deepEqual(parseMoney("4,50"), { value: 4.5 });
  assert.deepEqual(parseMoney("  7 "), { value: 7 });
  assert.deepEqual(parseMoney("0"), { value: 0 });
  assert.deepEqual(parseMoney("10000"), { value: 10000 });
  assert.deepEqual(parseMoney(12.25), { value: 12.25 });
});

test("parseMoney: blank is an error unless allowBlank, then it is null", () => {
  for (const blank of ["", "   ", undefined, null]) {
    assert.match(parseMoney(blank).error, /required/);
    assert.deepEqual(parseMoney(blank, { allowBlank: true }), { value: null });
  }
});

test("parseMoney refuses NaN, text, exponent, Infinity, a trailing dot and repeated fields", () => {
  for (const bad of ["NaN", "abc", "1e3", "Infinity", "5.", ".5", "1 000", "€5", "0x10", ["1", "2"], {}, true, NaN, Infinity]) {
    const r = parseMoney(bad, { allowBlank: true });
    assert.ok(r.error, `${JSON.stringify(bad)} must be refused`);
    assert.equal(r.value, undefined);
  }
});

test("parseMoney refuses negatives, more than 2 decimals and amounts over the maximum", () => {
  assert.match(parseMoney("-1").error, /cannot be negative/);
  assert.match(parseMoney("1.234").error, /at most 2 decimals/);
  assert.match(parseMoney("1.230").error, /at most 2 decimals/);
  assert.match(parseMoney("10000.01").error, /between/);
  assert.match(parseMoney("99999").error, /between/);
  assert.match(parseMoney("0.5", { min: 1 }).error, /between €1\.00 and/);
  assert.match(parseMoney("5", { max: 4, label: "Cost" }).error, /^Cost must be/);
});

test("parseWholeNumber: range, blank and garbage", () => {
  const year = { min: 1000, max: 2027, allowBlank: true, label: "Published year" };
  assert.deepEqual(parseWholeNumber("1999", year), { value: 1999 });
  assert.deepEqual(parseWholeNumber("", year), { value: null });
  for (const bad of ["999", "2028", "19.5", "-5", "abc", "1e3", ["1999"], "99999999999"]) {
    assert.match(parseWholeNumber(bad, year).error, /Published year must be a whole number between 1000 and 2027/, JSON.stringify(bad));
  }
  assert.match(parseWholeNumber("", { min: 1, max: 5 }).error, /required/);
});

test("resolveCopyPricing (non-new): blank stays null, real money passes, bad values are refused", () => {
  assert.deepEqual(resolveCopyPricing("very_good", "", null), { price: null, publisherPrice: null });
  assert.deepEqual(resolveCopyPricing("very_good", undefined, null), { price: null, publisherPrice: null });
  assert.deepEqual(resolveCopyPricing("very_good", "6,5", null), { price: 6.5, publisherPrice: null });
  for (const bad of ["abc", "-3", "NaN", "10000.01", "4.999", "1e2"]) {
    const r = resolveCopyPricing("acceptable", bad, null);
    assert.ok(r.error, `${bad} must be refused`);
    assert.equal(r.price, undefined);
  }
});

test("resolveCopyPricing (new): loi Lang rules are unchanged", () => {
  assert.match(resolveCopyPricing("new", "", "").error, /publisher's price/);
  assert.deepEqual(resolveCopyPricing("new", "", "14.00"), { price: 14, publisherPrice: 14 });
  assert.deepEqual(resolveCopyPricing("new", "13.30", "14"), { price: 13.3, publisherPrice: 14 });
  assert.match(resolveCopyPricing("new", "10", "14").error, /between €13\.30 and €14\.00/);
  assert.match(resolveCopyPricing("new", "abc", "14").error, /Price must be/);
  assert.match(resolveCopyPricing("new", "13.999", "14").error, /at most 2 decimals/);
});

test("isPurchasablePrice: only a positive finite number is purchasable", () => {
  for (const ok of [0.01, 5, "7.50", 9999]) assert.equal(isPurchasablePrice(ok), true, String(ok));
  for (const bad of [null, undefined, "", 0, "0", "0.00", -1, "-2", NaN, "NaN", Infinity, "abc"]) assert.equal(isPurchasablePrice(bad), false, String(bad));
});
