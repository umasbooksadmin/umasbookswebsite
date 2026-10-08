// Books WITHOUT an ISBN work end to end: intake by hand, a copy label, the till.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");

let h;
before(async () => { h = await tillHarness({ port: 4203, ip: "10.80.3.3" }); });
after(async () => { await h.stop(); });

test("Add Book: the page explains 'No ISBN?'; the title is the only required field", async () => {
  const page = (await h.get("/admin/inventory/new")).text;
  assert.match(page, /No ISBN\?/);
  assert.match(page, /enter the details by hand/);
  assert.match(page, /id="title" name="title" type="text" required/);
  assert.doesNotMatch(page, /name="isbn"[^>]*required/);
  const scanPage = (await h.get("/admin/inventory/scan")).text;
  assert.match(scanPage, /No ISBN\?/);
  assert.match(scanPage, /href="\/admin\/inventory\/new">Enter the details by hand/);
  // without a title the form is refused, nothing saved
  const none = await h.post("/admin/inventory", { title: "", condition: "very_good", price: "5" });
  assert.equal(none.status, 200);
  assert.match(await none.text(), /Title is required/);
});

test("a book with no ISBN: saved by hand, labelled UB-<id>, and sold at the till by its label", async () => {
  const title = `Handmade Zine ${h.uniq()}`;
  const saved = await h.post("/admin/inventory", {
    title, author: "Local Author", genre: "Poetry", binding: "trade", condition: "good", price: "6.50", location: "ZINES",
  });
  assert.equal(saved.status, 302, "saved");
  const { rows: books } = await h.pool.query("SELECT * FROM books WHERE title = $1", [title]);
  assert.equal(books.length, 1);
  assert.equal(books[0].isbn, null);
  assert.equal(books[0].authors, "Local Author");
  assert.equal(books[0].binding, "trade");
  const { rows: copies } = await h.pool.query("SELECT * FROM book_copies WHERE book_id = $1", [books[0].id]);
  assert.equal(copies.length, 1);
  assert.equal(Number(copies[0].price), 6.5);
  const id = copies[0].id;

  // a second copy of another no-ISBN book never merges into the first
  const second = await h.post("/admin/inventory", { title: `${title} B`, condition: "very_good", price: "" });
  assert.equal(second.status, 302);
  const { rows: b2 } = await h.pool.query("SELECT id, isbn FROM books WHERE title = $1", [`${title} B`]);
  assert.equal(b2.length, 1);
  assert.notEqual(b2[0].id, books[0].id);
  const { rows: c2 } = await h.pool.query("SELECT price FROM book_copies WHERE book_id = $1", [b2[0].id]);
  assert.equal(c2[0].price, null, "no price: left for the till to ask");

  // till: scanning the copy code works; scanning nothing else could
  const scanned = await h.scan(`UB-${id}`);
  assert.equal(scanned.body.type, "line");
  assert.equal(scanned.body.line.isbn, "");
  assert.equal(scanned.body.line.title, title);
  const sold = await h.sale([h.book(id)], { received: "10" });
  assert.equal(sold.status, 200);
  assert.equal(sold.body.changeCents, 350);
  assert.equal((await h.copy(id)).status, "sold");

  // the unpriced copy asks for a price at the till
  const c2id = (await h.pool.query("SELECT id FROM book_copies WHERE book_id = $1", [b2[0].id])).rows[0].id;
  const unpriced = await h.scan(`UB-${c2id}`);
  assert.equal(unpriced.body.line.priceCents, null);
  assert.equal((await h.sale([h.book(c2id)])).status, 400);
  assert.equal((await h.sale([h.book(c2id, "3")], { received: "3" })).status, 200);
});

test("several copies of an ISBN book show a picker (no-ISBN copies are always scanned by label)", async () => {
  // Two copies of an ISBN book are offered in a picker; no-ISBN copies are always scanned by label.
  const book = await h.seedBook(`Picker ${h.uniq()}`);
  await h.seedCopy(book.id, { price: 3 });
  await h.seedCopy(book.id, { price: 5 });
  assert.equal((await h.scan(book.isbn)).body.type, "choose");
});
