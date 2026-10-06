// "Sell in shop" (/admin/inventory/sell) and the copy "source" (donation,
// purchase, job lot, other): recorded at intake, remembered between books on
// the scan flow, editable on the copy.

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
let adminId;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const email = `shop-admin-${Date.now()}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, is_member) VALUES ($1, $2, 'Shop Admin', true, true) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10)]
  );
  adminId = rows[0].id;
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

// Step 1 (scan) then step 2 (record), as the browser does.
const scan = (isbn) => post("/admin/inventory/sell", { isbn });
const record = (copyId, price, extra = {}) => post("/admin/inventory/sell", { copyId: String(copyId), price: String(price), payment: "cash", ...extra });

// ---------- the page ----------

test("sell page needs an admin, focuses the ISBN box, and is linked from inventory and scan pages", async () => {
  const anon = await get("/admin/inventory/sell", makeCookieJar());
  assert.equal(anon.res.status, 302);
  assert.match(anon.res.headers.get("location"), /login/);
  const { res, text } = await get("/admin/inventory/sell");
  assert.equal(res.status, 200);
  assert.match(text, /<form[^>]*method="post"[^>]*action="\/admin\/inventory\/sell"/);
  assert.match(text, /name="isbn"[^>]*autofocus/);
  assert.doesNotMatch(text, /<script[^>]*>[^<]/, "no inline script (CSP)");
  assert.match((await get("/admin/inventory")).text, /href="\/admin\/inventory\/sell">Sell in shop</);
  assert.match((await get("/admin/inventory/scan")).text, /href="\/admin\/inventory\/sell">Sell in shop</);
});

// ---------- selling ----------

test("happy path: scan, check the price, record: the copy is sold, a sale and an audit row are written", async () => {
  const book = await seedBook(`Happy Sale ${uniq()}`);
  const copyId = await seedCopy(book.id, { price: 6, location: "A1" });
  const found = await scan(book.isbn);
  const html = await found.text();
  assert.equal(found.status, 200);
  assert.match(html, /name="price"[^>]*value="6\.00"/, "the asking price is pre-filled");
  assert.match(html, /Record sale/);
  assert.match(html, /<button[^>]*autofocus[^>]*>Record sale/, "Enter on the next scan-less step records the sale");
  assert.equal((await copyRow(copyId)).status, "in_stock", "looking is not selling");

  const res = await record(copyId, "4.50", { payment: "card" });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /^\/admin\/inventory\/sell\?sold=\d+$/);
  const copy = await copyRow(copyId);
  assert.equal(copy.status, "sold");
  const sales = await salesOf(copyId);
  assert.equal(sales.length, 1);
  assert.equal(Number(sales[0].price), 4.5);
  assert.equal(sales[0].payment_method, "card");
  assert.equal(sales[0].sold_by, adminId);
  const { rows } = await pool.query("SELECT detail, target_type, actor_label FROM admin_audit_log WHERE action = 'copy.shop_sale' AND target_id = $1", [copyId]);
  assert.deepEqual(rows.map((r) => [r.detail, r.target_type]), [["price 4.50", "book_copy"]]);

  // Back on the page: confirmation, ISBN box focused again, sale in the log.
  const page = await get(res.headers.get("location"));
  assert.match(page.text, /Sale recorded: Happy Sale \d+ for €4\.50\./);
  assert.match(page.text, /name="isbn"[^>]*autofocus/);
  assert.match(page.text, /Happy Sale \d+<\/td>\s*<td>&euro;4\.50<\/td>\s*<td>card<\/td>/);
});

test("selling a reserved copy clears the reservation contact details", async () => {
  const book = await seedBook(`Reserved Sale ${uniq()}`);
  const copyId = await seedCopy(book.id, { status: "reserved", reserved: true });
  assert.equal((await record(copyId, "5")).status, 302);
  const copy = await copyRow(copyId);
  assert.equal(copy.status, "sold");
  assert.deepEqual([copy.reserved_by_name, copy.reserved_by_email, copy.reserved_by_phone, copy.reserved_at], [null, null, null, null]);
});

test("an already sold copy is refused and nothing is recorded twice", async () => {
  const book = await seedBook(`Sold Twice ${uniq()}`);
  const copyId = await seedCopy(book.id);
  assert.equal((await record(copyId, "5")).status, 302);
  const again = await record(copyId, "5");
  assert.equal(again.status, 409);
  assert.match(await again.text(), /no longer for sale/);
  assert.equal((await salesOf(copyId)).length, 1);
  // And scanning it finds nothing to sell.
  const found = await scan(book.isbn);
  assert.match(await found.text(), /No copy of that book is available to sell/);
});

test("unknown ISBN, a non-barcode and an empty scan give a clear message and change nothing", async () => {
  const before = (await pool.query("SELECT COUNT(*)::int AS n FROM shop_sales")).rows[0].n;
  assert.match(await (await scan("9780000000002")).text(), /Not in inventory: 9780000000002/);
  assert.match(await (await scan("hello")).text(), /Not a book barcode: hello/);
  assert.match(await (await scan("")).text(), /Scan or type an ISBN first/);
  assert.equal((await pool.query("SELECT COUNT(*)::int AS n FROM shop_sales")).rows[0].n, before);
});

test("a negative or missing price is refused", async () => {
  const book = await seedBook(`Bad Price ${uniq()}`);
  const copyId = await seedCopy(book.id);
  for (const price of ["-1", "", "abc"]) {
    const res = await record(copyId, price);
    assert.equal(res.status, 400, `price "${price}"`);
    assert.match(await res.text(), /Enter the price/);
  }
  assert.equal((await copyRow(copyId)).status, "in_stock");
  assert.equal((await salesOf(copyId)).length, 0);
  // Free (0) is allowed for a used book.
  assert.equal((await record(copyId, "0")).status, 302);
});

test("several copies: a short list, the oldest preselected; another pick at the suggested price uses its own asking price", async () => {
  const book = await seedBook(`Many Copies ${uniq()}`);
  const oldest = await seedCopy(book.id, { price: 3, ageDays: 30 });
  const newer = await seedCopy(book.id, { price: 8, ageDays: 5 });
  const html = await (await scan(book.isbn)).text();
  assert.match(html, new RegExp(`id="copy-${oldest}" type="radio" name="copyId" value="${oldest}" checked`));
  assert.match(html, new RegExp(`id="copy-${newer}" type="radio" name="copyId" value="${newer}"(?! checked)`));
  assert.match(html, /name="price"[^>]*value="3\.00"/);
  // The browser sends the pre-filled 3.00 but the newer copy was picked.
  const res = await record(newer, "3.00", { prefillFor: String(oldest), prefillPrice: "3.00" });
  assert.equal(res.status, 302);
  assert.equal(Number((await salesOf(newer))[0].price), 8);
  assert.equal((await copyRow(oldest)).status, "in_stock");
  // A price that was really typed stays.
  const typed = await record(oldest, "2.50", { prefillFor: String(oldest), prefillPrice: "3.00" });
  assert.equal(typed.status, 302);
  assert.equal(Number((await salesOf(oldest))[0].price), 2.5);
});

test("a new book must sell at the publisher's price, at most 5% off", async () => {
  const book = await seedBook(`Brand New ${uniq()}`);
  const copyId = await seedCopy(book.id, { condition: "new", price: 20, publisherPrice: 20 });
  for (const price of ["15", "18.99", "20.01"]) {
    const res = await record(copyId, price);
    assert.equal(res.status, 400, price);
    assert.match(await res.text(), /must be sold at the publisher(&#39;|')s price/);
  }
  assert.equal((await copyRow(copyId)).status, "in_stock");
  assert.equal((await salesOf(copyId)).length, 0);
  assert.equal((await record(copyId, "19.00")).status, 302, "exactly 5% off is allowed");
  assert.equal(Number((await salesOf(copyId))[0].price), 19);
  // A used book is free-priced.
  const used = await seedCopy((await seedBook(`Used ${uniq()}`)).id, { condition: "acceptable", price: 10 });
  assert.equal((await record(used, "1")).status, 302);
});

test("two people selling the same single copy at once: exactly one sale goes through", async () => {
  const book = await seedBook(`Race ${uniq()}`);
  const copyId = await seedCopy(book.id);
  const shared = await fetchCsrfToken(app.base, jar);
  // Hold the copy's row lock while both requests arrive, so both are really in
  // flight together (without the FOR UPDATE they would both go straight
  // through and both record a sale), then let them go.
  const holder = await pool.connect();
  await holder.query("BEGIN");
  await holder.query("SELECT 1 FROM book_copies WHERE id = $1 FOR UPDATE", [copyId]);
  const racing = Promise.all([
    post("/admin/inventory/sell", { copyId: String(copyId), price: "5", payment: "cash" }, shared),
    post("/admin/inventory/sell", { copyId: String(copyId), price: "5", payment: "card" }, shared),
  ]);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await holder.query("COMMIT");
  holder.release();
  const race = await racing;
  assert.deepEqual(race.map((r) => r.status).sort(), [302, 409], "one wins, the other is told it is gone");
  assert.equal((await salesOf(copyId)).length, 1, "only one shop_sales row");
  const audits = await pool.query("SELECT 1 FROM admin_audit_log WHERE action = 'copy.shop_sale' AND target_id = $1", [copyId]);
  assert.equal(audits.rowCount, 1);
});

test("the page lists only the last 10 sales", async () => {
  const book = await seedBook(`Log ${uniq()}`);
  for (let i = 0; i < 12; i++) {
    const id = await seedCopy(book.id, { status: "sold" });
    await pool.query("INSERT INTO shop_sales (copy_id, price, sold_at) VALUES ($1, 1, now() + ($2 || ' seconds')::interval)", [id, String(i + 1)]);
  }
  const { text } = await get("/admin/inventory/sell");
  const tableRows = (text.match(/<tbody>[\s\S]*?<\/tbody>/) || [""])[0].match(/<tr>/g) || [];
  assert.equal(tableRows.length, 10);
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
  // The scan flow comes back remembering both.
  assert.match(res.headers.get("location"), /^\/admin\/inventory\/scan\?saved=1&label=\d+&location=A1&source=donation$/);

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

test("the source is remembered between books on the scan flow", async () => {
  // Scan page: preselected from the carried value, mirrored into the photo form.
  const { text } = await get("/admin/inventory/scan?saved=1&source=lot");
  assert.match(text, /<select id="source" name="source"[^>]*data-source-input>[\s\S]*<option value="lot" selected>Job lot<\/option>/);
  // Looking a book up carries it to the add-book form...
  const res = await post("/admin/inventory/lookup", { isbn: "", source: "purchase", location: "x1" });
  assert.equal(res.status, 200);
  assert.match(await res.text(), /name="source"[^>]*data-source-input[\s\S]*<option value="purchase" selected>/);
  const bookRes = await post("/admin/inventory/lookup", { isbn: "9780000000019", source: "purchase", location: "x1" });
  const form = await bookRes.text();
  assert.match(form, /<select id="source" name="source">[\s\S]*<option value="purchase" selected>Purchase<\/option>/);
  assert.match((await get("/admin/inventory/new?source=other")).text, /<option value="other" selected>Other<\/option>/);
  // ...and a refused save (no title) keeps it too.
  const bad = await post("/admin/inventory", { ...INTAKE, title: "", source: "donation" });
  assert.match(await bad.text(), /<option value="donation" selected>Donation<\/option>/);
  // The remembering script is the one already used for the location.
  assert.match(text, /src="\/inventory-location\.js"/);
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
