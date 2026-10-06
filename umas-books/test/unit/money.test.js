const test = require("node:test");
const assert = require("node:assert/strict");
const { formatEuro } = require("../../src/lib/money");

const NB = "\u00a0";

test("formatEuro: English is €12.50 (symbol first, dot, no grouping)", () => {
  assert.equal(formatEuro(12.5, "en"), "€12.50");
  assert.equal(formatEuro(0, "en"), "€0.00");
  assert.equal(formatEuro(5, "en"), "€5.00");
  assert.equal(formatEuro(1234.5, "en"), "€1234.50");
  assert.equal(formatEuro("12.50", "en"), "€12.50", "numeric strings from the database work");
  assert.equal(formatEuro(12.5), "€12.50", "no language means English");
});

test("formatEuro: French is 12,50 € (comma, non-breaking space, euro sign last)", () => {
  assert.equal(formatEuro(12.5, "fr"), `12,50${NB}€`);
  assert.equal(formatEuro(0, "fr"), `0,00${NB}€`);
  assert.equal(formatEuro(5, "fr"), `5,00${NB}€`);
  assert.match(formatEuro(1234.5, "fr"), /^1\s234,50\u00a0€$/u);
  assert.equal(formatEuro("12.50", "fr"), `12,50${NB}€`);
});

test("formatEuro: rounds to cents", () => {
  assert.equal(formatEuro(2.005, "en"), "€2.01");
  assert.equal(formatEuro(9.999, "fr"), `10,00${NB}€`);
  assert.equal(formatEuro(0.1 + 0.2, "en"), "€0.30");
});

test("formatEuro: nothing to show gives an empty string", () => {
  for (const v of [null, undefined, "", NaN, "abc", Infinity]) {
    assert.equal(formatEuro(v, "en"), "");
    assert.equal(formatEuro(v, "fr"), "");
  }
});
