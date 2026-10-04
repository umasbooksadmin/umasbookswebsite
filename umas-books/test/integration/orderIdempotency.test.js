// Verifies the idempotency guard in markOrderPaid (src/lib/cart.js): two
// overlapping calls for the same order — the realistic shape of a live
// webhook delivery racing the periodic reconcilePendingOrders sweep
// (index.js), or HelloAsso retrying a webhook it didn't get a fast
// enough 200 for — must not double-apply the paid transition (which
// would mean a second order-confirmation email, among other things).
//
// Uses its own throwaway database (same pattern as app.test.js) so it
// can insert a "pending order with a locked-for-checkout book copy" row
// directly, without going through a full checkout flow.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { prepareDatabase } = require("../helpers/testDatabase");

// Own database even on the shared CI one (see helpers/testDatabase.js).
const db = prepareDatabase("idempotency", { isolated: true });

// Intercepted before requiring cart.js, which destructures sendMail off
// this same exports object at require time — mutating the property here
// (rather than after cart.js has already captured the original
// reference) is what makes the mock actually take effect there.
const mailer = require("../../src/mailer");
const sentEmails = [];
mailer.sendMail = async (opts) => {
  sentEmails.push(opts);
};

const { pool } = require("../../src/db");
const { markOrderPaid } = require("../../src/lib/cart");

before(() => {
  db.create();
});

after(async () => {
  await pool.end();
  db.drop();
});

async function insertPendingOrder(intentId) {
  const { rows } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, total_amount, status, checkout_intent_id)
     VALUES ('Test Buyer', 'idempotency-test@example.test', 5.00, 'pending', $1)
     RETURNING *`,
    [intentId]
  );
  return rows[0];
}

async function insertBookCopyInCart(orderId) {
  const { rows: bookRows } = await pool.query(
    `INSERT INTO books (title, authors) VALUES ('Idempotency Test Book', 'Test Author') RETURNING id`
  );
  const { rows: copyRows } = await pool.query(
    `INSERT INTO book_copies (book_id, status, cart_order_id, cart_added_at, price)
     VALUES ($1, 'in_cart', $2, now(), 5.00) RETURNING *`,
    [bookRows[0].id, orderId]
  );
  return copyRows[0];
}

test("a second call with the same stale order object sends no second email", async () => {
  sentEmails.length = 0;
  const order = await insertPendingOrder("fake-intent-sequential");
  const copy = await insertBookCopyInCart(order.id);

  // `order` here still has status: "pending", exactly as if two callers
  // had both fetched it before either one wrote — the actual race shape,
  // since neither reconcileOrder nor the webhook route re-fetches the
  // row between reading its status and calling markOrderPaid.
  await markOrderPaid(pool, order);
  const { rows: afterFirst } = await pool.query("SELECT status, paid_at FROM orders WHERE id = $1", [order.id]);
  assert.equal(afterFirst[0].status, "paid");
  assert.equal(sentEmails.length, 1);

  await markOrderPaid(pool, order);
  const { rows: afterSecond } = await pool.query("SELECT status, paid_at FROM orders WHERE id = $1", [order.id]);

  // If the second call had re-run the UPDATE, paid_at would have moved
  // forward to a new now() instead of staying exactly what it was — and
  // a second email would have gone out.
  assert.equal(afterSecond[0].paid_at.getTime(), afterFirst[0].paid_at.getTime());
  assert.equal(sentEmails.length, 1);

  const { rows: copyRows } = await pool.query("SELECT status FROM book_copies WHERE id = $1", [copy.id]);
  assert.equal(copyRows[0].status, "sold");
});

test("two truly concurrent calls for the same order send exactly one email", async () => {
  sentEmails.length = 0;
  const order = await insertPendingOrder("fake-intent-concurrent");
  const copy = await insertBookCopyInCart(order.id);

  await Promise.all([markOrderPaid(pool, order), markOrderPaid(pool, order)]);

  const { rows: orderRows } = await pool.query("SELECT status FROM orders WHERE id = $1", [order.id]);
  assert.equal(orderRows[0].status, "paid");
  assert.equal(sentEmails.length, 1);

  const { rows: copyRows } = await pool.query("SELECT status, cart_order_id FROM book_copies WHERE id = $1", [copy.id]);
  assert.equal(copyRows[0].status, "sold");
  assert.equal(copyRows[0].cart_order_id, null);
});
