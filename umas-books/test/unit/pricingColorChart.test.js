const { test } = require("node:test");
const assert = require("node:assert/strict");
const { colorChartRows } = require("../../src/lib/pricing/colorChart");
const { DEFAULT_SETTINGS } = require("../../src/lib/pricing/rules");

test("colour chart: the seven rows, in order, by kind of book, with Uma's wording", () => {
  const rows = colorChartRows(DEFAULT_SETTINGS);
  assert.deepEqual(rows.map((r) => [r.name, r.price, r.when]), [
    ["Orange", "1 euro", "Clearance"], ["Yellow", "3 euro", "Children's"], ["Green", "5 euro", "Mass Market"],
    ["Blue", "5 euro", "Trade"], ["Red", "10 euro", "Hardback"], ["Purple", "Special price", "Any other price"],
    ["White", "Publisher's price", "New book"],
  ]);
  const by = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(by.green.hex, "#237A3C");
  assert.equal(by.blue.hex, "#2F6FDE");
  assert.ok(!rows.some((r) => /\b8\b/.test(r.price)), "no 8 euro row");
});

test("colour chart: prices follow the settings", () => {
  const rows = colorChartRows({
    ...DEFAULT_SETTINGS, levels: [2.5, 6, 12], massMarketPrice: 4, tradePrice: 6, clearance: { ...DEFAULT_SETTINGS.clearance, price: 1.5 },
  });
  assert.deepEqual(rows.map((r) => r.price), ["1.5 euro", "2.5 euro", "4 euro", "6 euro", "12 euro", "Special price", "Publisher's price"]);
});
