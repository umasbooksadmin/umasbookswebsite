// Regression: /account listed every order whose buyer_email matched the
// logged-in user's email, but signup logs a new account in immediately
// without verifying the address — so anyone could register a victim's
// email and read their order history (dates, items, prices, status).
// Orders now show only once email_verified_at is set.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3419; // distinct from 3411-3418
const PASSWORD = "Account-Orders-1!";

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

async function loginAndFetchAccount(email) {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const loginRes = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(PASSWORD)}&_csrf=${token}`,
  });
  jar.capture(loginRes);
  assert.equal(loginRes.status, 302);
  const res = await fetch(`${app.base}/account`, { headers: { cookie: jar.header() } });
  assert.equal(res.status, 200);
  return res.text();
}

async function makeUserWithOrder(tag, verified) {
  const email = `acct-${tag}-${Date.now()}@example.test`;
  await pool.query(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, $2, 'Acct', $3)",
    [email, await bcrypt.hash(PASSWORD, 12), verified ? new Date() : null]
  );
  const { rows } = await pool.query(
    "INSERT INTO orders (buyer_name, buyer_email, total_amount, status) VALUES ('Victim', $1, 7.50, 'paid') RETURNING id",
    [email]
  );
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'A') RETURNING id", [`Secret Title ${tag}`]);
  const { rows: c } = await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'sold', 7.50) RETURNING id", [b[0].id]);
  await pool.query(
    "INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, $3, 7.50)",
    [rows[0].id, c[0].id, `Secret Title ${tag}`]
  );
  return email;
}

test("an unverified account does not see orders placed under its email", async () => {
  const email = await makeUserWithOrder("unverified", false);
  const html = await loginAndFetchAccount(email);
  assert.ok(!html.includes("Secret Title unverified"), "order contents must not be shown before the email is verified");
  assert.ok(html.includes("Confirm your email address"));
});

test("a verified account still sees its orders", async () => {
  const email = await makeUserWithOrder("verified", true);
  const html = await loginAndFetchAccount(email);
  assert.ok(html.includes("Secret Title verified"));
  assert.ok(!html.includes("Confirm your email address"));
});
