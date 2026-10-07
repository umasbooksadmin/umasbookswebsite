// Fixed-price rule for NEW books (loi Lang, n° 81-766): a copy whose condition
// is "new" needs a publisher price and must be priced between 95% and 100% of
// it. Used copies are free-priced and store no publisher price. Covers both the
// add-book route and the copy-edit route.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken, followSeeOther } = require("../helpers/httpClient");

const PORT = 3670;
const PASSWORD = "FixedPrice-Test-1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app;
let pool;
let jar;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const email = `admin-${Date.now()}@example.test`;
  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, is_member) VALUES ($1, $2, 'FP Admin', true, true)`,
    [email, await bcrypt.hash(PASSWORD, 10)]
  );
  jar = makeCookieJar();
  const res = await post("/login", { email, password: PASSWORD });
  assert.equal(res.status, 302);
});

after(async () => {
  await pool.end();
  app.stop();
});

async function post(path, fields) {
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { ...FORM, cookie: jar.header(), "x-forwarded-for": "10.67.0.1" },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });
  jar.capture(res);
  return followSeeOther(res, { base: app.base, jar, headers: { "x-forwarded-for": "10.67.0.1" } });
}

let n = 0;
// Description + cover are supplied so the route makes no outbound lookups.
async function addBook(fields) {
  const title = `Fixed Price Book ${Date.now()}-${++n}`;
  const res = await post("/admin/inventory", {
    title, description: "d", descriptionFr: "d", coverUrl: "https://example.test/c.jpg", status: "in_stock", ...fields,
  });
  return { res, title, text: res.status === 200 ? await res.text() : "" };
}

async function copiesOf(title) {
  const { rows } = await pool.query(
    `SELECT c.* FROM book_copies c JOIN books b ON b.id = c.book_id WHERE b.title = $1`, [title]
  );
  return rows;
}

test("new copy without a publisher price is refused and nothing is saved", async () => {
  const { res, title, text } = await addBook({ condition: "new", price: "10" });
  assert.equal(res.status, 200);
  assert.match(text, /publisher(&#39;|')s price/i);
  const { rows } = await pool.query("SELECT 1 FROM books WHERE title = $1", [title]);
  assert.equal(rows.length, 0);
});

test("new copy priced below 95% or above 100% of the publisher price is refused", async () => {
  for (const price of ["9.49", "10.01", "5"]) {
    const { res, title } = await addBook({ condition: "new", publisherPrice: "10", price });
    assert.equal(res.status, 200, `price ${price} should be refused`);
    assert.equal((await copiesOf(title)).length, 0);
  }
});

test("new copy at 100% and at 95% is accepted; blank price defaults to publisher price", async () => {
  for (const [price, expected] of [["10", 10], ["9.50", 9.5], ["", 10]]) {
    const { res, title } = await addBook({ condition: "new", publisherPrice: "10", price });
    assert.equal(res.status, 302, `price '${price}' should be accepted`);
    const copies = await copiesOf(title);
    assert.equal(copies.length, 1);
    assert.equal(Number(copies[0].price), expected);
    assert.equal(Number(copies[0].publisher_price), 10);
  }
});

test("used copy is unaffected and stores no publisher price", async () => {
  const { res, title } = await addBook({ condition: "very_good", price: "3", publisherPrice: "20" });
  assert.equal(res.status, 302);
  const copies = await copiesOf(title);
  assert.equal(Number(copies[0].price), 3);
  assert.equal(copies[0].publisher_price, null);
});

test("editing a copy enforces the same rule", async () => {
  const { title } = await addBook({ condition: "very_good", price: "3" });
  const [copy] = await copiesOf(title);
  const url = `/admin/inventory/${copy.book_id}/copies/${copy.id}`;
  const base = { status: "in_stock", price: "3" };

  let res = await post(url, { ...base, condition: "new" });
  assert.equal(res.status, 200);
  res = await post(url, { ...base, condition: "new", publisherPrice: "10", price: "9" });
  assert.equal(res.status, 200);
  let [row] = await copiesOf(title);
  assert.equal(row.condition, "very_good");
  assert.equal(row.publisher_price, null);

  res = await post(url, { ...base, condition: "new", publisherPrice: "10", price: "9.5" });
  assert.equal(res.status, 302);
  [row] = await copiesOf(title);
  assert.equal(row.condition, "new");
  assert.equal(Number(row.price), 9.5);
  assert.equal(Number(row.publisher_price), 10);

  res = await post(url, { ...base, condition: "acceptable", price: "2" });
  assert.equal(res.status, 302);
  [row] = await copiesOf(title);
  assert.equal(row.publisher_price, null);
});
