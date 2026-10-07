// The public write endpoints — cart reserve, event signup — used to have no
// rate limit and no email validation. A script could hold every copy via the
// cart's reserve step. (The public book-reserve route that used to be
// here is gone; see securityQuickFixes.test.js.) See src/lib/validation.js and
// src/middleware/rateLimits.js. One app instance shared by every test
// here, so the per-IP limiters' budgets are spent in order — the
// rate-limit assertions come last within each endpoint's group.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken, waitForCartCount } = require("../helpers/httpClient");
const { createAccount, loginOverHttp } = require("../helpers/accounts");

const PORT = 3418; // distinct from 3411-3417

let app;
let pool;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});

after(async () => {
  await pool.end();
  app.stop();
});

async function post(jar, path, fields) {
  const token = await fetchCsrfToken(app.base, jar);
  const body = new URLSearchParams({ ...fields, _csrf: token }).toString();
  const res = await fetch(`${app.base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body,
  });
  jar.capture(res);
  return res;
}

async function newCopy(status = "in_stock") {
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ('Abuse Book', 'A') RETURNING id");
  const { rows: c } = await pool.query(
    "INSERT INTO book_copies (book_id, status, price) VALUES ($1, $2, 5.00) RETURNING id, book_id", [b[0].id, status]
  );
  return c[0];
}

async function copyStatus(id) {
  const { rows } = await pool.query("SELECT status FROM book_copies WHERE id = $1", [id]);
  return rows[0].status;
}

test("a cart can't grow past 20 lines", async () => {
  const jar = makeCookieJar();
  for (let i = 0; i < 22; i++) {
    const c = await newCopy();
    await post(jar, "/cart/add", { copyId: c.id, backTo: "/cart" });
    // The next add reads the session back: let this write land first.
    await waitForCartCount(app.base, jar, Math.min(i + 1, 20));
  }
  const res = await fetch(`${app.base}/api/cart/count`, { headers: { cookie: jar.header() } });
  assert.equal((await res.json()).count, 20);
});

test("reserve ignores a posted (even multi-recipient) email: a reservation only ever carries the logged-in account's own address; a guest creates nothing; rate limited", async () => {
  const jar = makeCookieJar();
  const c = await newCopy();
  await post(jar, "/cart/add", { copyId: c.id, backTo: "/cart" });
  await waitForCartCount(app.base, jar, 1);
  const before = (await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n;

  // Logged out: redirected to log in, nothing created, nothing held.
  const guest = await post(jar, "/cart/reserve", { name: "Buyer", email: "a@x.com, b@y.com", acceptCgv: "on" });
  assert.equal(guest.status, 302);
  assert.equal(guest.headers.get("location"), "/login?returnTo=%2Fcart");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n, before);
  assert.equal(await copyStatus(c.id), "in_stock");

  // Logged in: the posted email is ignored; the reservation is under the account's own address.
  const account = await createAccount(pool, { email: `abuse-${Date.now()}@example.test`, displayName: "Abuse Buyer" });
  assert.equal((await loginOverHttp(app.base, jar, account)).status, 302);
  const res = await post(jar, "/cart/reserve", { name: "Buyer", email: "a@x.com, b@y.com", acceptCgv: "on" });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /^\/cart\/return\?order=/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders WHERE buyer_email LIKE '%a@x.com%' OR buyer_email LIKE '%b@y.com%'")).rows[0].n, 0);
  const { rows: mine } = await pool.query("SELECT buyer_email, status FROM orders WHERE user_id = $1", [account.id]);
  assert.deepEqual(mine, [{ buyer_email: account.email, status: "reserved" }]);
  assert.equal(await copyStatus(c.id), "reserved");

  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await post(makeCookieJar(), "/cart/reserve", { name: "Bot", email: "bot@example.test" })).status);
  assert.ok(statuses.includes(429), `expected a 429 within 12 reservations, got ${statuses}`);
});

test("event signup rejects an invalid email, accepts a valid one, and is rate limited", async () => {
  const { rows } = await pool.query("INSERT INTO events (title, starts_at) VALUES ('Abuse Night', now() + interval '2 days') RETURNING id");
  const id = rows[0].id;
  const count = async () => (await pool.query("SELECT count(*)::int AS n FROM event_signups WHERE event_id = $1", [id])).rows[0].n;

  await post(makeCookieJar(), `/events/${id}/signup`, { name: "Mallory", email: "not an email" });
  assert.equal(await count(), 0);
  await post(makeCookieJar(), `/events/${id}/signup`, { name: "Real Guest", email: "guest@example.test" });
  assert.equal(await count(), 1);

  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await post(makeCookieJar(), `/events/${id}/signup`, { name: "Bot", email: `bot${i}@example.test` })).status);
  assert.ok(statuses.includes(429), `expected a 429 within 12 signups, got ${statuses}`);
});
