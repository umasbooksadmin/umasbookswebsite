// "Sell in shop" (/admin/inventory/sell) is retired: it redirects to the Till and its
// old rows stay. Plus the copy "source" (donation, purchase, job lot, other): recorded
// at intake, remembered between books on the scan flow, editable on the copy.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3791;
const PASSWORD = "Shop-Sales-Test-1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app;
let pool;
let jar;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const email = `shop-admin-${Date.now()}@example.test`;
  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, is_member) VALUES ($1, $2, 'Shop Admin', true, true)`,
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

async function post(path, fields, token) {
  const csrf = token || (await fetchCsrfToken(app.base, jar));
  const res = await fetch(`${app.base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { ...FORM, cookie: jar.header(), "x-forwarded-for": "10.79.1.1" },
    body: new URLSearchParams({ ...fields, _csrf: csrf }).toString(),
  });
  jar.capture(res);
  return res;
}

async function get(path, useJar = jar) {
  const res = await fetch(`${app.base}${path}`, { redirect: "manual", headers: { cookie: useJar.header(), "x-forwarded-for": "10.79.1.1" } });
  return { res, text: await res.text() };
}

let n = 0;
const uniq = () => `${Date.now()}${++n}`;
const isbn13 = () => "978" + String(Date.now()).slice(-7) + String(100 + (++n % 900));

async function seedBook(title, isbn = isbn13()) {
  const { rows } = await pool.query("INSERT INTO books (isbn, title, authors) VALUES ($1, $2, 'An Author') RETURNING id, isbn", [isbn, title]);
  return rows[0];
}
// ageDays: bigger = older, so "oldest first" is testable.
async function seedCopy(bookId, { status = "in_stock", condition = "very_good", price = 5, publisherPrice = null, ageDays = 0, location = null, reserved = false } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO book_copies (book_id, condition, price, publisher_price, status, location, created_at,
                              reserved_by_name, reserved_by_email, reserved_by_phone, reserved_at)
     VALUES ($1, $2, $3, $4, $5, $6, now() - ($7 || ' days')::interval, $8, $9, $10, $11) RETURNING id`,
    [bookId, condition, price, publisherPrice, status, location, String(ageDays),
      reserved ? "Rita Reserver" : null, reserved ? "rita@example.test" : null, reserved ? "0600000000" : null, reserved ? new Date() : null]
  );
  return rows[0].id;
}
const copyRow = async (id) => (await pool.query("SELECT * FROM book_copies WHERE id = $1", [id])).rows[0];
const salesOf = async (copyId) => (await pool.query("SELECT * FROM shop_sales WHERE copy_id = $1 ORDER BY id", [copyId])).rows;

// ---------- the retired page ----------

test("Sell in shop is retired: GET and POST redirect to the Till with a note; nothing is sold; no menu link", async () => {
  const anon = await get("/admin/inventory/sell", makeCookieJar());
  assert.equal(anon.res.status, 302);
  assert.match(anon.res.headers.get("location"), /login/);

  const g = await get("/admin/inventory/sell");
  assert.equal(g.res.status, 302);
  assert.equal(g.res.headers.get("location"), "/admin/till?notice=sell-retired");

  const book = await seedBook(`Retired ${uniq()}`);
  const copyId = await seedCopy(book.id, { price: 6 });
  const p = await post("/admin/inventory/sell", { copyId: String(copyId), price: "6", payment: "cash" });
  assert.equal(p.status, 302);
  assert.equal(p.headers.get("location"), "/admin/till?notice=sell-retired");
  assert.equal((await copyRow(copyId)).status, "in_stock", "the old POST sells nothing any more");
  assert.equal((await salesOf(copyId)).length, 0);

  const till = await get("/admin/till?notice=sell-retired");
  assert.match(till.text, /Sales are made at the Till now/);
  assert.doesNotMatch((await get("/admin/till")).text, /Sales are made at the Till now/, "the note only shows with the redirect");
  assert.doesNotMatch((await get("/admin/inventory")).text, /inventory\/sell/);
  assert.doesNotMatch((await get("/admin/inventory/scan")).text, /inventory\/sell/);
});

test("old shop_sales rows stay and still count in Reports and the accounting export", async () => {
  const book = await seedBook(`Old Sale ${uniq()}`);
  const copyId = await seedCopy(book.id, { status: "sold" });
  await pool.query("INSERT INTO shop_sales (copy_id, price, sold_at, payment_method) VALUES ($1, 7.50, now(), 'cash')", [copyId]);
  const day = new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
  const res = await fetch(`${app.base}/admin/reports/accounting?from=${day}&to=${day}&format=csv`, { headers: { cookie: jar.header(), "x-forwarded-for": "10.79.1.1" } });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /"?Books used"?,"?Cash"?,\d+,"?7\.5/);
  assert.equal((await salesOf(copyId)).length, 1, "the row is still there");
});

// ---------- source ----------

const INTAKE = { description: "d", descriptionFr: "d", coverUrl: "https://example.test/c.jpg", status: "in_stock", condition: "very_good", price: "5" };
const sourceOfTitle = async (title) =>
  (await pool.query("SELECT c.source FROM book_copies c JOIN books b ON b.id = c.book_id WHERE b.title = $1", [title])).rows[0].source;

test("intake saves the chosen source; anything unknown is stored as NULL", async () => {
  const withSource = `Source Donation ${uniq()}`;
  const res = await post("/admin/inventory", { ...INTAKE, title: withSource, source: "donation", location: "a1", fromScan: "1" });
  assert.equal(res.status, 302);
  assert.equal(await sourceOfTitle(withSource), "donation");
  // The add flow comes back remembering the location and the source.
  assert.match(res.headers.get("location"), /^\/admin\/inventory\/new\?saved=\d+&location=A1&source=donation&condition=very_good$/);

  const none = `Source None ${uniq()}`;
  await post("/admin/inventory", { ...INTAKE, title: none, source: "" });
  assert.equal(await sourceOfTitle(none), null);
  const bogus = `Source Bogus ${uniq()}`;
  await post("/admin/inventory", { ...INTAKE, title: bogus, source: "stolen" });
  assert.equal(await sourceOfTitle(bogus), null);
  for (const value of ["purchase", "lot", "other"]) {
    const title = `Source ${value} ${uniq()}`;
    await post("/admin/inventory", { ...INTAKE, title, source: value });
    assert.equal(await sourceOfTitle(title), value);
  }
});

test("the database refuses a source outside the list", async () => {
  const book = await seedBook(`Check ${uniq()}`);
  await assert.rejects(pool.query("INSERT INTO book_copies (book_id, source) VALUES ($1, 'stolen')", [book.id]), /check constraint/);
});

test("the source starts at Donation the first time, the source of the last book is carried in the address, and a refused save keeps what was chosen", async () => {
  const { text } = await get("/admin/inventory/new");
  assert.match(text, /<select id="source" name="source">[\s\S]*<option value="donation" selected>Donation<\/option>/);
  assert.match((await get("/admin/inventory/new?source=other")).text, /<option value="other" selected>Other<\/option>/);
  // ...and a refused save (no title) keeps the chosen one.
  const bad = await post("/admin/inventory", { ...INTAKE, title: "", source: "purchase" });
  assert.match(await bad.text(), /<option value="purchase" selected>Purchase<\/option>/);
  // The photo page no longer has the batch controls (the book form owns them).
  assert.doesNotMatch((await get("/admin/inventory/scan?saved=1&source=lot")).text, /Source of these books/);
});

test("the copy edit form shows and saves the source, and can clear it", async () => {
  const book = await seedBook(`Edit Source ${uniq()}`);
  const copyId = await seedCopy(book.id);
  const { text } = await get(`/admin/inventory/${book.id}`);
  assert.match(text, new RegExp(`id="source-${copyId}" name="source"[\\s\\S]*?<option value="" selected>Unknown</option>`));
  const edit = (source) => post(`/admin/inventory/${book.id}/copies/${copyId}`, { condition: "very_good", status: "in_stock", price: "5", source });
  assert.equal((await edit("purchase")).status, 302);
  assert.equal((await copyRow(copyId)).source, "purchase");
  assert.match((await get(`/admin/inventory/${book.id}`)).text, new RegExp(`id="source-${copyId}"[\\s\\S]*?<option value="purchase" selected>Purchase</option>`));
  await edit("");
  assert.equal((await copyRow(copyId)).source, null);
});
