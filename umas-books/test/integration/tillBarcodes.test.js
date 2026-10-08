// Barcodes on quick items (other stock, not books): scanning, uniqueness, collisions, shop-code labels.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");

let h;
before(async () => { h = await tillHarness({ port: 4204, ip: "10.80.4.4" }); });
after(async () => { await h.stop(); });

async function addItem(fields) {
  return h.post("/admin/till/items", { name: "Item", price: "5", category: "merchandise", ...fields });
}
const itemBy = async (name) => (await h.pool.query("SELECT * FROM till_quick_items WHERE name = $1", [name])).rows[0];

test("the Other stock page is reachable from Inventory and the till, with its title and sub-heading", async () => {
  assert.match((await h.get("/admin/inventory")).text, /href="\/admin\/till\/items">Other stock \(not books\)</);
  assert.match((await h.get("/admin/till")).text, /href="\/admin\/till\/items">Other stock \(not books\)</);
  const page = (await h.get("/admin/till/items")).text;
  assert.match(page, /<h1>Other stock \(not books\)<\/h1>/);
  assert.match(page, /Tote bags, bookmarks and anything else you sell that is not a book/);
  assert.match(page, /name="barcode"/);
  assert.match(page, /scan it now/i);
});

test("scanning an item's barcode adds one unit; it is case-insensitive; blank-barcode items cannot be scanned", async () => {
  assert.equal((await addItem({ name: "Tote Green", price: "12", barcode: "tote-green", stock: "3" })).status, 302);
  const it = await itemBy("Tote Green");
  assert.equal(it.barcode, "TOTE-GREEN", "stored upper-case");
  for (const code of ["TOTE-GREEN", "tote-green", " Tote-Green "]) {
    const r = await h.scan(code);
    assert.equal(r.body.type, "quick", code);
    assert.deepEqual([r.body.item.id, r.body.item.name, r.body.item.priceCents, r.body.item.category, r.body.item.stock], [it.id, "Tote Green", 1200, "merchandise", 3]);
  }
  assert.equal((await h.scan("TOTE-GREY")).body.type, "error");
  assert.match((await h.get("/admin/till/items")).text, /value="TOTE-GREEN"/);
});

test("manufacturer codes: 8-14 digits; shop codes: letters, digits, - . _ up to 32", async () => {
  assert.equal((await addItem({ name: "EAN Item", barcode: "3017620422003" })).status, 302);
  assert.equal((await h.scan("3017620422003")).body.type, "quick");
  for (const bad of ["1234567", "123456789012345", "has space", "bad!", "x".repeat(33), "-start"]) {
    const r = await addItem({ name: `Bad ${bad.length}`, barcode: bad });
    assert.equal(r.status, 200, bad);
  }
  assert.equal((await addItem({ name: "Max Code", barcode: "A".repeat(32) })).status, 302);
});

test("uniqueness among ACTIVE items, case-insensitive, with a clear error; a disabled item frees its code", async () => {
  assert.equal((await addItem({ name: "Mug One", barcode: "MUG-1" })).status, 302);
  const dup = await addItem({ name: "Mug Two", barcode: "mug-1" });
  assert.equal(dup.status, 200);
  assert.match(await dup.text(), /already used by &#34;Mug One&#34;|already used by "Mug One"/);
  const one = await itemBy("Mug One");
  // disable the first: the code is free again
  assert.equal((await h.post(`/admin/till/items/${one.id}`, { name: "Mug One", price: "5", category: "merchandise", barcode: "MUG-1", active: "" })).status, 302);
  assert.equal((await h.scan("MUG-1")).body.type, "error", "a disabled item is not scanned");
  assert.equal((await addItem({ name: "Mug Two", barcode: "MUG-1" })).status, 302);
  // re-activating the first now collides
  const back = await h.post(`/admin/till/items/${one.id}`, { name: "Mug One", price: "5", category: "merchandise", barcode: "MUG-1", active: "1" });
  assert.equal(back.status, 200);
  // the database enforces it too
  await assert.rejects(h.pool.query("INSERT INTO till_quick_items (name, price_cents, category, barcode) VALUES ('x', 100, 'other', 'MUG-1')"), /uq_till_quick_items_barcode/);
});

test("collision rules: UB- and ORDER- are refused; so is the ISBN of a book (it would hide the book at scan)", async () => {
  for (const code of ["UB-1234", "ub-9", "UB5", "ORDER-7"]) {
    const r = await addItem({ name: `Collide ${code}`, barcode: code });
    assert.equal(r.status, 200, code);
    assert.match(await r.text(), /UB-|ORDER-/);
  }
  const book = await h.seedBook(`Collision Book ${h.uniq()}`);
  const c = await h.seedCopy(book.id, { price: 5 });
  const before = (await h.pool.query("SELECT COUNT(*)::int AS n FROM till_quick_items")).rows[0].n;
  // the ISBN-13, its hyphenated form's digits and its ISBN-10 twin are all refused: nothing is saved
  const variants = require("../../src/lib/inventory").isbnVariants(book.isbn);
  assert.ok(variants.length >= 2, "an ISBN-13 and its ISBN-10 twin");
  for (const code of variants) {
    const r = await addItem({ name: `Same As ISBN ${code}`, barcode: code });
    assert.equal(r.status, 200, code);
    assert.match(await r.text(), /ISBN of[\s\S]*Collision Book/);
  }
  assert.equal((await h.pool.query("SELECT COUNT(*)::int AS n FROM till_quick_items")).rows[0].n, before, "no item was saved");
  // editing an existing item to that code is refused too
  const ok = await addItem({ name: "Edit me", barcode: "EDIT-ME-1" });
  assert.equal(ok.status, 302);
  const { rows } = await h.pool.query("SELECT id FROM till_quick_items WHERE name = 'Edit me'");
  const edit = await h.post(`/admin/till/items/${rows[0].id}`, { name: "Edit me", price: "2", category: "other", active: "1", barcode: book.isbn });
  assert.equal(edit.status, 200);
  assert.equal((await h.pool.query("SELECT barcode FROM till_quick_items WHERE id = $1", [rows[0].id])).rows[0].barcode, "EDIT-ME-1");
  // the book is scanned as a book, by ISBN and by its UB- label
  assert.equal((await h.scan(book.isbn)).body.type, "line");
  const label = await h.scan(`UB-${c}`);
  assert.equal(label.body.type, "line");
  assert.equal(label.body.line.copyId, c);
});

test("lookup order: UB- label, then quick barcode, then ISBN, then unknown", async () => {
  const book = await h.seedBook(`Order Book ${h.uniq()}`);
  await h.seedCopy(book.id, { price: 5 });
  assert.equal((await h.scan(book.isbn)).body.type, "line", "ISBN of a book with one copy");
  assert.equal((await h.scan("ZZZ-NOTHING")).body.type, "error");
  assert.match((await h.scan("ZZZ-NOTHING")).body.message, /not recognised/);
  assert.equal((await h.scan("TOTE-GREEN")).body.type, "quick");
});

test("generated shop codes ITEM-<id>: by the checkbox and by the button", async () => {
  assert.equal((await addItem({ name: "Gen Bookmark", price: "1.5", generate: "1" })).status, 302);
  const a = await itemBy("Gen Bookmark");
  assert.equal(a.barcode, `ITEM-${a.id}`);
  assert.equal((await addItem({ name: "Gen Later", price: "2" })).status, 302);
  const b = await itemBy("Gen Later");
  assert.equal(b.barcode, null);
  assert.match((await h.get("/admin/till/items")).text, new RegExp(`formaction="/admin/till/items/${b.id}/generate-code"`));
  assert.equal((await h.post(`/admin/till/items/${b.id}/generate-code`, {})).status, 302);
  assert.equal((await itemBy("Gen Later")).barcode, `ITEM-${b.id}`);
  assert.equal((await h.post(`/admin/till/items/${b.id}/generate-code`, {})).status, 200, "already has one");
  assert.equal((await h.scan(`item-${b.id}`)).body.item.name, "Gen Later");
});

test("stock: scanning refuses at 0, a sale decrements, a void restores the count", async () => {
  assert.equal((await addItem({ name: "Stock Pen", price: "2", barcode: "PEN-1", stock: "2" })).status, 302);
  const pen = await itemBy("Stock Pen");
  const r = await h.sale([{ kind: "quick", id: pen.id, quantity: 2 }], { received: "10" });
  assert.equal(r.status, 200);
  assert.equal((await itemBy("Stock Pen")).stock, 0);
  const none = await h.scan("PEN-1");
  assert.equal(none.body.type, "error");
  assert.match(none.body.message, /No more "Stock Pen" in stock/);
  assert.equal((await h.sale([{ kind: "quick", id: pen.id, quantity: 1 }], { received: "10" })).status, 409);
  await h.post(`/admin/till/sales/${r.body.saleId}/void`, { reason: "test" });
  assert.equal((await itemBy("Stock Pen")).stock, 2);
  assert.equal((await h.scan("PEN-1")).body.type, "quick");
  assert.match((await h.get("/admin/till")).text, /2 left/);
});

test("the till script has the quantity stepper and handles scanned quick items", async () => {
  const js = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "..", "public", "till.js"), "utf8");
  assert.match(js, /j\.type === "quick"\) addQuick\(j\.item\)/);
  assert.match(js, /till-step-btn/);
});
