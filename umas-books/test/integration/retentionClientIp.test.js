// orders.client_ip exists only for the checkout hold caps: it is cleared when
// an order leaves 'pending', by the daily purge after 2 days, and on erasure.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");

const PORT = 3751;
let app, pool, privacy, cartLib, mailer;

before(async () => {
  app = await startTestApp({ port: PORT });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
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
  const fresh = await makeOrder({ ageDays: 0 });
  const counts = await privacy.purgeExpiredPersonalData(pool);
  assert.notEqual(counts.clientIps, "error");
  assert.equal(await ipOf(old.id), null);
  assert.equal(await ipOf(fresh.id), "203.0.113.9");
});

test("an order that expires or is cancelled loses its client_ip at once", async () => {
  const a = await makeOrder();
  await cartLib.releaseCartHold(pool, a.id, "expired");
  assert.equal(await ipOf(a.id), null);
  const b = await makeOrder();
  await cartLib.releaseCartHold(pool, b.id, "cancelled");
  assert.equal(await ipOf(b.id), null);
});

test("an order that is paid loses its client_ip at once", async () => {
  const o = await makeOrder();
  assert.equal(await cartLib.markOrderPaid(pool, o), true);
  assert.equal(await ipOf(o.id), null);
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
