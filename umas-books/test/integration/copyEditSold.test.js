// Review 5, item D3: marking a copy Sold from the edit form records the date sold (sold_at) but makes NO sale record
// (no shop_sales row), and the form says so. Nothing else about the edit changes.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");
const h = adminHarness("copy_edit_sold", ["inventory"], { isolated: true });
before(() => h.start());
after(() => h.stop());

async function seed() {
  const [b] = await h.q("INSERT INTO books (isbn, title, authors, description, cover_url) VALUES ('9780143127550', 'Edit Sold', 'A', 'd', '/c.png') RETURNING id");
  const [c] = await h.q("INSERT INTO book_copies (book_id, condition, price, status) VALUES ($1, 'good', 6, 'in_stock') RETURNING id", [b.id]);
  return { bookId: b.id, copyId: c.id };
}

test("editing a copy to Sold records sold_at, leaves no sale record, and the form warns about it", async () => {
  const { bookId, copyId } = await seed();
  const page = await h.get(`/admin/inventory/${bookId}`);
  assert.match(page.text, /does not record a sale/);
  const r = await h.post(`/admin/inventory/${bookId}/copies/${copyId}`, { condition: "good", status: "sold", renderedStatus: "in_stock", price: "6", priceLevel: "custom" });
  assert.ok([200, 302].includes(r.res.status), r.text.slice(0, 200));
  const [c] = await h.q("SELECT status, sold_at, sold_via FROM book_copies WHERE id = $1", [copyId]);
  assert.equal(c.status, "sold");
  assert.ok(c.sold_at, "date sold recorded");
  assert.equal((await h.q("SELECT COUNT(*)::int n FROM shop_sales WHERE copy_id = $1", [copyId]))[0].n, 0, "and still no sale record");
  // a second save of the sold copy does not move the date
  const before = c.sold_at.toISOString();
  await h.post(`/admin/inventory/${bookId}/copies/${copyId}`, { condition: "good", status: "sold", renderedStatus: "sold", price: "6", priceLevel: "custom" });
  assert.equal((await h.q("SELECT sold_at FROM book_copies WHERE id = $1", [copyId]))[0].sold_at.toISOString(), before);
});
