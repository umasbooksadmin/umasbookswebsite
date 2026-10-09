const { test } = require("node:test");
const assert = require("node:assert/strict");
const { colorChartRows } = require("../../src/lib/pricing/colorChart");
const { DEFAULT_SETTINGS } = require("../../src/lib/pricing/rules");

test("colour chart: all seven colours with names and the original scheme at the default prices", () => {
  const rows = colorChartRows(DEFAULT_SETTINGS);
  assert.deepEqual(rows.map((r) => [r.name, r.price]), [
    ["Orange", "EUR 1"], ["Yellow", "EUR 3"], ["Green", "EUR 5"], ["Blue", "No longer used"], ["Red", "EUR 10"],
    ["Purple", "Special price"], ["White", "Publisher's price"],
  ]);
  assert.equal(rows.find((r) => r.key === "green").hex, "#237A3C");
});

test("colour chart: three prices are yellow, green, red; blue is shown as no longer used", () => {
  const by = Object.fromEntries(colorChartRows(DEFAULT_SETTINGS).map((r) => [r.key, r]));
  assert.match(by.blue.when, /EUR 8 is no longer a standard price/);
  assert.equal(by.red.price, "EUR 10");
});

test("colour chart: follows the standard prices, and marks unused colours", () => {
  const rows = colorChartRows({ ...DEFAULT_SETTINGS, levels: [2.5, 6, 9, 12], clearance: { ...DEFAULT_SETTINGS.clearance, price: 1.5 } });
  const by = Object.fromEntries(rows.map((r) => [r.key, r.price]));
  assert.deepEqual([by.orange, by.yellow, by.green, by.blue, by.red], ["EUR 1.50", "EUR 2.50", "EUR 6", "EUR 9", "EUR 12"]);
});

test("colour chart: with only two prices the unused colours say so", () => {
  const by = Object.fromEntries(colorChartRows({ ...DEFAULT_SETTINGS, levels: [3, 7] }).map((r) => [r.key, r.price]));
  assert.deepEqual([by.yellow, by.green, by.blue, by.red], ["EUR 3", "EUR 7", "Not in use", "Not in use"]);
});
