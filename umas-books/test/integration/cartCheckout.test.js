// Cart & reservation over HTTP (src/routes/cart.js): add/remove, "Reserve these
// books" creating a reservation and holding copies, the sold-out race, the
// per-account and per-IP limits, deadlock handling, and the reservation page
// (/cart/return).
//
// Nothing is paid online any more: the reserve step never talks to HelloAsso
// (the reserveHarness makes any such call throw, and the main test below
// asserts none was made).
//
// Real routes, in-process (test/helpers/reserveHarness.js): the harness gives
// every visitor its own IP so the per-IP rate limits never collide.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");
const { makeCookieJar } = require("../helpers/httpClient");
const { sessionHeaders } = require("../helpers/accounts");
const { MAX_ACTIVE_RESERVATIONS } = require("../../src/lib/legal");

const h = reserveHarness("cart_checkout");
const { pool } = h;
before(() => h.start());
after(() => h.stop());
beforeEach(() => { h.sent.length = 0; });

const count = async (v) => JSON.parse((await v.get("/api/cart/count")).text).count;
const copyRow = async (id) => (await pool.query("SELECT * FROM book_copies WHERE id = $1", [id])).rows[0];
const FORM = { name: "Cart Buyer", acceptCgv: "on" };

test("add to cart: in-stock copy is added once; unavailable/unknown/non-numeric ids are ignored", async () => {
  const v = h.visitor();
  const copy = await h.copy({ price: 7.5 });
  const sold = await h.copy({ status: "sold" });

  assert.equal(await count(v), 0);
  const r = await v.post("/cart/add", { copyId: copy });
  assert.equal(r.status, 302);
  assert.equal(r.location, "/cart");
  await v.post("/cart/add", { copyId: copy }); // duplicate
  await v.post("/cart/add", { copyId: sold });
  await v.post("/cart/add", { copyId: 99999999 });
  await v.post("/cart/add", { copyId: "abc" });
  assert.equal(await count(v), 1);

  const page = await v.get("/cart");
  assert.equal(page.status, 200);
  assert.match(page.text, /Reserve Book/);
  assert.match(page.text, /7\.50/);
});

test("add to cart: backTo is honoured only for same-origin paths", async () => {
  const v = h.visitor();
  const copy = await h.copy();
  const ok = await v.post("/cart/add", { copyId: copy, backTo: "/books.html" });
  assert.equal(ok.location, "/books.html");
  for (const evil of ["//evil.example", "/\\evil.example", "https://evil.example"]) {
    const r = await v.post("/cart/add", { copyId: copy, backTo: evil });
    assert.equal(r.location, "/cart", `backTo ${evil} must fall back`);
  }
});

test("remove drops just that line", async () => {
  const v = h.visitor();
  const a = await h.copy();
  const b = await h.copy();
  await v.post("/cart/add", { copyId: a });
  await v.post("/cart/add", { copyId: b });
  assert.equal(await count(v), 2);
  const page = await v.get("/cart");
  const lineIds = [...page.text.matchAll(/name="lineId" value="(\d+)"/g)].map((m) => m[1]);
  assert.equal(lineIds.length, 2);

  const r = await v.post("/cart/remove", { lineId: lineIds[0] });
  assert.equal(r.location, "/cart");
  assert.equal(await count(v), 1);
  const after = await v.get("/cart");
  assert.deepEqual([...after.text.matchAll(/name="lineId" value="(\d+)"/g)].map((m) => m[1]), [lineIds[1]]);
});

test("a copy that sells while sitting in a cart is dropped from the cart view", async () => {
  const v = h.visitor();
  const copy = await h.copy();
  await v.post("/cart/add", { copyId: copy });
  await pool.query("UPDATE book_copies SET status = 'sold' WHERE id = $1", [copy]);
  const page = await v.get("/cart");
  assert.match(page.text, /Your cart is empty/);
  assert.equal(await count(v), 0);
});

test("reserving creates a 'reserved' order under the account, holds the copies, empties the cart and never calls HelloAsso", async () => {
  const buyer = await h.account({ email: `Buyer-${h.uniq()}@Example.test` });
  const a = await h.copy({ price: 5 });
  const b = await h.copy({ price: 3.25 });
  const v = h.visitor(buyer);
  await v.post("/cart/add", { copyId: a });
  await v.post("/cart/add", { copyId: b });

  const r = await v.post("/cart/reserve", { name: "Ada Lovelace Byron", phone: "0102030405", acceptCgv: "on", email: "someone-else@example.test" });
  assert.equal(r.status, 302);
  assert.match(r.location, /^\/cart\/return\?order=[0-9a-f-]{36}$/);

  const orders = await h.ordersOf(buyer);
  assert.equal(orders.length, 1);
  const order = orders[0];
  assert.equal(order.status, "reserved");
  assert.equal(order.buyer_email, buyer.email, "the account's (lower-cased) email, never a posted one");
  assert.equal(order.buyer_name, "Ada Lovelace Byron");
  assert.equal(order.buyer_phone, "0102030405");
  assert.equal(Number(order.total_amount), 8.25);
  assert.equal(order.checkout_intent_id, null, "no online payment intent exists any more");
  assert.equal(order.paid_at, null);
  assert.ok(r.location.endsWith(order.access_token), "the page link carries the unguessable token, not the sequential id");

  for (const id of [a, b]) {
    const c = await copyRow(id);
    assert.equal(c.status, "reserved");
    assert.equal(c.cart_order_id, order.id);
  }
  const { rows: items } = await pool.query("SELECT book_copy_id FROM order_items WHERE order_id = $1 ORDER BY book_copy_id", [order.id]);
  assert.deepEqual(items.map((i) => i.book_copy_id), [a, b].sort((x, y) => x - y));

  assert.equal(await count(v), 0, "cart is emptied once the books are held");
  assert.deepEqual(h.helloassoCalls, [], "HelloAsso was never called");
});

test("reserve validation: empty cart, no name anywhere: no order, no hold", async () => {
  const buyer = await h.account();
  const v = h.visitor(buyer);
  let r = await v.post("/cart/reserve", FORM);
  assert.equal(r.status, 200);
  assert.match(r.text, /Your cart is empty/);

  const copy = await h.copy();
  // An account with no display name and a blank name field: nothing to put on the order.
  const nameless = await h.account({ displayName: "" });
  const w = h.visitor(nameless);
  await w.post("/cart/add", { copyId: copy });
  r = await w.post("/cart/reserve", { name: "", acceptCgv: "on" });
  assert.match(r.text, /Please enter your name\./);

  assert.equal((await h.ordersOf(buyer)).length + (await h.ordersOf(nameless)).length, 0);
  assert.equal((await copyRow(copy)).status, "in_stock");
});

test("the name defaults to the account's display name when the field is left empty", async () => {
  const buyer = await h.account({ displayName: "Default Name" });
  const { order } = await h.reserve(buyer, { copyIds: [await h.copy()], name: "" });
  assert.equal(order.buyer_name, "Default Name");
});

test("reserving without accepting the terms of sale is refused and holds nothing", async () => {
  const buyer = await h.account();
  const v = h.visitor(buyer);
  const copy = await h.copy();
  await v.post("/cart/add", { copyId: copy });
  const r = await v.post("/cart/reserve", { name: "No Terms", acceptCgv: "" });
  assert.match(r.text, /accept the terms of sale/);
  assert.equal((await h.ordersOf(buyer)).length, 0);
  assert.equal((await copyRow(copy)).status, "in_stock");
});

test("sold-out race: two simultaneous reservations for the same copy: exactly one wins", async () => {
  const copy = await h.copy();
  const [alice, bob] = [await h.account(), await h.account()];
  const va = h.visitor(alice);
  const vb = h.visitor(bob);
  await va.post("/cart/add", { copyId: copy });
  await vb.post("/cart/add", { copyId: copy });

  const results = await Promise.all([va.post("/cart/reserve", FORM), vb.post("/cart/reserve", FORM)]);
  const winners = results.filter((r) => r.status === 302);
  const losers = results.filter((r) => r.status === 200);
  assert.equal(winners.length, 1, "exactly one reservation is made");
  assert.equal(losers.length, 1);
  // Depending on timing the loser either read the cart before the winner's
  // hold committed (and hit the SOLD_OUT rollback) or after it (copy already
  // gone from its cart); both must end with no second order and a clear message.
  assert.match(losers[0].text, /just taken by someone else|Your cart is empty/);

  const orders = [...(await h.ordersOf(alice)), ...(await h.ordersOf(bob))];
  assert.equal(orders.length, 1, "the loser's order insert rolled back");
  const c = await copyRow(copy);
  assert.equal(c.status, "reserved");
  assert.equal(c.cart_order_id, orders[0].id);
  const { rows: items } = await pool.query("SELECT 1 FROM order_items WHERE book_copy_id = $1", [copy]);
  assert.equal(items.length, 1);
});

test("a copy taken between the cart read and the hold rolls the whole reservation back with a friendly message", async () => {
  const buyer = await h.account();
  const v = h.visitor(buyer);
  const mine = await h.copy();
  const contested = await h.copy();
  await v.post("/cart/add", { copyId: mine });
  await v.post("/cart/add", { copyId: contested });

  // Deterministically reproduce the race window: right after the route's own
  // read of the cart's copies, someone else buys one of them.
  const realQuery = pool.query.bind(pool);
  let armed = true;
  pool.query = async (...args) => {
    const result = await realQuery(...args);
    if (armed && typeof args[0] === "string" && args[0].includes("c.status = 'in_stock'") && args[0].includes("JOIN books")) {
      armed = false;
      await realQuery("UPDATE book_copies SET status = 'sold' WHERE id = $1", [contested]);
    }
    return result;
  };
  let r;
  try {
    r = await v.post("/cart/reserve", FORM);
  } finally {
    pool.query = realQuery;
  }
  assert.equal(r.status, 200);
  assert.match(r.text, /just taken by someone else/);
  assert.equal((await h.ordersOf(buyer)).length, 0, "no order left behind");
  assert.equal((await copyRow(mine)).status, "in_stock", "the copy that WAS available is not left held");
  assert.equal(await count(v), 1, "cart now only holds the still-available copy");
});

// --- abuse caps and deadlock handling ------------------------------------

test("a 4th open reservation for one account is refused with a friendly message and nothing held", async () => {
  const buyer = await h.account();
  for (let i = 0; i < MAX_ACTIVE_RESERVATIONS; i++) {
    assert.equal((await h.reserve(buyer, { copyIds: [await h.copy()] })).r.status, 302);
  }
  const copy = await h.copy();
  const v = h.visitor(buyer);
  await v.post("/cart/add", { copyId: copy });
  const r = await v.post("/cart/reserve", FORM);
  assert.equal(r.status, 200);
  assert.match(r.text, new RegExp(`${MAX_ACTIVE_RESERVATIONS} open reservations`));
  assert.equal((await h.ordersOf(buyer)).length, MAX_ACTIVE_RESERVATIONS);
  assert.equal((await copyRow(copy)).status, "in_stock", "nothing held by the refused reservation");
});

test("only OPEN reservations count towards the cap: cancelled, expired and collected ones do not", async () => {
  const buyer = await h.account();
  const made = [];
  for (let i = 0; i < MAX_ACTIVE_RESERVATIONS; i++) made.push((await h.reserve(buyer, { copyIds: [await h.copy()] })).order);
  await pool.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [made[0].id]);
  await pool.query("UPDATE orders SET status = 'expired' WHERE id = $1", [made[1].id]);
  await pool.query("UPDATE orders SET status = 'paid' WHERE id = $1", [made[2].id]);
  assert.equal((await h.reserve(buyer, { copyIds: [await h.copy()] })).r.status, 302);
});

test("the per-IP limit: the 11th reservation attempt from one connection (a shared wifi gets 10) is refused with 429 and holds nothing", async () => {
  const ip = `10.250.${Math.floor(Math.random() * 200)}.${Math.floor(Math.random() * 200) + 1}`;
  const jar = makeCookieJar();
  const send = async (account, path, form) => {
    const res = await fetch(`${h.base}${path}`, {
      method: "POST", redirect: "manual",
      headers: { "x-forwarded-for": ip, cookie: jar.header(), ...sessionHeaders(account), "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
    jar.capture(res);
    return { status: res.status, text: await res.text() };
  };
  for (let i = 0; i < 10; i++) {
    const account = await h.account();
    await send(account, "/cart/add", { copyId: await h.copy() });
    assert.equal((await send(account, "/cart/reserve", FORM)).status, 302, `reservation ${i + 1}`);
  }
  const account = await h.account();
  const copy = await h.copy();
  await send(account, "/cart/add", { copyId: copy });
  const r = await send(account, "/cart/reserve", FORM);
  assert.equal(r.status, 429);
  assert.equal((await h.ordersOf(account)).length, 0);
  assert.equal((await copyRow(copy)).status, "in_stock");
  // The buyer's IP is not kept on the orders any more (nothing to retain).
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM orders WHERE client_ip IS NOT NULL");
  assert.equal(rows[0].n, 0);
});

// Wraps pool.connect so each reservation transaction's client can be observed
// and made to fail like Postgres does when it picks the transaction as a
// deadlock victim.
function spyOnConnect({ deadlocks }) {
  const realConnect = pool.connect.bind(pool);
  const calls = [];
  let remaining = deadlocks;
  pool.connect = async (...args) => {
    // pool.query() itself calls connect(callback): leave that form alone.
    if (typeof args[0] === "function") return realConnect(...args);
    const client = await realConnect(...args);
    const realQuery = client.query;
    const realRelease = client.release;
    client.release = (...a) => { client.query = realQuery; client.release = realRelease; return realRelease.apply(client, a); };
    client.query = (sql, params) => {
      if (typeof sql === "string") {
        calls.push({ sql, params });
        if (sql.includes("INSERT INTO orders") && remaining > 0) {
          remaining--;
          return Promise.reject(Object.assign(new Error("deadlock detected"), { code: "40P01" }));
        }
      }
      return realQuery.call(client, sql, params);
    };
    return client;
  };
  return { calls, restore: () => { pool.connect = realConnect; } };
}

test("a reservation locks copies in id order whatever order they were added to the cart", async () => {
  const low = await h.copy();
  const high = await h.copy();
  const buyer = await h.account();
  const v = h.visitor(buyer);
  await v.post("/cart/add", { copyId: high });
  await v.post("/cart/add", { copyId: low });
  const spy = spyOnConnect({ deadlocks: 0 });
  try {
    assert.equal((await v.post("/cart/reserve", FORM)).status, 302);
  } finally {
    spy.restore();
  }
  const lock = spy.calls.find((c) => /FOR UPDATE/.test(c.sql) && /book_copies/.test(c.sql));
  assert.ok(lock, "copies are locked with SELECT ... FOR UPDATE");
  assert.match(lock.sql, /ORDER BY id/);
  assert.deepEqual(lock.params[0], [low, high].sort((a, b) => a - b));
});

test("a reservation retries once when Postgres reports a deadlock", async () => {
  const buyer = await h.account();
  const v = h.visitor(buyer);
  const copy = await h.copy();
  await v.post("/cart/add", { copyId: copy });
  const spy = spyOnConnect({ deadlocks: 1 });
  let r;
  try {
    r = await v.post("/cart/reserve", FORM);
  } finally {
    spy.restore();
  }
  assert.equal(r.status, 302, "the retry succeeded");
  assert.equal((await h.ordersOf(buyer)).length, 1, "exactly one order");
  assert.equal((await copyRow(copy)).status, "reserved");
});

test("a reservation that deadlocks twice says 'try again' and leaves nothing held", async () => {
  const buyer = await h.account();
  const v = h.visitor(buyer);
  const copy = await h.copy();
  await v.post("/cart/add", { copyId: copy });
  const spy = spyOnConnect({ deadlocks: 2 });
  let r;
  try {
    r = await v.post("/cart/reserve", FORM);
  } finally {
    spy.restore();
  }
  assert.equal(r.status, 200);
  assert.match(r.text, /try again/i);
  assert.equal((await h.ordersOf(buyer)).length, 0);
  assert.equal((await copyRow(copy)).status, "in_stock");
});

// --- /cart/return: the reservation page -----------------------------------

test("/cart/return rejects a missing, malformed or unknown token with 404", async () => {
  const v = h.visitor();
  for (const p of ["/cart/return", "/cart/return?order=1", "/cart/return?order=not-a-uuid", "/cart/return?order=00000000-0000-4000-8000-000000000000"]) {
    assert.equal((await v.get(p)).status, 404, p);
  }
});

test("/cart/return shows the reservation as the buyer's proof: number, items, total, deadline, print button; a refresh changes nothing and sends nothing", async () => {
  const buyer = await h.account();
  const copy = await h.copy({ price: 4, title: "Proof Book" });
  const { order } = await h.reserve(buyer, { copyIds: [copy] });
  assert.equal(h.emailsTo(buyer.email).length, 1);
  const g = h.visitor();
  const r = await g.get(`/cart/return?order=${order.access_token}`);
  assert.equal(r.status, 200);
  assert.match(r.text, new RegExp(`Reservation #${order.id} confirmed`));
  assert.match(r.text, /id="order-summary"/);
  assert.match(r.text, /Proof Book/);
  assert.match(r.text, /Total to pay at the shop:[^<]*4\.00|Total to pay at the shop:[^<]*4,00/);
  assert.match(r.text, /id="reservation-deadline"/);
  assert.match(r.text, /data-print/);
  assert.match(r.text, /print-button\.js/);
  await g.get(`/cart/return?order=${order.access_token}`);
  assert.equal((await h.order(order.id)).status, "reserved");
  assert.equal((await copyRow(copy)).status, "reserved");
  assert.equal(h.emailsTo(buyer.email).length, 1, "no second email");
  assert.deepEqual(h.helloassoCalls, [], "looking at the page asks HelloAsso nothing");
});

test("with Gmail down the buyer still gets the reservation page, and the confirmation waits in the outbox", async () => {
  const mailer = require("../../src/mailer");
  const realSend = mailer.sendMail;
  mailer.sendMail = async () => { throw new Error("smtp down"); };
  const realError = console.error;
  console.error = () => {};
  const buyer = await h.account();
  let result;
  try {
    result = await h.reserve(buyer, { copyIds: [await h.copy()] });
  } finally { console.error = realError; mailer.sendMail = realSend; }
  const { order, r } = result;
  assert.equal(r.status, 302, "the reservation is made even though the email could not be sent");
  const page = await h.visitor().get(`/cart/return?order=${order.access_token}`);
  assert.match(page.text, new RegExp(`Reservation #${order.id} confirmed`));
  const { rows } = await pool.query("SELECT kind, status, attempts FROM email_outbox WHERE related_order_id = $1", [order.id]);
  assert.deepEqual(rows, [{ kind: "order_confirmation", status: "pending", attempts: 1 }]);
});

test("/cart/return for a cancelled, expired or collected reservation says so (a cancelled one tells the buyer nothing was charged)", async () => {
  const buyer = await h.account();
  const mk = async () => (await h.reserve(buyer, { copyIds: [await h.copy({ title: "Done Book" })] })).order;
  const [a, b] = [await mk(), await mk()];
  await pool.query("UPDATE orders SET status = 'cancelled' WHERE id = $1", [a.id]);
  await pool.query("UPDATE orders SET status = 'expired' WHERE id = $1", [b.id]);
  const g = h.visitor();
  assert.match((await g.get(`/cart/return?order=${a.access_token}`)).text, /Reservation cancelled[\s\S]*Nothing was charged/);
  assert.match((await g.get(`/cart/return?order=${b.access_token}`)).text, /Reservation ended/);
  await pool.query("UPDATE orders SET status = 'paid', paid_at = now() WHERE id = $1", [a.id]);
  assert.match((await g.get(`/cart/return?order=${a.access_token}`)).text, new RegExp(`Reservation #${a.id} collected`));
});
