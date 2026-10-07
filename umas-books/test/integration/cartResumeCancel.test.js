// What used to be "resume or cancel an UNPAID online order" is gone with online
// payment: there is no HelloAsso page to go back to, no 'pending' order for a
// new purchase, no "Your unpaid orders" block on /cart and no
// /cart/orders/:id/resume or /cancel route (the tests of resuming a payment, of
// the 60-minute payment link and of "cancel asks HelloAsso first" were deleted:
// they protected behaviour that no longer exists).
//
// What is still meaningful, and kept here: the customer cancels their OWN
// reservation (POST /cart/reservations/:id/cancel): owner only, harmless when
// repeated, never touches a collected order, answers in English and French,
// and the old routes and block really are gone. The seat's 24-hour cutoff and
// the happy path are also in reservations.test.js.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");

const h = reserveHarness("cart_resume_cancel");
const { pool } = h;
before(() => h.start());
after(() => h.stop());
beforeEach(() => { h.sent.length = 0; });

const copyStatus = (id) => h.copyStatus(id);

test("the old unpaid-order routes are gone and /cart has no 'unpaid orders' block, even for a buyer with a legacy 'pending' order", async () => {
  const alice = await h.account();
  const copy = await h.copy();
  // A leftover of the old online checkout: a pending order with a held copy.
  const { rows } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, total_amount, status, user_id, checkout_redirect_url)
     VALUES ('Alice', $1, 6, 'pending', $2, 'https://checkout.helloasso.com/pay/abc') RETURNING id`, [alice.email, alice.id]);
  await pool.query("UPDATE book_copies SET status = 'in_cart', cart_order_id = $1, cart_added_at = now() WHERE id = $2", [rows[0].id, copy]);
  const v = h.visitor(alice);
  for (const path of [`/cart/orders/${rows[0].id}/resume`]) assert.equal((await v.get(path)).status, 404, path);
  assert.equal((await v.post(`/cart/orders/${rows[0].id}/cancel`)).status, 404);
  const page = await v.get("/cart");
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /pending-orders|Your unpaid orders|Resume payment|Cancel this order/);
  assert.equal(await copyStatus(copy), "in_cart", "nothing was touched by those requests");
});

test("cancelling releases the owner's own reservation; someone else's is untouched, and a stranger gets a 404", async () => {
  const alice = await h.account();
  const bob = await h.account();
  const mine = await h.reserve(alice, { copyIds: [await h.copy()] });
  const theirs = await h.reserve(bob, { copyIds: [await h.copy()] });
  const copyOf = async (order) => (await pool.query("SELECT id FROM book_copies WHERE cart_order_id = $1", [order.id])).rows[0].id;
  const mineCopy = await copyOf(mine.order);
  const theirCopy = await copyOf(theirs.order);

  const stranger = await theirs.v.post(`/cart/reservations/${mine.order.id}/cancel`);
  assert.equal(stranger.status, 404);
  assert.equal((await h.order(mine.order.id)).status, "reserved");
  assert.equal(await copyStatus(mineCopy), "reserved");

  const done = await mine.v.post(`/cart/reservations/${mine.order.id}/cancel`);
  assert.equal(done.status, 302);
  assert.equal(done.location, "/account?notice=reservation-cancelled");
  assert.equal((await h.order(mine.order.id)).status, "cancelled");
  assert.equal(await copyStatus(mineCopy), "in_stock");
  assert.equal((await h.order(theirs.order.id)).status, "reserved", "the other account's reservation is untouched");
  assert.equal(await copyStatus(theirCopy), "reserved");
});

test("a guest pressing cancel is sent to log in; a malformed or unknown id is a 404; repeating a cancel is harmless", async () => {
  const alice = await h.account();
  const { order, v } = await h.reserve(alice, { copyIds: [await h.copy()] });
  const guest = await h.visitor().post(`/cart/reservations/${order.id}/cancel`);
  assert.equal(guest.status, 302);
  assert.match(guest.location, /^\/login/);
  assert.equal((await h.order(order.id)).status, "reserved");

  assert.equal((await v.post("/cart/reservations/abc/cancel")).status, 404);
  assert.equal((await v.post("/cart/reservations/99999999/cancel")).status, 404);

  assert.equal((await v.post(`/cart/reservations/${order.id}/cancel`)).location, "/account?notice=reservation-cancelled");
  const again = await v.post(`/cart/reservations/${order.id}/cancel`);
  assert.equal(again.location, "/account?notice=reservation-not-open");
  assert.equal((await h.order(order.id)).status, "cancelled");
});

test("cancel never cancels a reservation that was already collected and paid at the shop: the books stay sold", async () => {
  const alice = await h.account();
  const copy = await h.copy();
  const { order, v } = await h.reserve(alice, { copyIds: [copy] });
  // The shop collects it (what 'Mark collected and paid' does to the rows).
  await pool.query("UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1", [order.id]);
  await pool.query("UPDATE book_copies SET status = 'sold' WHERE id = $1", [copy]);
  const r = await v.post(`/cart/reservations/${order.id}/cancel`);
  assert.equal(r.location, "/account?notice=reservation-not-open");
  assert.equal((await h.order(order.id)).status, "paid");
  assert.equal(await copyStatus(copy), "sold");
});

test("the cancel notices read in English and in French on the account page", async () => {
  const alice = await h.account();
  const en = h.visitor(alice, { lang: "en" });
  const fr = h.visitor(alice, { lang: "fr" });
  const cases = [
    ["reservation-cancelled", /Your reservation was cancelled and its items are available again\./, /Votre réservation a été annulée et ses articles sont de nouveau disponibles\./],
    ["reservation-not-open", /That reservation is no longer open, so there was nothing to cancel\./, /Cette réservation n’est plus en cours/],
    ["reservation-too-late", /A drop-in seat can only be cancelled online until 24 hours before the session/, /Une place « drop-in » ne peut être annulée en ligne que jusqu’à 24 heures avant la séance/],
  ];
  for (const [notice, enRe, frRe] of cases) {
    assert.match((await en.get(`/account?notice=${notice}`)).text, enRe, notice);
    assert.match((await fr.get(`/account?notice=${notice}`)).text.replace(/&nbsp;|[\u00a0\u202f]/g, " "), frRe, notice);
  }
});

test("the cancel button is shown to the owner on the reservation page and the account page, and posts to the reservation route", async () => {
  const alice = await h.account();
  const { order, v } = await h.reserve(alice, { copyIds: [await h.copy()] });
  const action = `action="/cart/reservations/${order.id}/cancel"`;
  assert.ok((await v.get(`/cart/return?order=${order.access_token}`)).text.includes(action), "reservation page");
  assert.ok((await v.get("/account")).text.includes(action), "account page");
  const other = h.visitor(await h.account());
  assert.ok(!(await other.get("/account")).text.includes(action), "someone else's account page never offers it");
});
