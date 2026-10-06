// A reservation is atomic (src/lib/cart.js createReservation): the order, its
// items, the held books, the held drop-in seats and the queued confirmation
// e-mail are committed together, or rolled back together. Failure is injected
// mid-way against a real database. And a leftover old-style hold that was
// somehow paid is never put back on sale by the cleanup.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { prepareDatabase } = require("../helpers/testDatabase");

// Own database even on the shared CI one (see helpers/testDatabase.js).
const db = prepareDatabase("atomicity", { isolated: true });

const mailer = require("../../src/mailer");
const sentEmails = [];
mailer.sendMail = async (opts) => { sentEmails.push(opts); };

const { pool } = require("../../src/db");
const { createReservation, releaseCartHold } = require("../../src/lib/cart");

before(() => { db.create(); });
after(async () => { await pool.end(); db.drop(); });

let seq = 0;
async function makeUser() {
  const { rows } = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, 'x', 'Atomic Buyer', now()) RETURNING id, email",
    [`atomic-${Date.now()}-${++seq}@example.test`]
  );
  return rows[0];
}
async function makeCopy(price = 5) {
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'A') RETURNING id", [`Atomic Book ${++seq}`]);
  const { rows: c } = await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', $2) RETURNING id", [b[0].id, price]);
  return c[0].id;
}
async function makeSession() {
  const { rows } = await pool.query(
    "INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ('Atomic Drop-in', now() + interval '5 days', 4, 8) RETURNING id"
  );
  return rows[0].id;
}
const bookLine = (copyId, price = 5) => ({ kind: "book", copyId, title: `Atomic ${copyId}`, price });
const seatLine = (classId, price = 8) => ({ kind: "dropin", classId, title: "Atomic Drop-in", startsAt: new Date(Date.now() + 5 * 86400000), price });
const copyStatus = async (id) => (await pool.query("SELECT status, cart_order_id FROM book_copies WHERE id = $1", [id])).rows[0];
const ordersFor = async (userId) => (await pool.query("SELECT * FROM orders WHERE user_id = $1", [userId])).rows;
const outboxCount = async (email) => (await pool.query("SELECT count(*)::int AS n FROM email_outbox WHERE to_email = $1", [email])).rows[0].n;

// A pool whose statements matching `needle` fail (on the pool.query path and
// on any checked-out client) — the process "dying" part-way through.
// With `inDb`, the statement is replaced by one that really fails inside
// Postgres (division by zero), which also aborts the open transaction, like a
// genuine constraint or connection error would.
function failingPool(needle, { inDb = false } = {}) {
  const guard = (target) => ({
    query: (sql, ...rest) => {
      if (typeof sql === "string" && sql.includes(needle)) {
        return inDb ? target.query("SELECT 1/0") : Promise.reject(new Error("injected failure"));
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

test("a reservation commits together: order, items, held books and seats, and the queued confirmation", async () => {
  sentEmails.length = 0;
  const user = await makeUser();
  const copy = await makeCopy(6);
  const cls = await makeSession();
  const order = await createReservation(pool, { user, name: "Atomic Buyer", items: [bookLine(copy, 6), seatLine(cls)], hasDropin: true, lang: "en", acceptedVersion: "t" });

  assert.equal(order.status, "reserved");
  assert.equal(Number(order.total_amount), 14);
  assert.deepEqual(await copyStatus(copy), { status: "reserved", cart_order_id: order.id });
  const { rows: items } = await pool.query("SELECT book_copy_id, class_dropin_seat_id FROM order_items WHERE order_id = $1", [order.id]);
  assert.equal(items.length, 2);
  const { rows: seats } = await pool.query("SELECT status FROM class_dropin_seats WHERE order_id = $1", [order.id]);
  assert.deepEqual(seats.map((s) => s.status), ["reserved"]);
  const { rows: outbox } = await pool.query("SELECT kind, related_order_id FROM email_outbox WHERE to_email = $1", [user.email]);
  assert.deepEqual(outbox.map((o) => [o.kind, o.related_order_id]), [["order_confirmation", order.id]]);
});

test("a failure after the books are held (while creating the seats) rolls back EVERYTHING: no order, books back in stock, no seat, no queued e-mail", async () => {
  sentEmails.length = 0;
  const user = await makeUser();
  const copy = await makeCopy();
  const cls = await makeSession();
  await assert.rejects(
    createReservation(failingPool("INSERT INTO class_dropin_seats"), { user, name: "A", items: [bookLine(copy), seatLine(cls)], hasDropin: true, lang: "en", acceptedVersion: "t" }),
    /injected failure/
  );
  assert.deepEqual(await ordersFor(user.id), []);
  assert.deepEqual(await copyStatus(copy), { status: "in_stock", cart_order_id: null });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM class_dropin_seats WHERE class_id = $1", [cls])).rows[0].n, 0);
  assert.equal(await outboxCount(user.email), 0);
  assert.equal(sentEmails.length, 0);
});

test("a copy taken meanwhile (SOLD_OUT) rolls the whole reservation back: the other copy stays free, nothing queued", async () => {
  const user = await makeUser();
  const free = await makeCopy();
  const taken = await makeCopy();
  await pool.query("UPDATE book_copies SET status = 'sold' WHERE id = $1", [taken]);
  await assert.rejects(createReservation(pool, { user, name: "A", items: [bookLine(free), bookLine(taken)], lang: "en", acceptedVersion: "t" }), /SOLD_OUT/);
  assert.deepEqual(await ordersFor(user.id), []);
  assert.deepEqual(await copyStatus(free), { status: "in_stock", cart_order_id: null });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM order_items WHERE book_copy_id = $1", [free])).rows[0].n, 0);
  assert.equal(await outboxCount(user.email), 0);
});

test("a failure to QUEUE the confirmation does not undo the reservation (savepoint), and no half-written outbox row is left", async () => {
  const user = await makeUser();
  const copy = await makeCopy();
  const realError = console.error;
  console.error = () => {};
  let order;
  try {
    order = await createReservation(failingPool("INSERT INTO email_outbox", { inDb: true }), { user, name: "A", items: [bookLine(copy)], lang: "en", acceptedVersion: "t" });
  } finally {
    console.error = realError;
  }
  assert.equal(order.status, "reserved");
  assert.equal(order.confirmationId, null, "nothing was queued");
  assert.deepEqual(await copyStatus(copy), { status: "reserved", cart_order_id: order.id });
  assert.equal((await ordersFor(user.id)).length, 1);
  assert.equal(await outboxCount(user.email), 0);
});

test("releaseCartHold never puts a paid order's copy back on sale", async () => {
  // A leftover of the old online checkout: a 'paid' order whose copy was still 'in_cart'.
  const { rows: o } = await pool.query(
    "INSERT INTO orders (buyer_name, buyer_email, total_amount, status, checkout_intent_id) VALUES ('Atomic Buyer', 'atomicity@example.test', 5.00, 'paid', $1) RETURNING id",
    [`intent-${Date.now()}-${Math.random()}`]
  );
  const copy = await makeCopy();
  await pool.query("UPDATE book_copies SET status = 'in_cart', cart_order_id = $1, cart_added_at = now() WHERE id = $2", [o[0].id, copy]);
  await releaseCartHold(pool, o[0].id, "expired");
  assert.equal((await copyStatus(copy)).status, "sold", "a paid order's copy must end up sold, not back in stock");
  assert.equal((await pool.query("SELECT status FROM orders WHERE id = $1", [o[0].id])).rows[0].status, "paid");
});

test("an expired, unpaid leftover hold is still released", async () => {
  const { rows: o } = await pool.query(
    "INSERT INTO orders (buyer_name, buyer_email, total_amount, status, checkout_intent_id) VALUES ('Atomic Buyer', 'atomicity@example.test', 5.00, 'pending', $1) RETURNING id",
    [`intent-${Date.now()}-${Math.random()}`]
  );
  const copy = await makeCopy();
  await pool.query("UPDATE book_copies SET status = 'in_cart', cart_order_id = $1, cart_added_at = now() WHERE id = $2", [o[0].id, copy]);
  await releaseCartHold(pool, o[0].id, "expired");
  assert.deepEqual(await copyStatus(copy), { status: "in_stock", cart_order_id: null });
  assert.equal((await pool.query("SELECT status FROM orders WHERE id = $1", [o[0].id])).rows[0].status, "expired");
});
