// A double tap on "Reserve" (review 6B M6): the second request lands on the reservation the first one made, never on
// "something in your cart was just taken by someone else" with an empty cart, and never makes a second reservation.
// Recognised only for the same customer (the account; a guest: the same address from the same connection), within two
// minutes, for exactly the same items, and for a form shown before that reservation (src/lib/duplicateReservation.js).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");

const h = reserveHarness("double_reserve");
before(() => h.start());
after(() => h.stop());

const TAKEN = "just taken by someone else";
const tokenOf = (r) => ((r.location || "").match(/^\/cart\/return\?order=([0-9a-f-]{36})$/) || [])[1] || null;
const guestOrders = async (email) => (await h.pool.query("SELECT * FROM orders WHERE lower(buyer_email) = $1 ORDER BY id", [email])).rows;

test("account: two Reserve presses at once make one reservation and both land on its page", async () => {
  const buyer = await h.account();
  const copy = await h.copy();
  const v = h.visitor(buyer);
  await v.post("/cart/add", { copyId: copy });
  const form = { name: "Pat", acceptCgv: "on", formShownAt: String(Date.now() - 1000) };
  const [a, b] = await Promise.all([v.post("/cart/reserve", form), v.post("/cart/reserve", form)]);
  const orders = await h.ordersOf(buyer);
  assert.equal(orders.length, 1, "exactly one reservation");
  assert.equal(tokenOf(a), orders[0].access_token, `first press: ${a.status} ${a.location}`);
  assert.equal(tokenOf(b), orders[0].access_token, `second press: ${b.status} ${b.location}`);
  const cart = await v.get("/cart");
  assert.ok(!cart.text.includes(TAKEN), "no false 'taken by someone else'");
  assert.equal(h.emailsTo(buyer.email).length, 1, "one confirmation email");
});

test("account: a second press that arrives after the first has finished (the cart already empty) goes to the same reservation", async () => {
  const buyer = await h.account();
  const copy = await h.copy();
  const v = h.visitor(buyer);
  await v.post("/cart/add", { copyId: copy });
  const form = { name: "Pat", acceptCgv: "on", formShownAt: String(Date.now() - 1000) };
  const a = await v.post("/cart/reserve", form);
  assert.ok(tokenOf(a), `first press reserved: ${a.location}`);
  const b = await v.post("/cart/reserve", form);
  assert.equal(b.location, a.location, "not 'Your cart is empty'");
  assert.equal((await h.ordersOf(buyer)).length, 1);
  // Without the form's time (a page cached from before this change) an empty cart still says so.
  const c = await v.post("/cart/reserve", { name: "Pat", acceptCgv: "on" });
  assert.equal(c.seeOther || c.location, "/cart");
});

test("account: a seat-only cart pressed twice is reserved once (it used to be reserved twice)", async () => {
  const buyer = await h.account();
  const cls = await h.session({ capacity: 10 });
  const v = h.visitor(buyer);
  await v.post("/cart/add-dropin", { classId: cls });
  const form = { name: "Pat", acceptCgv: "on", formShownAt: String(Date.now() - 1000) };
  const [a, b] = await Promise.all([v.post("/cart/reserve", form), v.post("/cart/reserve", form)]);
  const orders = await h.ordersOf(buyer);
  assert.equal(orders.length, 1, "one reservation");
  assert.equal(tokenOf(a), orders[0].access_token);
  assert.equal(tokenOf(b), orders[0].access_token);
  const { rows } = await h.pool.query("SELECT count(*)::int AS n FROM class_dropin_seats WHERE class_id = $1 AND status = 'reserved'", [cls]);
  assert.equal(rows[0].n, 1, "one seat held");
});

test("account: the same seat reserved again from a fresh page (shown after the first reservation) is a new reservation", async () => {
  const buyer = await h.account();
  const cls = await h.session({ capacity: 10 });
  const v = h.visitor(buyer);
  await v.post("/cart/add-dropin", { classId: cls });
  const first = await v.post("/cart/reserve", { name: "Pat", acceptCgv: "on", formShownAt: String(Date.now() - 1000) });
  assert.ok(tokenOf(first));
  await new Promise((r) => setTimeout(r, 20));
  await v.post("/cart/add-dropin", { classId: cls });
  const second = await v.post("/cart/reserve", { name: "Pat", acceptCgv: "on", formShownAt: String(Date.now()) });
  assert.ok(tokenOf(second));
  assert.notEqual(tokenOf(second), tokenOf(first), "a second seat for a friend is not swallowed");
  assert.equal((await h.ordersOf(buyer)).length, 2);
});

test("guest: two Reserve presses at once make one reservation and both land on its page", async () => {
  const email = `guest-${h.uniq()}@example.test`;
  const copy = await h.copy();
  const v = h.visitor();
  await v.post("/cart/add", { copyId: copy });
  const form = { name: "Guest", email, acceptCgv: "on", formShownAt: String(Date.now() - 1000) };
  const [a, b] = await Promise.all([v.post("/cart/guest/reserve", form), v.post("/cart/guest/reserve", form)]);
  const orders = await guestOrders(email);
  assert.equal(orders.length, 1, "one reservation");
  assert.equal(tokenOf(a), orders[0].access_token, `first press: ${a.location}`);
  assert.equal(tokenOf(b), orders[0].access_token, `second press: ${b.location}`);
});

test("guest: a second press after the first has finished lands on the same reservation; another browser with that address and an empty cart does not", async () => {
  const email = `late-${h.uniq()}@example.test`;
  const v = h.visitor();
  await v.post("/cart/add", { copyId: await h.copy() });
  const form = { name: "Guest", email, acceptCgv: "on", formShownAt: String(Date.now() - 1000) };
  const a = await v.post("/cart/guest/reserve", form);
  assert.ok(tokenOf(a), `first press reserved: ${a.location}`);
  const b = await v.post("/cart/guest/reserve", form);
  assert.equal(b.location, a.location, "not 'Your cart is empty'");
  const stranger = h.visitor();
  const c = await stranger.post("/cart/guest/reserve", form);
  assert.equal(tokenOf(c), null, "the reservation is found from the session, never from the typed address");
  assert.equal((await guestOrders(email)).length, 1);
});

test("guest: somebody else typing that address (another connection, same book) never reaches that reservation", async () => {
  const email = `victim-${h.uniq()}@example.test`;
  const copy = await h.copy();
  const owner = h.visitor();
  const other = h.visitor(); // another IP (the harness gives each visitor its own)
  await owner.post("/cart/add", { copyId: copy });
  await other.post("/cart/add", { copyId: copy });
  const formShownAt = String(Date.now() - 1000);
  const a = await owner.post("/cart/guest/reserve", { name: "Owner", email, acceptCgv: "on", formShownAt });
  assert.ok(tokenOf(a));
  const b = await other.post("/cart/guest/reserve", { name: "Other", email, acceptCgv: "on", formShownAt });
  assert.equal(tokenOf(b), null, `the other connection is not sent to the owner's page: ${b.location}`);
  assert.equal((await guestOrders(email)).length, 1);
});

test("account: another account's reservation of the same copy is still 'taken by someone else'", async () => {
  const first = await h.account();
  const second = await h.account();
  const copy = await h.copy();
  const v1 = h.visitor(first);
  const v2 = h.visitor(second);
  await v1.post("/cart/add", { copyId: copy });
  await v2.post("/cart/add", { copyId: copy });
  const formShownAt = String(Date.now() - 1000);
  assert.ok(tokenOf(await v1.post("/cart/reserve", { name: "One", acceptCgv: "on", formShownAt })));
  const r = await v2.post("/cart/reserve", { name: "Two", acceptCgv: "on", formShownAt });
  assert.equal(r.seeOther || r.location, "/cart");
  assert.equal((await h.ordersOf(second)).length, 0);
});

test("both reserve forms disable their button once sent (data-saving-text, both languages) and carry the form's time", async () => {
  const buyer = await h.account();
  const v = h.visitor(buyer);
  await v.post("/cart/add", { copyId: await h.copy() });
  const cart = await v.get("/cart");
  assert.match(cart.text, /<form class="stack" method="post" action="\/cart\/reserve" data-saving-text="Reserving…">/);
  assert.match(cart.text, /name="formShownAt" value="\d{13}"/);
  const guest = h.visitor(null, { lang: "fr" });
  await guest.post("/cart/add", { copyId: await h.copy() });
  const form = await guest.get("/cart/guest");
  assert.match(form.text, /action="\/cart\/guest\/reserve" data-saving-text="Réservation en cours…"/);
  assert.match(form.text, /name="formShownAt" value="\d{13}"/);
});
