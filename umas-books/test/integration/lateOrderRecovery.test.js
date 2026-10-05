// Payment reliability (src/lib/cart.js):
//  - an order that was expired/cancelled locally but turns out to have
//    been paid at HelloAsso is recovered (copies re-claimed, order paid)
//    or, if any item was resold meanwhile, left completely untouched and
//    the admin is alerted;
//  - the periodic sweep looks at recently expired orders (not old ones);
//  - saving the checkout intent id is retried once, then alerts;
//  - a webhook-supplied intent id is adopted only if HelloAsso confirms
//    it belongs to that order.
//
// Own throwaway database (same pattern as orderIdempotency.test.js);
// mailer and HelloAsso lookups are mocked by overriding module exports
// BEFORE cart.js is required (it destructures them at require time).

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { prepareDatabase } = require("../helpers/testDatabase");

// Own database even on the shared CI one (see helpers/testDatabase.js).
const db = prepareDatabase("late_recovery", { isolated: true });

const mailer = require("../../src/mailer");
const sentEmails = [];
mailer.sendMail = async (opts) => {
  sentEmails.push(opts);
};

const helloasso = require("../../src/lib/helloasso");
const intents = new Map(); // intent id -> intent object returned by the fake API
helloasso.getCheckoutIntent = async (id) => {
  if (!intents.has(String(id))) throw new Error(`unknown intent ${id}`);
  return intents.get(String(id));
};

const { pool } = require("../../src/db");
const {
  reconcileOrder,
  reconcilePendingOrders,
  persistCheckoutIntentId,
  adoptCheckoutIntent,
} = require("../../src/lib/cart");

before(() => {
  db.create();
});

after(async () => {
  await pool.end();
  db.drop();
});

beforeEach(() => {
  sentEmails.length = 0;
  intents.clear();
});

let seq = 0;
const paidIntent = (orderId) => ({
  id: 0,
  metadata: { orderId },
  order: { id: 9000 + orderId, payments: [{ state: "Authorized" }] },
});

async function makeOrder({ status = "expired", intentId, ageDays = 0, copies = 1 } = {}) {
  seq++;
  const id = intentId === undefined ? `late-intent-${seq}` : intentId;
  const { rows } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, total_amount, status, checkout_intent_id, created_at)
     VALUES ('Late Buyer', $1, $2, $3, $4, now() - ($5 || ' days')::interval) RETURNING *`,
    [`late-${seq}@example.test`, 5 * copies, status, id, String(ageDays)]
  );
  const order = rows[0];
  const { rows: bookRows } = await pool.query(
    "INSERT INTO books (title, authors) VALUES ($1, 'Test Author') RETURNING id",
    [`Late Book ${seq}`]
  );
  const copyIds = [];
  for (let i = 0; i < copies; i++) {
    // Released copies, exactly as releaseCartHold leaves them: in stock,
    // no cart_order_id — only order_items still ties them to the order.
    const { rows: c } = await pool.query(
      "INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 5.00) RETURNING id",
      [bookRows[0].id]
    );
    copyIds.push(c[0].id);
    await pool.query(
      "INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, $3, 5.00)",
      [order.id, c[0].id, `Late Book ${seq}`]
    );
  }
  if (id) intents.set(id, paidIntent(order.id));
  return { order, copyIds };
}

const orderRow = async (id) => (await pool.query("SELECT * FROM orders WHERE id = $1", [id])).rows[0];
const copyStatuses = async (ids) =>
  (await pool.query("SELECT status FROM book_copies WHERE id = ANY($1::int[]) ORDER BY id", [ids])).rows.map((r) => r.status);

test("late payment on an expired order with copies still in stock: order paid, copies sold, buyer emailed", async () => {
  const { order, copyIds } = await makeOrder({ status: "expired", copies: 2 });

  const result = await reconcileOrder(pool, order);

  assert.equal(result, "paid");
  const after = await orderRow(order.id);
  assert.equal(after.status, "paid");
  assert.ok(after.paid_at);
  assert.deepEqual(await copyStatuses(copyIds), ["sold", "sold"]);
  assert.equal(sentEmails.length, 1);
  assert.equal(sentEmails[0].to, order.buyer_email);
});

test("late payment on a cancelled order is recovered too", async () => {
  const { order, copyIds } = await makeOrder({ status: "cancelled" });
  assert.equal(await reconcileOrder(pool, order), "paid");
  assert.deepEqual(await copyStatuses(copyIds), ["sold"]);
});

test("late payment with one copy already resold: nothing partially applied, admin alerted once", async () => {
  const { order, copyIds } = await makeOrder({ status: "expired", copies: 2 });
  await pool.query("UPDATE book_copies SET status = 'sold' WHERE id = $1", [copyIds[1]]);

  const result = await reconcileOrder(pool, order);

  assert.equal(result, "expired");
  assert.equal((await orderRow(order.id)).status, "expired");
  // The still-available copy must NOT have been claimed.
  assert.deepEqual(await copyStatuses(copyIds), ["in_stock", "sold"]);
  const alerts = sentEmails.filter((m) => /could not be fulfilled/.test(m.subject));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].text, new RegExp(`Order ${order.id} `));
  assert.match(alerts[0].text, new RegExp(order.buyer_email));
  assert.match(alerts[0].text, /€10\.00/);
  assert.equal(sentEmails.filter((m) => m.to === order.buyer_email).length, 0);

  // A second pass (webhook retry / sweep) must not alert again.
  await reconcileOrder(pool, await orderRow(order.id));
  assert.equal(sentEmails.filter((m) => /could not be fulfilled/.test(m.subject)).length, 1);
});

test("a closed order older than 7 days is not reconsidered; an unpaid recent one is left alone", async () => {
  const { order: old, copyIds } = await makeOrder({ status: "expired", ageDays: 8 });
  assert.equal(await reconcileOrder(pool, old), "expired");
  assert.deepEqual(await copyStatuses(copyIds), ["in_stock"]);

  const { order: unpaid } = await makeOrder({ status: "expired" });
  intents.set(unpaid.checkout_intent_id, { id: 1, metadata: { orderId: unpaid.id }, order: { id: 1, payments: [{ state: "Pending" }] } });
  assert.equal(await reconcileOrder(pool, unpaid), "expired");
  assert.equal((await orderRow(unpaid.id)).status, "expired");
});

test("sweep picks up recently expired orders but not ones older than 7 days", async () => {
  const recent = await makeOrder({ status: "expired", ageDays: 2 });
  const stale = await makeOrder({ status: "expired", ageDays: 8 });

  await reconcilePendingOrders(pool);

  assert.equal((await orderRow(recent.order.id)).status, "paid");
  assert.equal((await orderRow(stale.order.id)).status, "expired");
  assert.deepEqual(await copyStatuses(stale.copyIds), ["in_stock"]);
});

test("sweep with includeClosed:false leaves expired orders alone", async () => {
  const recent = await makeOrder({ status: "expired", ageDays: 1 });
  await reconcilePendingOrders(pool, { includeClosed: false });
  assert.equal((await orderRow(recent.order.id)).status, "expired");
});

test("persistCheckoutIntentId retries once after a transient failure and does not alert", async () => {
  let calls = 0;
  const flaky = {
    query: async () => {
      calls++;
      if (calls === 1) throw new Error("connection blip");
      return { rowCount: 1 };
    },
  };
  assert.equal(await persistCheckoutIntentId(flaky, 42, "intent-777", { retryDelayMs: 1 }), true);
  assert.equal(calls, 2);
  assert.equal(sentEmails.length, 0);
});

test("persistCheckoutIntentId alerts with both ids when the retry fails too, and never throws", async () => {
  let calls = 0;
  const down = {
    query: async () => {
      calls++;
      throw new Error("db down");
    },
  };
  assert.equal(await persistCheckoutIntentId(down, 4242, "intent-8888", { retryDelayMs: 1 }), false);
  assert.equal(calls, 2);
  assert.equal(sentEmails.length, 1);
  assert.match(sentEmails[0].subject, /4242/);
  assert.match(sentEmails[0].text, /intent-8888/);
  assert.match(sentEmails[0].text, /4242/);
});

test("adoptCheckoutIntent saves the intent id only when HelloAsso says it belongs to the order", async () => {
  const { order } = await makeOrder({ status: "pending", intentId: null });
  intents.set("good-intent", { id: "good-intent", metadata: { orderId: order.id }, order: { payments: [] } });
  intents.set("someone-elses", { id: "someone-elses", metadata: { orderId: order.id + 1000 }, order: { payments: [] } });

  assert.equal((await adoptCheckoutIntent(pool, order, "someone-elses")).checkout_intent_id, null);
  assert.equal((await orderRow(order.id)).checkout_intent_id, null);

  const adopted = await adoptCheckoutIntent(pool, order, "good-intent");
  assert.equal(adopted.checkout_intent_id, "good-intent");
  assert.equal((await orderRow(order.id)).checkout_intent_id, "good-intent");
});
