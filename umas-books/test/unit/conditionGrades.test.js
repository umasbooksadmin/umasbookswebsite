// Condition grades and binding vocabularies (src/lib/inventory.js), the
// Open Library format mapping, and the grade shown on order lines / emails.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const inv = require("../../src/lib/inventory");
const { mapBinding } = require("../../src/lib/bookLookup");
const { orderItemLabel } = require("../../src/lib/orderItems");
const { buildOrderConfirmationText } = require("../../src/lib/orderEmail");

test("the five grades, in order, with the exact English and French labels", () => {
  assert.deepEqual(
    inv.CONDITIONS.map((c) => [c.value, c.label, c.label_fr]),
    [
      ["new", "New", "Neuf"],
      ["like_new", "Like New", "Comme neuf"],
      ["very_good", "Very Good", "Très bon état"],
      ["good", "Good", "Bon état"],
      ["acceptable", "Acceptable", "État correct"],
    ]
  );
});

test("every grade has a one-line description in both languages", () => {
  for (const c of inv.CONDITIONS) {
    assert.ok(c.description && c.description_fr, c.value);
    assert.ok(!c.description.includes("\n") && !c.description_fr.includes("\n"));
  }
  assert.equal(inv.CONDITIONS[0].description, "Unread, as published (sold at the publisher's price).");
  assert.equal(inv.CONDITIONS[1].description, "As new: no marks or wear, possibly read once.");
  assert.equal(inv.CONDITIONS[1].description_fr, "Comme neuf : sans marques ni usure, peut-être lu une fois.");
  assert.equal(inv.CONDITIONS[2].description_fr, "Presque comme neuf : pages propres, sans annotations ni surlignage, au plus une très légère usure.");
});

test("normalizeCondition keeps the five grades and falls back to very_good; fair and poor are aliases", () => {
  for (const c of inv.CONDITIONS) assert.equal(inv.normalizeCondition(c.value), c.value);
  for (const old of ["", "pristine", null, undefined, "NEW", {}]) {
    assert.equal(inv.normalizeCondition(old), "very_good", String(old));
  }
  assert.deepEqual(["like_new", "fair", "poor"].map(inv.normalizeCondition), ["like_new", "acceptable", "acceptable"]);
  assert.equal(inv.DEFAULT_CONDITION, "very_good");
});

test("conditionLabel follows the language and leaves an unknown value as is", () => {
  assert.equal(inv.conditionLabel("very_good", "en"), "Very Good");
  assert.equal(inv.conditionLabel("very_good", "fr"), "Très bon état");
  assert.equal(inv.conditionLabel("acceptable", "fr"), "État correct");
  assert.equal(inv.conditionLabel("like_new", "en"), "Like New");
  assert.equal(inv.conditionLabel("like_new", "fr"), "Comme neuf");
  assert.equal(inv.conditionLabel("very_good", null), "Very Good");
  assert.equal(inv.conditionLabel("mystery", "fr"), "mystery");
});

test("BINDINGS and normalizeBinding: exactly four values, anything else is null", () => {
  assert.deepEqual(
    inv.BINDINGS.map((b) => [b.value, b.label, b.label_fr]),
    [["mass_market", "Mass Market", "Poche"], ["trade", "Trade", "Broché (grand format)"], ["hardcover", "Hardback", "Relié"], ["other", "Other", "Autre"]]
  );
  for (const b of inv.BINDINGS) assert.equal(inv.normalizeBinding(b.value), b.value);
  for (const bad of ["", "Hardcover", "spiral", null, undefined, {}, ["trade"]]) assert.equal(inv.normalizeBinding(bad), null);
  assert.equal(inv.bindingLabel("trade", "fr"), "Broché (grand format)");
  assert.equal(inv.bindingLabel("mass_market", "en"), "Mass Market");
  assert.equal(inv.bindingLabel(null, "en"), null);
});

test("mapBinding turns Open Library's free-text format into one of the four bindings, or null when missing", () => {
  const cases = [
    ["Hardcover", "hardcover"], ["hardback", "hardcover"], ["Library Binding, hardcover", "hardcover"],
    ["Paperback", "trade"], ["trade paperback", "trade"], ["Softcover", "trade"],
    ["Mass Market Paperback", "mass_market"], ["mass market paperback", "mass_market"], ["Mass market", "mass_market"],
    ["Audio CD", "other"], ["Spiral-bound", "other"], ["", null], [null, null], [undefined, null],
  ];
  for (const [input, expected] of cases) assert.equal(mapBinding(input), expected, String(input));
});

test("order lines carry the grade of the copy, in the order's language; drop-in seats do not", () => {
  const book = { item_title: "Dune", copy_condition: "very_good" };
  assert.equal(orderItemLabel(book, "en"), "Dune (Very Good)");
  assert.equal(orderItemLabel(book, "fr"), "Dune (Très bon état)");
  assert.equal(orderItemLabel(book, null), "Dune (Very Good)");
  assert.equal(orderItemLabel({ title: "Dune", condition: "acceptable" }, "fr"), "Dune (État correct)", "account page shape");
  assert.equal(orderItemLabel({ item_title: "Old line", copy_condition: null }, "en"), "Old line");
  const seat = orderItemLabel({ item_title: "Class — 1 Jan, 10:00", class_title: "Class", class_starts_at: "2092-01-01T09:00:00Z", copy_condition: null }, "en");
  assert.ok(seat.startsWith("Class — ") && !seat.includes("("), seat);
});

test("the order confirmation email shows the grade per book line in the order's language", () => {
  const order = { id: 7, lang: "fr", buyer_name: "Ana", total_amount: 9, created_at: new Date("2026-01-01") };
  const items = [{ item_title: "Dune", price: 9, copy_condition: "good" }];
  assert.match(buildOrderConfirmationText(order, items, ""), /- Dune \(Bon état\) — 9,00\u00a0€/);
  assert.match(buildOrderConfirmationText({ ...order, lang: "en" }, items, ""), /- Dune \(Good\) — €9\.00/);
});
