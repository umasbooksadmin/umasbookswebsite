// Educational items in the public cart (src/routes/cart.js /cart/add-edu, /cart/update-qty, /cart/reserve): the quantity
// is capped at what is left (stock minus what open reservations hold) and at 10, a sold-out or hidden item is not added,
// backTo cannot leave the Browse Educational Items page, the cart count counts units, reserving a book plus an
// educational item makes one order (one line per unit) and the confirmation email (EN and FR) says the items are new,
// and a cart whose units were reserved by someone else meanwhile is cut down, never oversold. Real routes on the
// reserveHarness (nothing is paid online; HelloAsso is never called).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");

const h = reserveHarness("edu_cart");
const { pool, uniq } = h;
before(() => h.start());
after(() => h.stop());

function visitor(account, opts) {
  const v = h.visitor(account, opts);
  return { ...v, count: async () => JSON.parse((await v.get("/api/cart/count")).text).count };
}
async function item({ price = 4, stock = 3, hidden = false } = {}) {
  const g = (await pool.query("SELECT id FROM edu_genres WHERE slug = 'flash-cards'")).rows[0].id;
  return (await pool.query("INSERT INTO edu_items (name, price, stock, genre_id, is_hidden) VALUES ($1, $2, $3, $4, $5) RETURNING *",
    [`Cards ${uniq()}`, price, stock, g, hidden])).rows[0];
}
const held = async (id) => (await pool.query(
  "SELECT COUNT(*)::int AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE oi.edu_item_id = $1 AND o.status = 'reserved'", [id])).rows[0].n;

test("add-edu caps the quantity at what is left, counts units, and answers on the browse page", async () => {
  const it = await item({ stock: 3 });
  const v = visitor();
  const r = await v.post("/cart/add-edu", { eduItemId: it.id, qty: "5", backTo: "/fr/educational-items.html?genre=flash-cards" });
  // (the browse page itself is not mounted on this harness: eduItemsBrowse.test.js covers it)
  assert.equal(r.seeOther, `/fr/educational-items.html?genre=flash-cards&added=${it.id}#edu-item-${it.id}`);
  assert.equal(await v.count(), 3);
  await v.post("/cart/add-edu", { eduItemId: it.id, qty: "1", backTo: "/educational-items.html" });
  assert.equal(await v.count(), 3, "still capped at the stock");
  const page = await v.get("/cart");
  assert.match(page.text, /All educational items are new\.|Tous les articles éducatifs sont neufs\./, "every visitor sees it, guests too");
  assert.ok(!/<option value="4"/.test(page.text), "the quantity select offers no more than is left");
  // A tampered quantity is capped again when the cart is shown.
  const lineId = /name="lineId" value="(\d+)"/.exec(page.text)[1];
  await v.post("/cart/update-qty", { lineId, qty: "10" });
  await v.get("/cart");
  assert.equal(await v.count(), 3);
});

test("a sold-out, fully held or hidden item is not added; backTo cannot leave the page", async () => {
  const none = await item({ stock: 0 });
  const hidden = await item({ hidden: true });
  const v = visitor();
  for (const it of [none, hidden]) {
    const r = await v.post("/cart/add-edu", { eduItemId: it.id, backTo: "/educational-items.html" });
    assert.match(r.seeOther, /notadded=unavailable/);
  }
  assert.equal(await v.count(), 0);
  const r = await v.post("/cart/add-edu", { eduItemId: none.id, backTo: "https://evil.example/x" });
  assert.match(r.seeOther, /^\/educational-items\.html\?notadded=/);
  const r2 = await v.post("/cart/add-edu", { eduItemId: none.id, backTo: "//evil.example/educational-items.html" });
  assert.match(r2.seeOther, /^\/educational-items\.html\?notadded=/);
});

test("reserving a book and educational items: one order, a line per unit, the hold, and the 'new' email in EN and FR", async () => {
  for (const lang of ["en", "fr"]) {
    const account = await h.account({ lang });
    const v = visitor(account, { lang });
    const copy = await h.copy({ price: 6 });
    const it = await item({ price: 2.5, stock: 5 });
    await v.post("/cart/add", { copyId: copy });
    await v.post("/cart/add-edu", { eduItemId: it.id, qty: "2", backTo: "/educational-items.html" });
    const sentBefore = h.sent.length;
    const r = await v.post("/cart/reserve", { acceptCgv: "on", name: "Edu Buyer" });
    assert.equal(r.status, 302, r.text.slice(0, 300));
    const [order] = await h.ordersOf(account);
    assert.equal(Number(order.total_amount), 11);
    assert.equal(order.status, "reserved");
    assert.equal(await held(it.id), 2);
    assert.equal(await v.count(), 0);
    const mail = h.sent.slice(sentBefore).find((m) => m.to === account.email);
    assert.ok(mail, "a confirmation email");
    if (lang === "en") {
      assert.match(mail.text, /All educational items are new\./);
      assert.match(mail.text, new RegExp(`${it.name} \\(New\\) — €2\\.50`));
    } else {
      assert.match(mail.text, /Tous les articles éducatifs sont neufs\./);
      assert.match(mail.text, /\(Neuf\)/);
    }
  }
});

test("units reserved by someone else meanwhile: the cart is cut down to what is left, never oversold", async () => {
  const it = await item({ stock: 2 });
  const a = visitor(await h.account());
  const bAccount = await h.account();
  const b = visitor(bAccount);
  await a.post("/cart/add-edu", { eduItemId: it.id, qty: "2", backTo: "/educational-items.html" });
  await b.post("/cart/add-edu", { eduItemId: it.id, qty: "2", backTo: "/educational-items.html" });
  assert.equal((await a.post("/cart/reserve", { acceptCgv: "on", name: "First" })).status, 302);
  assert.equal(await held(it.id), 2);
  await b.get("/cart"); // the cart page drops what is no longer there, like a sold book
  assert.equal(await b.count(), 0, "nothing left for the second cart");
  await b.post("/cart/add-edu", { eduItemId: it.id, qty: "1", backTo: "/educational-items.html" });
  assert.equal(await b.count(), 0, "a fully held item is not added");
  await b.post("/cart/reserve", { acceptCgv: "on", name: "Second" });
  assert.equal((await h.ordersOf(bAccount)).length, 0);
  assert.equal(await held(it.id), 2);
});
