const { test } = require("node:test");
const assert = require("node:assert/strict");
const { colorChartRows } = require("../../src/lib/pricing/colorChart");
const { DEFAULT_SETTINGS } = require("../../src/lib/pricing/rules");

test("colour chart: all seven colours with names and the original scheme at the default prices", () => {
  const rows = colorChartRows(DEFAULT_SETTINGS);
  assert.deepEqual(rows.map((r) => [r.name, r.price]), [
    ["Orange", "EUR 1"], ["Yellow", "EUR 3"], ["Green", "EUR 5"], ["Blue", "EUR 8"], ["Red", "EUR 10"],
    ["Purple", "Special price"], ["White", "Publisher's price"],
  ]);
  assert.equal(rows.find((r) => r.key === "green").hex, "#237A3C");
});

test("colour chart: follows the standard prices, and marks unused colours", () => {
  const rows = colorChartRows({ ...DEFAULT_SETTINGS, levels: [2.5, 6, 9], clearance: { ...DEFAULT_SETTINGS.clearance, price: 1.5 } });
  const by = Object.fromEntries(rows.map((r) => [r.key, r.price]));
  assert.deepEqual([by.orange, by.yellow, by.green, by.blue, by.red], ["EUR 1.50", "EUR 2.50", "EUR 6", "EUR 9", "Not in use"]);
});
