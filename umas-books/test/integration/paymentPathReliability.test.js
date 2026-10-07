// Reliability of the reservation path and of the leftover cleanup
// (src/lib/cart.js, src/routes/cart.js). Nothing is paid online any more, so
// there is no payment to lose: what must hold is
//  1. a reservation is never lost to a mail outage: it stays 'reserved' and its
//     confirmation stays in the outbox for the worker to retry;
//  2. one leftover (old online checkout) order whose hold release throws does not
//     stop the others being released, and the admin is alerted once;
//  3. the periodic cart job survives a failing cleanup and never touches a fresh hold.
//
// In-process (test/helpers/inProcessApp.js). Mail and the admin alert are
// stubbed by overriding module exports BEFORE cart.js loads.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");

const db = prepareDatabase("payment_path", { isolated: true });

const mailer = require("../../src/mailer");
const sentEmails = [];
let mailDown = false;
mailer.sendMail = async (opts) => {
  if (mailDown) throw new Error("SMTP is down");
  sentEmails.push(opts);
};

const errorAlert = require("../../src/lib/errorAlert");
const alerts = []; // { label, body, opts }
errorAlert.alertOnError = async (label, body, opts) => { alerts.push({ label, body: String(body), opts: opts || {} }); };

const { pool } = require("../../src/db");
const cart = require("../../src/lib/cart");
const realRelease = cart.releaseCartHold;
const { createAccount } = require("../helpers/accounts");

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
  mailDown = false;
  cart.releaseCartHold = realRelease;
});

let seq = 0;
const uniq = () => `${Date.now()}-${++seq}-${Math.floor(Math.random() * 1e6)}`;

// A leftover of the old online checkout: a 'pending' order whose copy is 'in_cart'.
async function makeLegacyOrder({ ageMinutes = 0 } = {}) {
  const u = uniq();
  const { rows } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, total_amount, status, checkout_intent_id, created_at)
     VALUES ('Pay Buyer', $1, 6.00, 'pending', $2, now() - ($3 || ' minutes')::interval) RETURNING *`,
    [`pp-${u}@example.test`, `pp-${u}`, String(ageMinutes)]
  );
  const order = rows[0];
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'A') RETURNING id", [`PP Book ${u}`]);
  const { rows: c } = await pool.query(
    "INSERT INTO book_copies (book_id, status, price, cart_order_id, cart_added_at) VALUES ($1, 'in_cart', 6.00, $2, now() - ($3 || ' minutes')::interval) RETURNING id",
    [b[0].id, order.id, String(ageMinutes)]
  );
  await pool.query("INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, $3, 6.00)", [order.id, c[0].id, `PP Book ${u}`]);
  return { order, copyId: c[0].id };
}
const orderRow = async (id) => (await pool.query("SELECT * FROM orders WHERE id = $1", [id])).rows[0];
const copyStatus = async (id) => (await pool.query("SELECT status FROM book_copies WHERE id = $1", [id])).rows[0].status;

// --- 1. a reservation survives a mail outage -----------------------------

test("reserving while the mail server is down still reserves; the confirmation waits in the outbox", async () => {
  mailDown = true;
  const buyer = await createAccount(pool, { email: `pp-buyer-${uniq()}@example.test` });
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'A') RETURNING id", [`PP Mail Book ${uniq()}`]);
  const { rows: c } = await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 6.00) RETURNING id", [b[0].id]);
  const realError = console.error;
  console.error = () => {};
  let order;
  try {
    order = await cart.createReservation(pool, {
      user: { id: buyer.id, email: buyer.email }, name: "Pay Buyer", lang: "en", acceptedVersion: "t",
      items: [{ kind: "book", copyId: c[0].id, title: "PP Mail Book", price: 6 }],
    });
  } finally {
    console.error = realError;
  }
  assert.equal(order.status, "reserved");
  assert.equal(await copyStatus(c[0].id), "reserved");
  const { rows: outbox } = await pool.query("SELECT status, kind, attempts FROM email_outbox WHERE related_order_id = $1", [order.id]);
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].kind, "order_confirmation");
  assert.notEqual(outbox[0].status, "sent", "not sent yet: the worker retries it");
  assert.equal(sentEmails.length, 0);

  // The mail server comes back: the worker delivers the stored confirmation.
  mailDown = false;
  await pool.query("UPDATE email_outbox SET next_try_at = now() - interval '1 minute' WHERE related_order_id = $1", [order.id]);
  await require("../../src/lib/outbox").processOutbox(pool);
  assert.equal(sentEmails.filter((e) => e.to === buyer.email).length, 1);
  assert.equal((await pool.query("SELECT status FROM email_outbox WHERE related_order_id = $1", [order.id])).rows[0].status, "sent");
});

// --- 2. poison order ----------------------------------------------------

test("expireStaleCartHolds: one order whose release throws does not stop the rest; alerts once", async () => {
  const a = await makeLegacyOrder({ ageMinutes: 120 });
  const poison = await makeLegacyOrder({ ageMinutes: 120 });
  const b = await makeLegacyOrder({ ageMinutes: 120 });
  cart.releaseCartHold = async (p, id, status) => {
    if (id === poison.order.id) throw new Error("boom");
    return realRelease(p, id, status);
  };
  const realError = console.error;
  console.error = () => {};
  try {
    await cart.expireStaleCartHolds(pool);
  } finally {
    console.error = realError;
  }

  assert.equal((await orderRow(a.order.id)).status, "expired");
  assert.equal((await orderRow(b.order.id)).status, "expired");
  assert.equal(await copyStatus(a.copyId), "in_stock");
  assert.equal(await copyStatus(b.copyId), "in_stock");
  assert.equal((await orderRow(poison.order.id)).status, "pending");
  const mine = alerts.filter((x) => x.body.includes(String(poison.order.id)));
  assert.equal(mine.length, 1);
  assert.equal(alerts.length, 1, "a single alert, not one per failure");
});

// --- 3. the periodic job ------------------------------------------------

test("expireStaleCartHolds: a hold younger than an hour is left alone, an older one is released, with no HelloAsso lookup", async () => {
  const fresh = await makeLegacyOrder({ ageMinutes: 10 });
  const stale = await makeLegacyOrder({ ageMinutes: 90 });
  await cart.expireStaleCartHolds(pool);
  assert.equal((await orderRow(fresh.order.id)).status, "pending");
  assert.equal(await copyStatus(fresh.copyId), "in_cart");
  assert.equal((await orderRow(stale.order.id)).status, "expired");
  assert.equal(await copyStatus(stale.copyId), "in_stock");
});

test("runCartMaintenance does not throw when the cleanup fails, and logs it", async () => {
  const origExpire = cart.expireStaleCartHolds;
  const logged = [];
  const realErr = console.error;
  console.error = (...a) => logged.push(a.join(" "));
  cart.expireStaleCartHolds = async () => { throw new Error("expiry blew up"); };
  try {
    await cart.runCartMaintenance(pool);
  } finally {
    console.error = realErr;
    cart.expireStaleCartHolds = origExpire;
  }
  assert.ok(logged.some((l) => /Cart hold expiry failed/.test(l)));
});
