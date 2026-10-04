// Regression: markOrderPaid used to flip the order to 'paid' and then
// update inventory as separate statements. A failure in between left a
// paid order whose copies were still in_cart — never retried (no longer
// pending) and then put back on sale by the hold-expiry sweep. These
// tests use a real database with failure injected mid-way.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { prepareDatabase } = require("../helpers/testDatabase");

// Own database even on the shared CI one (see helpers/testDatabase.js).
const db = prepareDatabase("atomicity", { isolated: true });

const mailer = require("../../src/mailer");
const sentEmails = [];
mailer.sendMail = async (opts) => { sentEmails.push(opts); };

const { pool } = require("../../src/db");
const { markOrderPaid, releaseCartHold } = require("../../src/lib/cart");

before(() => {
  db.create();
});

after(async () => {
  await pool.end();
  db.drop();
});

async function insertOrderWithCopy(status) {
  const { rows: o } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, total_amount, status, checkout_intent_id)
     VALUES ('Atomic Buyer', 'atomicity@example.test', 5.00, $1, $2) RETURNING *`,
    [status, `intent-${Date.now()}-${Math.random()}`]
  );
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ('Atomic Book', 'A') RETURNING id");
  const { rows: c } = await pool.query(
    `INSERT INTO book_copies (book_id, status, cart_order_id, cart_added_at, price)
     VALUES ($1, 'in_cart', $2, now(), 5.00) RETURNING id`,
    [b[0].id, o[0].id]
  );
  return { order: o[0], copyId: c[0].id };
}

// A pool whose statements touching the drop-in seat table throw, on
// either the pool.query path or a checked-out client — i.e. the process
// "dying" after the order/copies statements but before the last one.
function failingPool() {
  const guard = (target) => ({
    query: (sql, ...rest) => {
      if (typeof sql === "string" && sql.includes("UPDATE class_dropin_seats")) {
        return Promise.reject(new Error("injected failure"));
      }
      return target.query(sql, ...rest);
    },
  });
  return {
    query: guard(pool).query,
    connect: async () => {
      const client = await pool.connect();
      const g = guard(client);
      return { query: g.query, release: (e) => client.release(e), on: (...a) => client.on(...a), removeListener: (...a) => client.removeListener(...a) };
    },
  };
}

test("a failure partway through markOrderPaid leaves the order pending and the copy held", async () => {
  sentEmails.length = 0;
  const { order, copyId } = await insertOrderWithCopy("pending");
  await assert.rejects(markOrderPaid(failingPool(), order), /injected failure/);

  const { rows: o } = await pool.query("SELECT status FROM orders WHERE id = $1", [order.id]);
  assert.equal(o[0].status, "pending", "order must not read 'paid' if its inventory update didn't happen");
  const { rows: c } = await pool.query("SELECT status FROM book_copies WHERE id = $1", [copyId]);
  assert.equal(c[0].status, "in_cart");
  assert.equal(sentEmails.length, 0);

  await markOrderPaid(pool, order); // a later retry completes normally
  const { rows: c2 } = await pool.query("SELECT status FROM book_copies WHERE id = $1", [copyId]);
  assert.equal(c2[0].status, "sold");
});

test("releaseCartHold never puts a paid order's copy back on sale", async () => {
  // State an interrupted markOrderPaid used to leave behind.
  const { order, copyId } = await insertOrderWithCopy("paid");
  await releaseCartHold(pool, order.id, "expired");

  const { rows: c } = await pool.query("SELECT status FROM book_copies WHERE id = $1", [copyId]);
  assert.equal(c[0].status, "sold", "a paid order's copy must end up sold, not back in stock");
  const { rows: o } = await pool.query("SELECT status FROM orders WHERE id = $1", [order.id]);
  assert.equal(o[0].status, "paid");
});

test("an expired, unpaid hold is still released", async () => {
  const { order, copyId } = await insertOrderWithCopy("pending");
  await releaseCartHold(pool, order.id, "expired");
  const { rows: c } = await pool.query("SELECT status FROM book_copies WHERE id = $1", [copyId]);
  assert.equal(c[0].status, "in_stock");
  const { rows: o } = await pool.query("SELECT status FROM orders WHERE id = $1", [order.id]);
  assert.equal(o[0].status, "expired");
});
