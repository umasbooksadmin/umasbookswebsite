// Regression: releaseCartHold DELETEd a drop-in order's class_dropin_seats
// rows, but order_items.class_dropin_seat_id references them with no
// ON DELETE action (migrations/015) and checkout always creates that
// order item — so releasing any order holding a seat threw a foreign-key
// error, rolling back the whole release: the order stayed pending, its
// books stayed held, and the seat kept counting against the session's
// capacity. Also, expireStaleCartHolds only discovered orders through
// book_copies, so a drop-in-only abandoned checkout was never expired.
// Seats are now marked 'released' (kept, uncounted) instead of deleted.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const OWNS_DATABASE = !process.env.DATABASE_URL;
const TEST_DB = `umasbooks_seatrelease_test_${Date.now()}`;
process.env.DATABASE_URL = process.env.DATABASE_URL || `postgres://localhost:5432/${TEST_DB}`;
process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";

const mailer = require("../../src/mailer");
const sentEmails = [];
mailer.sendMail = async (opts) => { sentEmails.push(opts); };

const { pool } = require("../../src/db");
const { releaseCartHold, expireStaleCartHolds, reconcileOrder } = require("../../src/lib/cart");
const { seatsTakenExpr } = require("../../src/lib/classCapacity");

before(() => {
  if (OWNS_DATABASE) execFileSync("createdb", [TEST_DB], { stdio: "inherit" });
  execFileSync("node", ["src/migrate.js"], { cwd: ROOT, env: process.env, stdio: "inherit" });
});

after(async () => {
  await pool.end();
  if (OWNS_DATABASE) execFileSync("dropdb", ["--if-exists", TEST_DB], { stdio: "inherit" });
});

// An order exactly as checkout builds it: a seat row plus the order_items
// row pointing at it, optionally with a book copy held too.
async function insertDropinOrder({ withBook = false, ageMinutes = 0 } = {}) {
  const { rows: o } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, total_amount, status, checkout_intent_id)
     VALUES ('Seat Buyer', 'seats@example.test', 20.00, 'pending', $1) RETURNING *`,
    [`intent-${Date.now()}-${Math.random()}`]
  );
  const order = o[0];
  const { rows: c } = await pool.query(
    "INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ('Drop-in', now() + interval '2 days', 3, 20.00) RETURNING id"
  );
  const classId = c[0].id;
  const { rows: s } = await pool.query(
    `INSERT INTO class_dropin_seats (class_id, status, order_id, cart_added_at)
     VALUES ($1, 'in_cart', $2, now() - make_interval(mins => $3)) RETURNING id`,
    [classId, order.id, ageMinutes]
  );
  await pool.query(
    "INSERT INTO order_items (order_id, class_dropin_seat_id, item_title, price) VALUES ($1, $2, 'Drop-in seat', 20.00)",
    [order.id, s[0].id]
  );
  let copyId = null;
  if (withBook) {
    const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ('Seat Book', 'A') RETURNING id");
    const { rows: copy } = await pool.query(
      `INSERT INTO book_copies (book_id, status, cart_order_id, cart_added_at, price)
       VALUES ($1, 'in_cart', $2, now() - make_interval(mins => $3), 5.00) RETURNING id`,
      [b[0].id, order.id, ageMinutes]
    );
    copyId = copy[0].id;
    await pool.query(
      "INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, 'Seat Book', 5.00)",
      [order.id, copyId]
    );
  }
  return { order, classId, seatId: s[0].id, copyId };
}

const seatsTaken = async (classId) =>
  (await pool.query(`SELECT ${seatsTakenExpr("classes")}::int AS n FROM classes WHERE id = $1`, [classId])).rows[0].n;

test("releasing an order that holds a drop-in seat and a book works and frees both", async () => {
  const { order, classId, seatId, copyId } = await insertDropinOrder({ withBook: true });
  assert.equal(await seatsTaken(classId), 1);

  await releaseCartHold(pool, order.id, "expired");

  const { rows: o } = await pool.query("SELECT status FROM orders WHERE id = $1", [order.id]);
  assert.equal(o[0].status, "expired");
  const { rows: c } = await pool.query("SELECT status, cart_order_id FROM book_copies WHERE id = $1", [copyId]);
  assert.equal(c[0].status, "in_stock", "the book must be released too, not stuck behind the seat failure");
  assert.equal(c[0].cart_order_id, null);
  const { rows: s } = await pool.query("SELECT status FROM class_dropin_seats WHERE id = $1", [seatId]);
  assert.equal(s[0].status, "released", "the seat row is kept (order_items references it), just marked released");
  assert.equal(await seatsTaken(classId), 0, "a released seat must stop counting against the session's capacity");
  const { rows: items } = await pool.query("SELECT 1 FROM order_items WHERE order_id = $1", [order.id]);
  assert.equal(items.length, 2, "the expired order keeps its line items");
});

test("a stale drop-in-only order is found and expired by the sweep", async () => {
  const { order, classId } = await insertDropinOrder({ ageMinutes: 120 });
  await expireStaleCartHolds(pool);
  const { rows: o } = await pool.query("SELECT status FROM orders WHERE id = $1", [order.id]);
  assert.equal(o[0].status, "expired");
  assert.equal(await seatsTaken(classId), 0);
});

test("a fresh drop-in hold is left alone by the sweep", async () => {
  const { order, classId } = await insertDropinOrder({ ageMinutes: 5 });
  await expireStaleCartHolds(pool);
  const { rows: o } = await pool.query("SELECT status FROM orders WHERE id = $1", [order.id]);
  assert.equal(o[0].status, "pending");
  assert.equal(await seatsTaken(classId), 1);
});

test("a late payment for a released seat is a conflict, not a silent oversell", async () => {
  const { order, seatId } = await insertDropinOrder();
  await releaseCartHold(pool, order.id, "expired");
  const closed = (await pool.query("SELECT * FROM orders WHERE id = $1", [order.id])).rows[0];

  // reconcileOrder asks HelloAsso; stub the lookup to say "paid".
  const helloasso = require("../../src/lib/helloasso");
  const original = helloasso.getCheckoutIntent;
  helloasso.getCheckoutIntent = async () => ({ order: { id: 987654, payments: [{ state: "Authorized" }] } });
  sentEmails.length = 0;
  try {
    await reconcileOrder(pool, closed);
  } finally {
    helloasso.getCheckoutIntent = original;
  }

  const { rows: o } = await pool.query("SELECT status FROM orders WHERE id = $1", [order.id]);
  assert.equal(o[0].status, "expired", "nothing is applied when the seat can't be re-claimed");
  const { rows: s } = await pool.query("SELECT status FROM class_dropin_seats WHERE id = $1", [seatId]);
  assert.equal(s[0].status, "released");
});
