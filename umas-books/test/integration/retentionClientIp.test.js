// orders.client_ip only ever existed for the old online-checkout hold caps. A
// RESERVATION stores no buyer IP at all (the abuse limits are per-IP rate limits
// in memory, not data on the order). What is left to protect: an old row that
// still carries one is cleared when the order leaves its open state (released,
// expired, cancelled, collected and paid), by the daily purge after 2 days, and
// on erasure.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");
const { createAccount, loginOverHttp } = require("../helpers/accounts");

const PORT = 3751;
let app, pool, privacy, cartLib, mailer;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  // The server runs a retention purge of its own at boot, in the background;
  // let it finish before this file inserts old rows it is allowed to purge.
  await app.waitForLog(/Retention purge/);
  privacy = require("../../src/lib/privacy");
  cartLib = require("../../src/lib/cart");
  mailer = require("../../src/mailer");
  mailer.sendMail = async () => {};
});

after(async () => {
  await pool.end();
  app.stop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function makeOrder({ status = "pending", ageDays = 0, email = `ip-${uniq()}@example.test` } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, total_amount, status, client_ip, created_at)
     VALUES ('Ip Test', $1, 500, $2, '203.0.113.9', now() - make_interval(days => $3::int)) RETURNING *`,
    [email, status, ageDays]
  );
  return rows[0];
}
const ipOf = async (id) => (await pool.query("SELECT client_ip FROM orders WHERE id = $1", [id])).rows[0].client_ip;

test("the purge clears client_ip on orders older than 2 days, not on fresh ones", async () => {
  const old = await makeOrder({ status: "paid", ageDays: 3 });
  const oldReserved = await makeOrder({ status: "reserved", ageDays: 3 });
  const fresh = await makeOrder({ status: "reserved", ageDays: 0 });
  const counts = await privacy.purgeExpiredPersonalData(pool);
  assert.notEqual(counts.clientIps, "error");
  assert.equal(await ipOf(old.id), null);
  assert.equal(await ipOf(oldReserved.id), null);
  assert.equal(await ipOf(fresh.id), "203.0.113.9");
});

test("a leftover old-checkout order that expires or is cancelled loses its client_ip at once", async () => {
  const a = await makeOrder();
  await cartLib.releaseCartHold(pool, a.id, "expired");
  assert.equal(await ipOf(a.id), null);
  const b = await makeOrder();
  await cartLib.releaseCartHold(pool, b.id, "cancelled");
  assert.equal(await ipOf(b.id), null);
});

test("a reservation that is cancelled, expires or is marked no-show loses any client_ip at once", async () => {
  const { releaseReservation } = require("../../src/lib/reservations");
  for (const [status, reason] of [["cancelled", "customer"], ["cancelled", "admin"], ["expired", "expired"], ["expired", "no_show"]]) {
    const o = await makeOrder({ status: "reserved" });
    assert.equal((await releaseReservation(pool, o.id, { status, reason })).outcome, "released");
    assert.equal(await ipOf(o.id), null, `${status}/${reason}`);
  }
});

test("an order collected and paid at the shop loses any client_ip at once", async () => {
  const { collectReservation } = require("../../src/lib/orderActions");
  const account = await createAccount(pool, { email: `ip-collect-${uniq()}@example.test` });
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ('Ip Book', 'A') RETURNING id");
  const { rows: c } = await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 5) RETURNING id", [b[0].id]);
  const order = await cartLib.createReservation(pool, {
    user: account, name: "Ip Collect", acceptedVersion: "v",
    items: [{ kind: "book", copyId: c[0].id, title: "Ip Book", price: 5 }],
  });
  assert.equal(await ipOf(order.id), null, "a fresh reservation never had one");
  await pool.query("UPDATE orders SET client_ip = '203.0.113.9' WHERE id = $1", [order.id]); // as an older row might
  assert.equal((await collectReservation(pool, order.id, { method: "cash" })).outcome, "collected");
  assert.equal(await ipOf(order.id), null);
});

test("a reservation made through the real site stores no client IP at all", async () => {
  const account = await createAccount(pool, { email: `ip-http-${uniq()}@example.test`, displayName: "Ip Http" });
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ('Ip Http Book', 'A') RETURNING id");
  const { rows: c } = await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 5) RETURNING id", [b[0].id]);
  const jar = makeCookieJar();
  assert.equal((await loginOverHttp(app.base, jar, account)).status, 302);
  const post = async (path, fields) => {
    const token = await fetchCsrfToken(app.base, jar);
    const res = await fetch(`${app.base}${path}`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
      body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
    });
    jar.capture(res);
    return res;
  };
  assert.equal((await post("/cart/add", { copyId: c[0].id })).status, 302);
  // The session write behind the add lands a moment later on a slow store: retry the reserve once.
  let res = await post("/cart/reserve", { name: "Ip Http", acceptCgv: "on" });
  if (res.status !== 302) res = await post("/cart/reserve", { name: "Ip Http", acceptCgv: "on" });
  assert.equal(res.status, 302, "reserved");
  const { rows } = await pool.query("SELECT id, status, client_ip FROM orders WHERE user_id = $1", [account.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "reserved");
  assert.equal(rows[0].client_ip, null);
});

test("erasing a member clears client_ip on their orders", async () => {
  const email = `ip-erase-${uniq()}@example.test`;
  const { rows } = await pool.query(
    "INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Erase Me') RETURNING id",
    [email]
  );
  const o = await makeOrder({ email });
  assert.ok(await privacy.eraseMember(pool, rows[0].id));
  assert.equal(await ipOf(o.id), null);
});
