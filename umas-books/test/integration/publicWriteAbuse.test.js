// The public (no-login) write endpoints — cart/checkout, event signup —
// used to have no rate limit and no email validation. A script could lock
// every copy via checkout. (The public book-reserve route that used to be
// here is gone; see securityQuickFixes.test.js.) See src/lib/validation.js and
// src/middleware/rateLimits.js. One app instance shared by every test
// here, so the per-IP limiters' budgets are spent in order — the
// rate-limit assertions come last within each endpoint's group.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3418; // distinct from 3411-3417

let app;
let pool;

before(async () => {
  app = await startTestApp({ port: PORT });
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
  }
  const res = await fetch(`${app.base}/api/cart/count`, { headers: { cookie: jar.header() } });
  assert.equal((await res.json()).count, 20);
});

test("checkout rejects an invalid email without creating an order, and is rate limited", async () => {
  const jar = makeCookieJar();
  const c = await newCopy();
  await post(jar, "/cart/add", { copyId: c.id, backTo: "/cart" });
  const before = (await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n;
  const res = await post(jar, "/cart/checkout", { name: "Buyer", email: "a@x.com, b@y.com" });
  assert.equal(res.status, 200); // re-renders the cart with an error
  assert.ok((await res.text()).includes("valid email"));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n, before);
  assert.equal(await copyStatus(c.id), "in_stock");

  const statuses = [];
  for (let i = 0; i < 12; i++) statuses.push((await post(makeCookieJar(), "/cart/checkout", { name: "Bot", email: "bot@example.test" })).status);
  assert.ok(statuses.includes(429), `expected a 429 within 12 checkouts, got ${statuses}`);
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
