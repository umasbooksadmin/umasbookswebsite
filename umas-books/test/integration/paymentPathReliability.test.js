// Payment-path reliability (src/lib/cart.js, src/routes/cart.js):
//  1. a paid order is never lost to the hold-expiry sweep racing reconcileOrder;
//  2. one order whose hold release throws does not stop the others expiring;
//  3. /cart/return never tells a charged buyer "nothing was charged";
//  4. the reconcile sweep stops after the first systemic HelloAsso failure
//     and mentions a persistent outage once, not every run.
//
// In-process (test/helpers/inProcessApp.js). Mail, HelloAsso and the admin
// alert are stubbed by overriding module exports BEFORE cart.js loads.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");

const db = prepareDatabase("payment_path", { isolated: true });

const mailer = require("../../src/mailer");
const sentEmails = [];
mailer.sendMail = async (opts) => { sentEmails.push(opts); };

const errorAlert = require("../../src/lib/errorAlert");
const alerts = []; // { label, body, opts }
errorAlert.alertOnError = async (label, body, opts) => { alerts.push({ label, body: String(body), opts: opts || {} }); };

const helloasso = require("../../src/lib/helloasso");
const intents = new Map();
const lookups = [];
let intentHook = null; // async (id) => void, runs inside the lookup
helloasso.getCheckoutIntent = async (id) => {
  lookups.push(String(id));
  if (intentHook) await intentHook(String(id));
  if (!intents.has(String(id))) throw new Error(`unknown intent ${id}`);
  const v = intents.get(String(id));
  if (v instanceof Error) throw v;
  return v;
};

const { pool } = require("../../src/db");
const cart = require("../../src/lib/cart");
const realRelease = cart.releaseCartHold;

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

beforeEach(() => {
  sentEmails.length = 0;
  alerts.length = 0;
  lookups.length = 0;
  intents.clear();
  intentHook = null;
  cart.releaseCartHold = realRelease;
  cart.resetHelloAssoFailureStreak();
});

let seq = 0;
const uniq = () => `${Date.now()}-${++seq}-${Math.floor(Math.random() * 1e6)}`;
const paid = (orderId) => ({ order: { id: 70000 + orderId, payments: [{ state: "Authorized" }] } });

// An order with one copy. `held` = the copy is locked in_cart for it
// (a live pending checkout); otherwise the copy is back in stock.
async function makeOrder({ status = "pending", held = status === "pending", ageMinutes = 0 } = {}) {
  const u = uniq();
  const intentId = `pp-${u}`;
  const { rows } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, total_amount, status, checkout_intent_id, created_at)
     VALUES ('Pay Buyer', $1, 6.00, $2, $3, now() - ($4 || ' minutes')::interval) RETURNING *`,
    [`pp-${u}@example.test`, status, intentId, String(ageMinutes)]
  );
  const order = rows[0];
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'A') RETURNING id", [`PP Book ${u}`]);
  const { rows: c } = await pool.query(
    held
      ? "INSERT INTO book_copies (book_id, status, price, cart_order_id, cart_added_at) VALUES ($1, 'in_cart', 6.00, $2, now() - ($3 || ' minutes')::interval) RETURNING id"
      : "INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 6.00) RETURNING id",
    held ? [b[0].id, order.id, String(ageMinutes)] : [b[0].id]
  );
  await pool.query("INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, $3, 6.00)", [
    order.id, c[0].id, `PP Book ${u}`,
  ]);
  return { order, copyId: c[0].id, intentId };
}
const orderRow = async (id) => (await pool.query("SELECT * FROM orders WHERE id = $1", [id])).rows[0];
const copyStatus = async (id) => (await pool.query("SELECT status FROM book_copies WHERE id = $1", [id])).rows[0].status;

// --- 1. stale snapshot race ---------------------------------------------

test("race: hold expires between the snapshot and markOrderPaid -> payment recovered, not lost", async () => {
  const { order, copyId, intentId } = await makeOrder({ ageMinutes: 90 });
  intents.set(intentId, paid(order.id));
  // The expiry sweep lands while reconcileOrder is waiting on HelloAsso.
  intentHook = async () => { await cart.releaseCartHold(pool, order.id, "expired"); };

  const result = await cart.reconcileOrder(pool, order); // `order` is the stale 'pending' snapshot

  const after = await orderRow(order.id);
  assert.equal(result, "paid");
  assert.equal(after.status, "paid");
  assert.equal(await copyStatus(copyId), "sold");
  assert.ok(after.helloasso_order_id);
  assert.equal(sentEmails.filter((e) => e.to === order.buyer_email).length, 1);
});

test("race: expired AND the copy was resold meanwhile -> admin alerted, never 'expired + stamped + silent'", async () => {
  const { order, copyId, intentId } = await makeOrder({ ageMinutes: 90 });
  intents.set(intentId, paid(order.id));
  intentHook = async () => {
    await cart.releaseCartHold(pool, order.id, "expired");
    await pool.query("UPDATE book_copies SET status = 'sold' WHERE id = $1", [copyId]);
  };

  await cart.reconcileOrder(pool, order);

  const after = await orderRow(order.id);
  const alerted = alerts.some((a) => a.opts.force && a.label.includes(`Paid order ${order.id}`));
  assert.ok(alerted, "admin must be alerted");
  assert.notEqual(after.status, "paid", "nothing is fulfilled when the copy is gone");
});

test("race: another caller already marked it paid -> returns paid, no second email", async () => {
  const { order, intentId } = await makeOrder();
  intents.set(intentId, paid(order.id));
  intentHook = async () => { await cart.markOrderPaid(pool, order); };
  sentEmails.length = 0;

  assert.equal(await cart.reconcileOrder(pool, order), "paid");
  assert.equal(sentEmails.filter((e) => e.to === order.buyer_email).length, 1);
  assert.equal((await orderRow(order.id)).status, "paid");
});

test("markOrderPaid reports whether it won", async () => {
  const { order } = await makeOrder();
  assert.equal(await cart.markOrderPaid(pool, order), true);
  assert.equal(await cart.markOrderPaid(pool, order), false);
});

// --- 2. poison order ----------------------------------------------------

test("expireStaleCartHolds: one order whose release throws does not stop the rest; alerts once", async () => {
  const a = await makeOrder({ ageMinutes: 120 });
  const poison = await makeOrder({ ageMinutes: 120 });
  const b = await makeOrder({ ageMinutes: 120 });
  cart.releaseCartHold = async (p, id, status) => {
    if (id === poison.order.id) throw new Error("boom");
    return realRelease(p, id, status);
  };

  await cart.expireStaleCartHolds(pool);

  assert.equal((await orderRow(a.order.id)).status, "expired");
  assert.equal((await orderRow(b.order.id)).status, "expired");
  assert.equal(await copyStatus(a.copyId), "in_stock");
  assert.equal(await copyStatus(b.copyId), "in_stock");
  assert.equal((await orderRow(poison.order.id)).status, "pending");
  const mine = alerts.filter((x) => x.body.includes(String(poison.order.id)));
  assert.equal(mine.length, 1);
  assert.equal(alerts.length, 1, "a single alert, not one per failure");
});

// --- 3. /cart/return ----------------------------------------------------

const getReturn = async (o) => {
  const res = await fetch(`${server.base}/cart/return?order=${o.access_token}`);
  return { status: res.status, text: await res.text() };
};

test("/cart/return: cancelled order that was paid after all -> paid page, never 'nothing was charged'", async () => {
  const { order, copyId, intentId } = await makeOrder({ status: "cancelled" });
  intents.set(intentId, paid(order.id));

  const r = await getReturn(order);

  assert.equal(r.status, 200);
  assert.match(r.text, /Thank you!/);
  assert.doesNotMatch(r.text, /nothing was charged/);
  assert.equal((await orderRow(order.id)).status, "paid");
  assert.equal(await copyStatus(copyId), "sold");
});

test("/cart/return: paid but items can't be reclaimed -> 'we received your payment' message", async () => {
  const { order, copyId, intentId } = await makeOrder({ status: "expired" });
  await pool.query("UPDATE book_copies SET status = 'sold' WHERE id = $1", [copyId]);
  intents.set(intentId, paid(order.id));

  const r = await getReturn(order);

  assert.equal(r.status, 200);
  assert.match(r.text, /received your payment/);
  assert.doesNotMatch(r.text, /nothing was charged/);
  assert.ok(alerts.some((a) => a.opts.force));
  // A refresh shows the same message without re-alerting.
  alerts.length = 0;
  const again = await getReturn(order);
  assert.match(again.text, /received your payment/);
  assert.equal(alerts.length, 0);
});

test("/cart/return: closed order that was really never paid still says nothing was charged", async () => {
  const { order, intentId } = await makeOrder({ status: "cancelled" });
  intents.set(intentId, { order: { payments: [{ state: "Refused" }] } });
  const r = await getReturn(order);
  assert.match(r.text, /nothing was charged/);
});

// --- 4. sweep stops on systemic HelloAsso failure -----------------------

test("reconcilePendingOrders stops after the first network failure; alerts once for a persistent outage", async () => {
  const orders = [];
  for (let i = 0; i < 3; i++) orders.push(await makeOrder({ ageMinutes: 30 }));
  const mine = new Set(orders.map((o) => o.intentId));
  for (const o of orders) {
    const err = new Error("HelloAsso request failed: fetch failed");
    err.kind = "network";
    intents.set(o.intentId, err);
  }
  const myLookups = () => lookups.filter((l) => mine.has(l)).length;

  await cart.reconcilePendingOrders(pool, { includeClosed: false });

  assert.equal(myLookups(), 1, "stops after the first systemic failure instead of trying every order");
  assert.equal(alerts.filter((a) => a.label === "HelloAsso reconciliation failing").length, 1);
  assert.equal(cart.getHelloAssoFailureStreak(), 1);

  await cart.reconcilePendingOrders(pool, { includeClosed: false });
  assert.equal(cart.getHelloAssoFailureStreak(), 2);
  assert.equal(alerts.filter((a) => a.label === "HelloAsso reconciliation failing").length, 1, "not re-alerted on every run");

  // Recovery resets the counter.
  for (const o of orders) intents.set(o.intentId, { order: { payments: [{ state: "Pending" }] } });
  await cart.reconcilePendingOrders(pool, { includeClosed: false });
  assert.equal(cart.getHelloAssoFailureStreak(), 0);
});

test("reconcilePendingOrders: a non-systemic error on one order does not stop the sweep", async () => {
  const orders = [];
  for (let i = 0; i < 2; i++) orders.push(await makeOrder({ ageMinutes: 30 }));
  intents.set(orders[0].intentId, Object.assign(new Error("HelloAsso API GET failed: 404"), { kind: "http" }));
  intents.set(orders[1].intentId, { order: { id: 1, payments: [{ state: "Pending" }] } });
  await cart.reconcilePendingOrders(pool, { includeClosed: false });
  assert.ok(lookups.includes(orders[1].intentId));
  assert.equal(cart.getHelloAssoFailureStreak(), 0);
});

test("runCartMaintenance runs expiry before reconcile, never concurrently", async () => {
  const events = [];
  const origExpire = cart.expireStaleCartHolds;
  const origReconcile = cart.reconcilePendingOrders;
  cart.expireStaleCartHolds = async () => {
    events.push("expire:start");
    await new Promise((r) => setTimeout(r, 50));
    events.push("expire:end");
    throw new Error("expiry blew up"); // must not prevent the reconcile
  };
  cart.reconcilePendingOrders = async () => { events.push("reconcile"); };
  const realErr = console.error;
  console.error = () => {};
  try {
    await cart.runCartMaintenance(pool, { includeClosed: false });
  } finally {
    console.error = realErr;
    cart.expireStaleCartHolds = origExpire;
    cart.reconcilePendingOrders = origReconcile;
  }
  assert.deepEqual(events, ["expire:start", "expire:end", "reconcile"]);
});
