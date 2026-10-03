// Cart & checkout over HTTP (src/routes/cart.js): add/remove, checkout
// creating an order and locking copies, the sold-out race, HelloAsso
// unconfigured/failing, and the /cart/return reconcile paths.
//
// In-process (test/helpers/inProcessApp.js) rather than via startTestApp:
// the app there is a child process, and HelloAsso/mail can only be stubbed
// by overriding module exports in THIS process before the routes load.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen, waitFor } = require("../helpers/inProcessApp");
const { makeCookieJar } = require("../helpers/httpClient");

const db = prepareDatabase("cart_checkout");

const mailer = require("../../src/mailer");
const sentEmails = [];
mailer.sendMail = async (opts) => { sentEmails.push(opts); };

const helloasso = require("../../src/lib/helloasso");
let configured = true;
helloasso.isConfigured = () => configured;
const createdIntents = []; // args createCheckoutIntent was called with
let createIntentImpl;
helloasso.createCheckoutIntent = async (args) => createIntentImpl(args);
const intents = new Map(); // intent id -> object returned by the fake getCheckoutIntent
helloasso.getCheckoutIntent = async (id) => {
  if (!intents.has(String(id))) throw new Error(`HelloAsso down / unknown intent ${id}`);
  return intents.get(String(id));
};

const { pool } = require("../../src/db");
const { checkoutLimiter } = require("../../src/middleware/rateLimits");

let server;
before(async () => {
  db.create();
  server = await listen(buildApp([require("../../src/routes/cart")]));
});
after(async () => {
  await server.close();
  await pool.end();
  db.drop();
});

let seq = 0;
beforeEach(async () => {
  // Every request here comes from the same IP, and checkout caps pending
  // orders per IP — forget the IP on orders left by earlier tests so each
  // test starts from a clean slate (the per-IP tests below set it back).
  await pool.query("UPDATE orders SET client_ip = NULL WHERE client_ip IS NOT NULL");
  // ...and likewise the per-IP checkout rate limit (10/hour), which the
  // abuse-cap tests below would otherwise run into.
  for (const key of ["127.0.0.1", "::ffff:127.0.0.1", "::1"]) checkoutLimiter.resetKey(key);
  sentEmails.length = 0;
  createdIntents.length = 0;
  intents.clear();
  configured = true;
  createIntentImpl = async (args) => {
    createdIntents.push(args);
    const n = ++seq;
    return { id: `intent-${Date.now()}-${n}`, redirectUrl: `https://pay.example.test/checkout/${n}` };
  };
});

function visitor() {
  const jar = makeCookieJar();
  const send = async (path, { method = "GET", form } = {}) => {
    const res = await fetch(`${server.base}${path}`, {
      method,
      redirect: "manual",
      headers: { cookie: jar.header(), ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}) },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    jar.capture(res);
    return { res, text: await res.text() };
  };
  return {
    get: (p) => send(p),
    post: (p, form) => send(p, { method: "POST", form }),
    count: async () => JSON.parse((await send("/api/cart/count")).text).count,
  };
}

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function makeCopy({ price = 7.5, status = "in_stock" } = {}) {
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'Cart Author') RETURNING id", [`Cart Book ${uniq()}`]);
  const { rows } = await pool.query(
    "INSERT INTO book_copies (book_id, status, price) VALUES ($1, $2, $3) RETURNING id",
    [b[0].id, status, price]
  );
  return rows[0].id;
}
const copyRow = async (id) => (await pool.query("SELECT * FROM book_copies WHERE id = $1", [id])).rows[0];
const orderByEmail = async (email) => (await pool.query("SELECT * FROM orders WHERE buyer_email = $1 ORDER BY id", [email])).rows;

async function checkout(v, email, extra = {}) {
  return v.post("/cart/checkout", { name: "Cart Buyer", email, acceptCgv: "on", ...extra });
}

test("add to cart: in-stock copy is added once; unavailable/unknown/non-numeric ids are ignored", async () => {
  const v = visitor();
  const copy = await makeCopy();
  const sold = await makeCopy({ status: "sold" });

  assert.equal(await v.count(), 0);
  const r = await v.post("/cart/add", { copyId: copy });
  assert.equal(r.res.status, 302);
  assert.equal(r.res.headers.get("location"), "/cart");
  await v.post("/cart/add", { copyId: copy }); // duplicate
  await v.post("/cart/add", { copyId: sold });
  await v.post("/cart/add", { copyId: 99999999 });
  await v.post("/cart/add", { copyId: "abc" });
  assert.equal(await v.count(), 1);

  const page = await v.get("/cart");
  assert.equal(page.res.status, 200);
  assert.match(page.text, /Cart Book/);
  assert.match(page.text, /7\.50/);
});

test("add to cart: backTo is honoured only for same-origin paths", async () => {
  const v = visitor();
  const copy = await makeCopy();
  const ok = await v.post("/cart/add", { copyId: copy, backTo: "/books.html" });
  assert.equal(ok.res.headers.get("location"), "/books.html");
  for (const evil of ["//evil.example", "/\\evil.example", "https://evil.example"]) {
    const r = await v.post("/cart/add", { copyId: copy, backTo: evil });
    assert.equal(r.res.headers.get("location"), "/cart", `backTo ${evil} must fall back`);
  }
});

test("remove drops just that line", async () => {
  const v = visitor();
  const a = await makeCopy();
  const b = await makeCopy();
  await v.post("/cart/add", { copyId: a });
  await v.post("/cart/add", { copyId: b });
  assert.equal(await v.count(), 2);
  const page = await v.get("/cart");
  const lineIds = [...page.text.matchAll(/name="lineId" value="(\d+)"/g)].map((m) => m[1]);
  assert.equal(lineIds.length, 2);

  const r = await v.post("/cart/remove", { lineId: lineIds[0] });
  assert.equal(r.res.headers.get("location"), "/cart");
  assert.equal(await v.count(), 1);
  const after = await v.get("/cart");
  assert.deepEqual([...after.text.matchAll(/name="lineId" value="(\d+)"/g)].map((m) => m[1]), [lineIds[1]]);
});

test("a copy that sells while sitting in a cart is dropped from the cart view", async () => {
  const v = visitor();
  const copy = await makeCopy();
  await v.post("/cart/add", { copyId: copy });
  await pool.query("UPDATE book_copies SET status = 'sold' WHERE id = $1", [copy]);
  const page = await v.get("/cart");
  assert.match(page.text, /Your cart is empty/);
  assert.equal(await v.count(), 0);
});

test("checkout creates a pending order, locks the copies, calls HelloAsso and redirects to payment", async () => {
  const v = visitor();
  const a = await makeCopy({ price: 5 });
  const b = await makeCopy({ price: 3.25 });
  await v.post("/cart/add", { copyId: a });
  await v.post("/cart/add", { copyId: b });

  const email = `buyer-${uniq()}@example.test`;
  const r = await checkout(v, email.toUpperCase(), { name: "Ada Lovelace Byron", phone: "0102030405" });
  assert.equal(r.res.status, 302);
  assert.match(r.res.headers.get("location"), /^https:\/\/pay\.example\.test\/checkout\/\d+$/);

  const orders = await orderByEmail(email); // lower-cased by the route
  assert.equal(orders.length, 1);
  const order = orders[0];
  assert.equal(order.status, "pending");
  assert.equal(order.buyer_name, "Ada Lovelace Byron");
  assert.equal(order.buyer_phone, "0102030405");
  assert.equal(Number(order.total_amount), 8.25);
  assert.ok(order.checkout_intent_id, "intent id should be saved on the order");

  for (const id of [a, b]) {
    const c = await copyRow(id);
    assert.equal(c.status, "in_cart");
    assert.equal(c.cart_order_id, order.id);
  }
  const { rows: items } = await pool.query("SELECT book_copy_id FROM order_items WHERE order_id = $1 ORDER BY book_copy_id", [order.id]);
  assert.deepEqual(items.map((i) => i.book_copy_id), [a, b].sort((x, y) => x - y));

  assert.equal(createdIntents.length, 1);
  const intent = createdIntents[0];
  assert.equal(intent.amountCents, 825);
  assert.deepEqual(intent.metadata, { orderId: order.id });
  assert.deepEqual(intent.payer, { firstName: "Ada", lastName: "Lovelace Byron", email });
  assert.ok(intent.returnUrl.endsWith(`/cart/return?order=${order.access_token}`), "return URL carries the unguessable token, not the sequential id");

  assert.equal(await v.count(), 0, "cart is emptied once the buyer is sent to pay");
});

test("checkout validation: empty cart, missing name, bad email — no order, no HelloAsso call", async () => {
  const v = visitor();
  let r = await checkout(v, `empty-${uniq()}@example.test`);
  assert.equal(r.res.status, 200);
  assert.match(r.text, /Your cart is empty/);

  const copy = await makeCopy();
  await v.post("/cart/add", { copyId: copy });
  r = await v.post("/cart/checkout", { name: "", email: "nobody@example.test" });
  assert.match(r.text, /enter your name and a valid email/);
  r = await v.post("/cart/checkout", { name: "Name", email: "not-an-email" });
  assert.match(r.text, /enter your name and a valid email/);

  assert.equal(createdIntents.length, 0);
  assert.equal((await copyRow(copy)).status, "in_stock");
});

test("checkout without accepting the terms of sale is refused and locks nothing", async () => {
  const v = visitor();
  const copy = await makeCopy();
  await v.post("/cart/add", { copyId: copy });
  const email = `nocgv-${uniq()}@example.test`;
  const r = await v.post("/cart/checkout", { name: "Cart Buyer", email });
  assert.match(r.text, /accept the terms of sale/);
  assert.equal((await orderByEmail(email)).length, 0);
  assert.equal(createdIntents.length, 0);
  assert.equal((await copyRow(copy)).status, "in_stock");
});

test("checkout with HelloAsso unconfigured shows a message and locks nothing", async () => {
  configured = false;
  const v = visitor();
  const copy = await makeCopy();
  await v.post("/cart/add", { copyId: copy });
  const email = `unconf-${uniq()}@example.test`;
  const r = await checkout(v, email);
  assert.equal(r.res.status, 200);
  assert.match(r.text, /Online payment isn(?:'|&#39;)t set up yet/);
  assert.equal(createdIntents.length, 0);
  assert.equal((await orderByEmail(email)).length, 0);
  assert.equal((await copyRow(copy)).status, "in_stock");
  assert.equal(await v.count(), 1, "the cart is kept so the buyer can try again later");
});

test("when HelloAsso fails to create the intent the order is cancelled and the copies released", async () => {
  createIntentImpl = async () => { throw new Error("HelloAsso 503"); };
  const v = visitor();
  const copy = await makeCopy();
  await v.post("/cart/add", { copyId: copy });
  const email = `fail-${uniq()}@example.test`;
  const r = await checkout(v, email);
  assert.equal(r.res.status, 200);
  assert.match(r.text, /Couldn(?:'|&#39;)t reach the payment provider/);
  const [order] = await orderByEmail(email);
  assert.equal(order.status, "cancelled");
  const c = await copyRow(copy);
  assert.equal(c.status, "in_stock");
  assert.equal(c.cart_order_id, null);
});

test("sold-out race: two simultaneous checkouts for the same copy — exactly one wins", async () => {
  const copy = await makeCopy();
  const alice = visitor();
  const bob = visitor();
  await alice.post("/cart/add", { copyId: copy });
  await bob.post("/cart/add", { copyId: copy });

  const aEmail = `alice-${uniq()}@example.test`;
  const bEmail = `bob-${uniq()}@example.test`;
  const results = await Promise.all([checkout(alice, aEmail), checkout(bob, bEmail)]);

  const winners = results.filter((r) => r.res.status === 302);
  const losers = results.filter((r) => r.res.status === 200);
  assert.equal(winners.length, 1, "exactly one checkout redirects to payment");
  assert.equal(losers.length, 1);
  // Depending on timing the loser either read the cart before the winner's
  // lock committed (and hit the SOLD_OUT rollback) or after it (copy already
  // gone from its cart); both must end with no second order and a clear message.
  assert.match(losers[0].text, /just taken by someone else|Your cart is empty/);
  assert.equal(createdIntents.length, 1, "HelloAsso is only called for the winner");

  const orders = [...(await orderByEmail(aEmail)), ...(await orderByEmail(bEmail))];
  assert.equal(orders.length, 1, "the loser's order insert rolled back");
  const c = await copyRow(copy);
  assert.equal(c.status, "in_cart");
  assert.equal(c.cart_order_id, orders[0].id);
  const { rows: items } = await pool.query("SELECT 1 FROM order_items WHERE book_copy_id = $1", [copy]);
  assert.equal(items.length, 1);
});

test("a copy taken between the cart read and the lock rolls the whole checkout back with a friendly message", async () => {
  const v = visitor();
  const mine = await makeCopy();
  const contested = await makeCopy();
  await v.post("/cart/add", { copyId: mine });
  await v.post("/cart/add", { copyId: contested });

  // Deterministically reproduce the race window: right after checkout's own
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
  const email = `window-${uniq()}@example.test`;
  try {
    r = await checkout(v, email);
  } finally {
    pool.query = realQuery;
  }
  assert.equal(r.res.status, 200);
  assert.match(r.text, /just taken by someone else/);
  assert.equal((await orderByEmail(email)).length, 0, "no order left behind");
  assert.equal((await copyRow(mine)).status, "in_stock", "the copy that WAS available is not left locked");
  assert.equal(createdIntents.length, 0);
  assert.equal(await v.count(), 1, "cart now only holds the still-available copy");
});

// --- abuse caps and deadlock handling ------------------------------------

async function addToCart(v, ...ids) {
  for (const id of ids) await v.post("/cart/add", { copyId: id });
}

test("checkout refuses a 3rd pending order for one email, with a friendly message and nothing locked", async () => {
  const email = `cap-email-${uniq()}@example.test`;
  for (let i = 0; i < 2; i++) {
    const v = visitor();
    await addToCart(v, await makeCopy());
    assert.equal((await checkout(v, email)).res.status, 302);
    await pool.query("UPDATE orders SET client_ip = NULL WHERE buyer_email = $1", [email]); // isolate the email cap
  }
  const v = visitor();
  const copy = await makeCopy();
  await addToCart(v, copy);
  const r = await checkout(v, email.toUpperCase());
  assert.equal(r.res.status, 200);
  assert.match(r.text, /already have unpaid orders/);
  assert.equal((await orderByEmail(email)).length, 2);
  assert.equal((await copyRow(copy)).status, "in_stock", "nothing locked by the refused checkout");
  assert.equal(createdIntents.length, 2);
});

test("checkout refuses a 3rd pending order from one IP across different emails", async () => {
  for (let i = 0; i < 2; i++) {
    const v = visitor();
    await addToCart(v, await makeCopy());
    assert.equal((await checkout(v, `cap-ip-${uniq()}@example.test`)).res.status, 302);
  }
  const v = visitor();
  const copy = await makeCopy();
  await addToCart(v, copy);
  const email = `cap-ip-${uniq()}@example.test`;
  const r = await checkout(v, email);
  assert.match(r.text, /already have unpaid orders/);
  assert.equal((await orderByEmail(email)).length, 0);
  assert.equal((await copyRow(copy)).status, "in_stock");
  const { rows } = await pool.query("SELECT client_ip FROM orders WHERE client_ip IS NOT NULL LIMIT 1");
  assert.ok(rows[0].client_ip, "the IP is stored on the order");
});

test("pending orders older than the hold, and paid/cancelled ones, don't count towards the cap", async () => {
  const email = `cap-old-${uniq()}@example.test`;
  for (let i = 0; i < 2; i++) {
    const v = visitor();
    await addToCart(v, await makeCopy());
    assert.equal((await checkout(v, email)).res.status, 302);
  }
  await pool.query("UPDATE orders SET created_at = now() - interval '3 hours' WHERE buyer_email = $1", [email]);
  const v = visitor();
  await addToCart(v, await makeCopy());
  assert.equal((await checkout(v, email)).res.status, 302);
});

// Wraps pool.connect so each checkout transaction's client can be observed
// and made to fail like Postgres does when it picks the transaction as a
// deadlock victim.
function spyOnConnect({ deadlocks }) {
  const realConnect = pool.connect.bind(pool);
  const calls = [];
  let remaining = deadlocks;
  pool.connect = async (...args) => {
    // pool.query() itself calls connect(callback) — leave that form alone.
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

test("checkout locks copies in id order whatever order they were added to the cart", async () => {
  const low = await makeCopy();
  const high = await makeCopy();
  const v = visitor();
  await addToCart(v, high, low);
  const spy = spyOnConnect({ deadlocks: 0 });
  try {
    assert.equal((await checkout(v, `order-${uniq()}@example.test`)).res.status, 302);
  } finally {
    spy.restore();
  }
  const lock = spy.calls.find((c) => /FOR UPDATE/.test(c.sql) && /book_copies/.test(c.sql));
  assert.ok(lock, "copies are locked with SELECT ... FOR UPDATE");
  assert.match(lock.sql, /ORDER BY id/);
  assert.deepEqual(lock.params[0], [low, high].sort((a, b) => a - b));
});

test("checkout retries once when Postgres reports a deadlock", async () => {
  const v = visitor();
  const copy = await makeCopy();
  await addToCart(v, copy);
  const email = `retry-${uniq()}@example.test`;
  const spy = spyOnConnect({ deadlocks: 1 });
  let r;
  try {
    r = await checkout(v, email);
  } finally {
    spy.restore();
  }
  assert.equal(r.res.status, 302, "the retry succeeded");
  assert.equal((await orderByEmail(email)).length, 1, "exactly one order");
  assert.equal((await copyRow(copy)).status, "in_cart");
});

test("a checkout that deadlocks twice says 'try again' and leaves nothing locked", async () => {
  const v = visitor();
  const copy = await makeCopy();
  await addToCart(v, copy);
  const email = `retry2-${uniq()}@example.test`;
  const spy = spyOnConnect({ deadlocks: 2 });
  let r;
  try {
    r = await checkout(v, email);
  } finally {
    spy.restore();
  }
  assert.equal(r.res.status, 200);
  assert.match(r.text, /try again/i);
  assert.equal((await orderByEmail(email)).length, 0);
  assert.equal((await copyRow(copy)).status, "in_stock");
});

// --- /cart/return -------------------------------------------------------

async function pendingOrder({ intentId = `ret-${uniq()}` } = {}) {
  const copy = await makeCopy({ price: 4 });
  const { rows } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, total_amount, checkout_intent_id)
     VALUES ('Return Buyer', $1, 4.00, $2) RETURNING *`,
    [`return-${uniq()}@example.test`, intentId]
  );
  const order = rows[0];
  await pool.query(
    "UPDATE book_copies SET status = 'in_cart', cart_order_id = $1, cart_added_at = now() WHERE id = $2",
    [order.id, copy]
  );
  await pool.query("INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, 'Return Book', 4)", [order.id, copy]);
  return { order, copy, intentId };
}
const orderStatus = async (id) => (await pool.query("SELECT status FROM orders WHERE id = $1", [id])).rows[0].status;
const returnPath = (o) => `/cart/return?order=${o.access_token}`;

test("/cart/return rejects a missing, malformed or unknown token with 404", async () => {
  const v = visitor();
  for (const p of ["/cart/return", "/cart/return?order=1", "/cart/return?order=not-a-uuid", "/cart/return?order=00000000-0000-4000-8000-000000000000"]) {
    assert.equal((await v.get(p)).res.status, 404, p);
  }
});

test("/cart/return: HelloAsso says paid -> order paid, copies sold, confirmation email sent", async () => {
  const { order, copy, intentId } = await pendingOrder();
  intents.set(intentId, { order: { id: 4242, payments: [{ state: "Authorized" }] } });
  const r = await visitor().get(returnPath(order));
  assert.equal(r.res.status, 200);
  assert.match(r.text, /Thank you!/);
  assert.equal(await orderStatus(order.id), "paid");
  const c = await copyRow(copy);
  assert.equal(c.status, "sold");
  assert.equal(c.cart_order_id, null);
  const { rows } = await pool.query("SELECT helloasso_order_id FROM orders WHERE id = $1", [order.id]);
  assert.equal(rows[0].helloasso_order_id, "4242");
  await waitFor(() => sentEmails.length === 1, { message: "confirmation email" });
  assert.equal(sentEmails[0].to, order.buyer_email);
  assert.match(sentEmails[0].subject, /confirmed/);
  assert.match(sentEmails[0].text, /Return Book/);

  // A refresh must not double-process or re-email.
  await visitor().get(returnPath(order));
  await new Promise((r2) => setTimeout(r2, 100));
  assert.equal(sentEmails.length, 1);
});

test("/cart/return: HelloAsso says refused -> order cancelled, copies back in stock", async () => {
  const { order, copy, intentId } = await pendingOrder();
  intents.set(intentId, { order: { payments: [{ state: "Refused" }] } });
  const r = await visitor().get(returnPath(order));
  assert.equal(r.res.status, 200);
  assert.match(r.text, /Payment not completed/);
  assert.equal(await orderStatus(order.id), "cancelled");
  const c = await copyRow(copy);
  assert.equal(c.status, "in_stock");
  assert.equal(c.cart_order_id, null);
  assert.equal(sentEmails.length, 0);
});

test("/cart/return: still pending at HelloAsso -> stays pending, copies stay held", async () => {
  const { order, copy, intentId } = await pendingOrder();
  intents.set(intentId, { order: { payments: [{ state: "Pending" }] } });
  const r = await visitor().get(returnPath(order));
  assert.match(r.text, /Confirming your payment/);
  assert.equal(await orderStatus(order.id), "pending");
  assert.equal((await copyRow(copy)).status, "in_cart");
});

test("/cart/return: HelloAsso lookup error leaves the order pending for a later retry", async () => {
  const { order, copy } = await pendingOrder({ intentId: "never-registered" }); // fake API throws for it
  const r = await visitor().get(returnPath(order));
  assert.equal(r.res.status, 200);
  assert.match(r.text, /Confirming your payment/);
  assert.equal(await orderStatus(order.id), "pending");
  assert.equal((await copyRow(copy)).status, "in_cart");
});
