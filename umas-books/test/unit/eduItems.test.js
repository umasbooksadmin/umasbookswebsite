// lib/eduItems.js parsers (cart quantity, the admin item form with its stock, a new genre's name), the order-line
// label of an educational item (always "(New)" / "(Neuf)"). No database (the cart badge counting units is in
// test/integration/eduItemsCart.test.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const edu = require("../../src/lib/eduItems");
const { orderItemLabel, orderItemParts, isEduLine } = require("../../src/lib/orderItems");

test("parseQty: a whole number from 1 to 10, anything else is null", () => {
  for (const [raw, want] of [["1", 1], ["10", 10], [" 3 ", 3], [4, 4]]) assert.equal(edu.parseQty(raw), want);
  for (const raw of ["0", "11", "-1", "2.5", "1e1", "", null, undefined, "abc", "999"]) assert.equal(edu.parseQty(raw), null, String(raw));
});

test("parseItemForm: name, price (comma or point), stock as a whole number 0..100000, genre among the known ones", () => {
  const ok = edu.parseItemForm({ name: "  Phonics   Cards ", price: "4,50", stock: "0", genreId: "2", sortOrder: "" }, [1, 2]);
  assert.deepEqual(ok.values, { name: "Phonics Cards", price: 4.5, cost: null, stock: 0, genreId: 2, sortOrder: 0, isHidden: false });
  assert.equal(edu.parseItemForm({ name: "A", price: "1", stock: "100000" }, []).values.stock, 100000);
  const bad = (body) => edu.parseItemForm({ name: "A", price: "4", stock: "3", ...body }, [1]).error;
  for (const stock of ["-1", "2.5", "", "100001", "1e3", "abc", " "]) assert.match(bad({ stock }), /number in stock/, `stock ${JSON.stringify(stock)}`);
  for (const price of ["0", "-2", "", "abc", "10000.01"]) assert.ok(bad({ price }), `price ${price}`);
  assert.match(bad({ name: "   " }), /name/);
  assert.match(bad({ name: "x".repeat(121) }), /120/);
  assert.match(bad({ genreId: "9" }), /genres/);
  assert.match(bad({ sortOrder: "1.5" }), /sort/);
});

test("cost per unit (migration 115): optional, comma or point, 0 allowed, never negative, at most 2 decimals, clear sentences", () => {
  const form = (cost) => edu.parseItemForm({ name: "A", price: "4", stock: "3", cost }, []);
  for (const blank of [undefined, "", "   "]) assert.equal(form(blank).values.cost, null, `blank ${JSON.stringify(blank)} = not known`);
  assert.equal(form("1,85").values.cost, 1.85);
  assert.equal(form(" 1.85 ").values.cost, 1.85);
  assert.equal(form("0").values.cost, 0, "a free sample costs 0");
  assert.equal(form("10000").values.cost, 10000);
  assert.match(form("-1").error, /^The cost cannot be negative\. .*Nothing was saved\.$/);
  assert.match(form("1.855").error, /^The cost can have at most 2 decimals .*Nothing was saved\.$/);
  for (const bad of ["abc", "10000.01", "1e2", "€2", "1.2.3", "1,"]) {
    assert.match(form(bad).error, /^Enter the cost per unit in euros, like 1\.85 or 1,85 .*Nothing was saved\.$/, `cost ${JSON.stringify(bad)}`);
  }
  // A bad cost refuses the whole form (nothing saved), even when everything else is right.
  assert.equal(form("abc").values, undefined);
});

test("unitMargin: price minus cost in whole cents, null when the cost is not known", () => {
  assert.equal(edu.unitMargin("4.50", "1.85"), 2.65);
  assert.equal(edu.unitMargin(0.3, 0.1), 0.2, "no float drift");
  assert.equal(edu.unitMargin("3.00", "3.50"), -0.5, "a loss is shown as a negative margin");
  assert.equal(edu.unitMargin("4.50", null), null);
});

test("parseGenreName: trimmed, at most 60 characters, a unique slug", () => {
  assert.deepEqual(edu.parseGenreName("  Board   Games ", []), { name: "Board Games", slug: "board-games" });
  assert.equal(edu.parseGenreName("Board Games", ["board-games"]).slug, "board-games-2");
  assert.ok(edu.parseGenreName("", []).error);
  assert.ok(edu.parseGenreName("x".repeat(61), []).error);
});

test("an educational order line reads 'Name (New)' / 'Name (Neuf)', a book line is unchanged", () => {
  const line = { item_title: "Phonics Cards", edu_item_id: 4, copy_condition: null };
  assert.equal(isEduLine(line), true);
  assert.equal(orderItemLabel(line, "en"), "Phonics Cards (New)");
  assert.equal(orderItemLabel(line, "fr"), "Phonics Cards (Neuf)");
  assert.deepEqual(orderItemParts(line, "en"), { bookTitle: "Phonics Cards", grade: "New" });
  assert.equal(orderItemLabel({ eduItemId: 4, title: "Cards" }, "en"), "Cards (New)");
  const book = { item_title: "Matilda", copy_condition: "very_good", edu_item_id: null };
  assert.equal(isEduLine(book), false);
  assert.equal(orderItemLabel(book, "en"), "Matilda (Very Good)");
});

