// The binding options are exactly: Hardcover, Trade, Mass Market, Other
// (the maintainer's words). Option keys and order, English and French labels,
// the legacy "paperback" alias, the catalogue-format mapping table and how
// the pricing rules treat "trade" and "other". The add/edit form markup and
// migration 077 are checked in the integration tests (adminInventory,
// conditionGrades).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const inv = require("../../src/lib/inventory");
const { mapBinding } = require("../../src/lib/bookLookup");
const { suggestFromRules, DEFAULT_SETTINGS } = require("../../src/lib/pricing/rules");
const { pricingBinding } = require("../../src/lib/pricing/forms");

test("exactly four bindings, in order, with their English and French labels", () => {
  assert.deepEqual(inv.BINDINGS.map((b) => b.value), ["hardcover", "trade", "mass_market", "other"]);
  assert.deepEqual(inv.BINDINGS.map((b) => b.label), ["Hardcover", "Trade", "Mass Market", "Other"]);
  assert.deepEqual(inv.BINDINGS.map((b) => b.label_fr), ["Relié", "Broché (grand format)", "Poche", "Autre"]);
  for (const b of inv.BINDINGS) {
    assert.equal(inv.bindingLabel(b.value, "en"), b.label);
    assert.equal(inv.bindingLabel(b.value, "fr"), b.label_fr);
    assert.equal(inv.bindingLabel(b.value), b.label, "English by default");
  }
});

test("the legacy value paperback is an alias of trade; unknown values are null", () => {
  assert.equal(inv.normalizeBinding("paperback"), "trade");
  assert.equal(pricingBinding("paperback"), "trade");
  assert.equal(inv.bindingLabel("paperback", "fr"), "Broché (grand format)");
  for (const bad of ["", "spiral", "Trade", null, undefined, 0, {}]) assert.equal(inv.normalizeBinding(bad), null, String(bad));
  assert.equal(inv.normalizeBinding("other"), "other");
});

test("lookup mapping table: hardcover, mass market / poche, other paperbacks = trade, anything else = other, nothing = unset", () => {
  const table = [
    ["Hardcover", "hardcover"], ["hardback", "hardcover"], ["Relié", "hardcover"],
    ["Mass Market Paperback", "mass_market"], ["Mass market", "mass_market"], ["Poche", "mass_market"],
    ["Paperback", "trade"], ["Trade Paperback", "trade"], ["Softcover", "trade"], ["Broché", "trade"], ["Perfect Paperback", "trade"],
    ["Board book", "other"], ["Spiral-bound", "other"], ["Audio CD", "other"], ["Cassette", "other"], ["Loose Leaf", "other"],
    ["", null], ["   ", null], [null, null], [undefined, null],
  ];
  for (const [input, expected] of table) assert.equal(mapBinding(input), expected, String(input));
});

test("pricing: trade behaves exactly like the old paperback; other goes through the normal rules (no floor, not mass market)", () => {
  const run = (binding, marketEur, existingCopies = 0) => {
    const r = suggestFromRules({ condition: "very_good", binding, isbn: "9780141036144", marketEur, existingCopies, settings: DEFAULT_SETTINGS });
    return [r.ruleSet, r.price];
  };
  assert.equal(DEFAULT_SETTINGS.fallbackEur.trade, 8);
  assert.equal(DEFAULT_SETTINGS.fallbackEur.paperback, undefined);
  for (const [market, copies, expected] of [[3, 0, ["A", 5]], [3, 2, ["clearance", 1]], [12, 0, ["B", 8]], [30, 0, ["C", 22.5]]]) {
    assert.deepEqual(run("trade", market, copies), expected, `trade ${market}/${copies}`);
    assert.deepEqual(run("other", market, copies), expected, `other ${market}/${copies}`);
    assert.deepEqual(run("trade", market, copies), run(null, market, copies));
  }
  assert.deepEqual(run("mass_market", 12), ["mass_market", 5], "mass market unchanged");
  assert.equal(run("hardcover", 3)[1], 10, "hardcover floor unchanged");
  assert.equal(run("other", 3)[1], 5, "no floor for other");
  assert.equal(run("trade", 3)[1], 5, "no floor for trade");
});
