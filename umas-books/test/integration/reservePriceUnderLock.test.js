// L3: the price is read again under the row lock when a reservation is made. A reprice between
// the moment the customer saw the cart and the reservation must never leave order_items.price
// different from book_copies.price: the reservation is refused with a clear message and nothing
// is held; pressing Reserve again (the cart now shows the new price) confirms it.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");

const h = reserveHarness("reserve_price_lock");
const { pool } = h;
before(() => h.start());
after(() => h.stop());

const FORM = { name: "Lock Buyer", acceptCgv: "on" };

test("the cart form carries the price the customer saw", async () => {
  const buyer = await h.account();
  const v = h.visitor(buyer);
  const copy = await h.copy({ price: 6 });
  await v.post("/cart/add", { copyId: copy });
  const page = await v.get("/cart");
  assert.match(page.text, new RegExp(`name="seenPrice_${copy}" value="6.00"`));
});

test("a reprice after the cart was viewed refuses the reservation, holds nothing, and a second press confirms the new price", async () => {
  const buyer = await h.account();
  const v = h.visitor(buyer);
  const copy = await h.copy({ price: 8, title: "Repriced Novel" });
  await v.post("/cart/add", { copyId: copy });
  await v.get("/cart"); // the customer saw EUR 8.00
  await pool.query("UPDATE book_copies SET price = 5 WHERE id = $1", [copy]); // the reprice tool runs

  const first = await v.post("/cart/reserve", { ...FORM, [`seenPrice_${copy}`]: "8.00" });
  assert.equal(first.seeOther, "/cart");
  assert.equal(await h.copyStatus(copy), "in_stock", "nothing is held");
  assert.equal((await h.ordersOf(buyer)).length, 0, "no order row survives the rollback");
  // (the harness followed the redirect: first.text is the cart page that shows the message)
  assert.match(first.text, /The price of &#34;Repriced Novel&#34; changed to EUR 5\.00, please review your reservation\./);
  const page = await v.get("/cart");
  assert.match(page.text, new RegExp(`name="seenPrice_${copy}" value="5.00"`));

  const second = await v.post("/cart/reserve", { ...FORM, [`seenPrice_${copy}`]: "5.00" });
  assert.match(second.location, /^\/cart\/return\?order=/);
  const orders = await h.ordersOf(buyer);
  assert.equal(orders.length, 1);
  assert.equal(Number(orders[0].total_amount), 5);
  const { rows } = await pool.query("SELECT price FROM order_items WHERE order_id = $1", [orders[0].id]);
  assert.equal(Number(rows[0].price), 5);
});

test("a reprice that lands while the reservation waits on the row lock is caught under the lock", async () => {
  const buyer = await h.account();
  const v = h.visitor(buyer);
  const copy = await h.copy({ price: 8, title: "Locked Novel" });
  await v.post("/cart/add", { copyId: copy });

  // A reprice transaction holds the row lock; the reserve request queues behind it.
  const repricer = await pool.connect();
  await repricer.query("BEGIN");
  await repricer.query("SELECT id FROM book_copies WHERE id = $1 FOR UPDATE", [copy]);
  const pending = v.post("/cart/reserve", { ...FORM, [`seenPrice_${copy}`]: "8.00" });
  await new Promise((r) => setTimeout(r, 400));
  await repricer.query("UPDATE book_copies SET price = 5 WHERE id = $1", [copy]);
  await repricer.query("COMMIT");
  repricer.release();

  const r = await pending;
  assert.equal(r.seeOther, "/cart");
  assert.match(r.text, /Locked Novel[^<]*changed to EUR 5\.00/);
  assert.equal(await h.copyStatus(copy), "in_stock");
  assert.equal((await h.ordersOf(buyer)).length, 0);
  const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id WHERE o.user_id = $1", [buyer.id]);
  assert.equal(rows[0].n, 0);
});

test("an unchanged price reserves normally and order_items.price equals book_copies.price", async () => {
  const buyer = await h.account();
  const copy = await h.copy({ price: 7.5 });
  const { order } = await h.reserve(buyer, { copyIds: [copy] });
  assert.ok(order);
  const { rows } = await pool.query("SELECT oi.price AS item, c.price AS copy FROM order_items oi JOIN book_copies c ON c.id = oi.book_copy_id WHERE oi.order_id = $1", [order.id]);
  assert.equal(Number(rows[0].item), Number(rows[0].copy));
});
