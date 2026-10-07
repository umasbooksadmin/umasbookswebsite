// Shelf-sticker colors (src/lib/priceColors.js): the color is derived from a copy's data.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { LEVELS, colorFor, chipText, meaning } = require("../../src/lib/priceColors");

const key = (copy) => colorFor(copy).key;

test("the scheme: every level has a key, label, hex and readable text color", () => {
  assert.deepEqual(LEVELS.map((l) => l.key), ["yellow", "green", "blue", "red", "purple", "orange", "white"]);
  const by = Object.fromEntries(LEVELS.map((l) => [l.key, l]));
  assert.deepEqual([by.yellow.eur, by.green.eur, by.blue.eur, by.red.eur, by.orange.eur], [3, 5, 8, 10, 1]);
  assert.deepEqual([by.yellow.hex, by.green.hex, by.blue.hex, by.red.hex, by.purple.hex, by.orange.hex, by.white.hex],
    ["#FFD93D", "#237A3C", "#2F6FDE", "#D83B3B", "#7B4FD0", "#FF8A1F", "#FFFFFF"]);
  for (const l of LEVELS) {
    assert.match(l.hex, /^#[0-9A-F]{6}$/);
    assert.ok(l.text && l.label && l.labelFr, l.key);
  }
  // dark text on the light chips, white on the dark ones
  assert.equal(by.yellow.text, by.orange.text);
  assert.notEqual(by.yellow.text, by.green.text);
  assert.ok(by.white.border, "the white chip needs a visible border");
});

test("standard used prices map to their color", () => {
  assert.equal(key({ price: 3, condition: "acceptable" }), "yellow");
  assert.equal(key({ price: 5, condition: "very_good" }), "green");
  assert.equal(key({ price: 8, condition: "acceptable" }), "blue");
  assert.equal(key({ price: 10, condition: "acceptable" }), "red");
  assert.equal(key({ price: "5.00", condition: "acceptable" }), "green", "numeric strings from the database");
});

test("boundary: 5.00 is green, 5.01 and 4.99 are custom (purple)", () => {
  assert.equal(key({ price: "5.00", condition: "acceptable" }), "green");
  assert.equal(key({ price: "5.01", condition: "acceptable" }), "purple");
  assert.equal(key({ price: "4.99", condition: "acceptable" }), "purple");
  assert.equal(key({ price: 12, condition: "acceptable" }), "purple");
});

test("clearance wins over the price; a clearance copy at EUR 5 is still orange", () => {
  assert.equal(key({ price: 1, condition: "acceptable", is_clearance: true }), "orange");
  assert.equal(key({ price: 5, condition: "acceptable", is_clearance: true }), "orange");
  assert.equal(key({ price: 5, condition: "acceptable", isClearance: true }), "orange");
  // EUR 1 without the clearance flag is just a custom price
  assert.equal(key({ price: 1, condition: "acceptable", is_clearance: false }), "purple");
});

test("new books are retail (white) whatever their price", () => {
  assert.equal(key({ price: 10, condition: "new" }), "white");
  assert.equal(key({ price: 13.3, condition: "new" }), "white");
  assert.equal(key({ price: null, condition: "new" }), "white");
});

test("chip text", () => {
  assert.equal(chipText(colorFor({ price: 5, condition: "acceptable" }), 5), "Green sticker, EUR 5");
  assert.equal(chipText(colorFor({ price: 5.01, condition: "acceptable" }), 5.01), "Purple sticker, custom price EUR 5.01");
  assert.equal(chipText(colorFor({ price: 1, is_clearance: true }), 1), "Orange sticker, clearance EUR 1");
  assert.equal(chipText(colorFor({ price: 14, condition: "new" }), 14), "White sticker: publisher price EUR 14, write it on the sticker");
  assert.match(meaning(colorFor({ condition: "new" })), /publisher/);
});
