// Sticker colors in the admin: the chip on a copy's page, the new-book note on
// the intake form, and the printable sticker sheet (/admin/inventory/stickers).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3977;
const PASSWORD = "Sticker-Test-1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const RUN = Date.now();
const LOC = `STK-${RUN}`.slice(0, 40); // unique location: other tests' rows never match it

let app;
let pool;
let jar;
let bookIds = [];
const titles = {};

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const email = `stk-admin-${RUN}@example.test`;
  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, is_member) VALUES ($1, $2, 'Sticker Admin', true, true)`,
    [email, await bcrypt.hash(PASSWORD, 10)]
  );
  jar = makeCookieJar();
  const res = await post("/login", { email, password: PASSWORD });
  assert.equal(res.status, 302);

  // One copy per color, all at LOC; plus one old copy that "added since" must exclude.
  const specs = [
    ["yellow", 3, "acceptable", false, 0], ["green", 5, "very_good", false, 0], ["blue", 8, "acceptable", false, 0],
    ["red", 10, "acceptable", false, 0], ["purple", 5.01, "acceptable", false, 0], ["orange", 1, "acceptable", true, 0],
    ["white", 14, "new", false, 0], ["old", 5, "acceptable", false, 30],
  ];
  for (const [name, price, condition, clearance, ageDays] of specs) {
    // The title starts with "=" for one book so the CSV formula guard is exercised.
    const title = `${name === "purple" ? "=" : ""}Stk ${name} ${RUN}`;
    titles[name] = title;
    const { rows } = await pool.query(`INSERT INTO books (title, authors, isbn) VALUES ($1, 'Stk Author', $2) RETURNING id`, [title, `978${String(RUN).slice(-9)}${specs.findIndex((s) => s[0] === name)}`.slice(0, 13)]);
    bookIds.push(rows[0].id);
    titles[`${name}Id`] = rows[0].id;
    await pool.query(
      `INSERT INTO book_copies (book_id, condition, status, price, is_clearance, location, publisher_price, created_at)
       VALUES ($1, $2, 'in_stock', $3, $4, $5, $6, now() - ($7 || ' days')::interval)`,
      [rows[0].id, condition, price, clearance, LOC, condition === "new" ? 14 : null, String(ageDays)]
    );
  }
});

after(async () => {
  await pool.query("DELETE FROM books WHERE id = ANY($1)", [bookIds]);
  await pool.end();
  app.stop();
});

async function post(path, fields) {
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header(), "x-forwarded-for": "10.77.0.1" },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });
  jar.capture(res);
  return res;
}
const get = (path, headers = {}) => fetch(`${app.base}${path}`, { redirect: "manual", headers: { cookie: jar.header(), ...headers } });

const chipFor = (html, key) => new RegExp(`data-sticker-chip="${key}"[^>]*>([^<]*)<`).exec(html);

test("a copy's page shows its sticker chip, with the right text for each color", async () => {
  const cases = [
    ["green", "Green sticker, EUR 5"],
    ["purple", "Purple sticker, custom price EUR 5.01"],
    ["orange", "Orange sticker, clearance EUR 1"],
    ["white", "White sticker: publisher price EUR 14, write it on the sticker"],
    ["yellow", "Yellow sticker, EUR 3"],
  ];
  for (const [color, text] of cases) {
    const res = await get(`/admin/inventory/${titles[`${color}Id`]}`);
    assert.equal(res.status, 200);
    const html = await res.text();
    const m = chipFor(html, color);
    assert.ok(m, `${color} chip is on the page`);
    assert.ok(html.includes(`>${text}<`), `${color}: ${text}`);
    assert.match(html, /data-sticker-levels=/, "the script gets the scheme from the page");
  }
});

test("the add-book form for a NEW book shows the retail note and no used-book suggestion", async () => {
  const res = await post("/admin/inventory/suggest", { title: "Neuf", condition: "new", publisherPrice: "14.00", binding: "trade" });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /New book: sell at the publisher&#39;s price \(max 5% off\)/);
  assert.doesNotMatch(html, /Suggested EUR/);
  assert.ok(chipFor(html, "white"), "white chip");
  assert.match(html, /publisher price EUR 14, write it on the sticker/);
  // no "Suggested" tag is visible on any used-level radio
  assert.doesNotMatch(html, /data-suggested-tag="[^"]+">Suggested<\/span>/);

  const json = await (await get("/admin/inventory/price-suggestion?condition=new&publisherPrice=14&title=Neuf")).json();
  assert.equal(json.label, "New book: sell at the publisher's price (max 5% off).");
  assert.equal(json.level, null, "no used-book level for a new book");
});

test("a used book on the add-book form gets a used-level suggestion and a sticker chip", async () => {
  const res = await post("/admin/inventory/suggest", { title: "Occasion", isbn: "9780140449136", condition: "very_good", binding: "mass_market" });
  const html = await res.text();
  assert.match(html, /Suggested EUR 5\.00/);
  assert.ok(chipFor(html, "green"), "mass market at EUR 5 is a green sticker");
});

test("the sticker sheet lists recent in-stock copies, sorted by color, with chips", async () => {
  const res = await get(`/admin/inventory/stickers?location=${encodeURIComponent(LOC)}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Added since/);
  assert.match(html, /class="sticker-legend"/, "legend is on the page");
  const order = ["orange", "yellow", "green", "blue", "red", "purple", "white"];
  const positions = order.map((c) => html.indexOf(`Stk ${c} ${RUN}`));
  // the purple book's title starts with "="; it is still listed
  positions.forEach((p, i) => assert.ok(p > 0, `${order[i]} listed`));
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "sorted by color within the location");
  assert.ok(!html.includes(`Stk old ${RUN}`), "30-day-old copy is outside the default last 7 days");
  assert.match(html, /@media print|print-button\.js/);
});

test("the sticker sheet filters: added since, color, location", async () => {
  const since = new Date(Date.now() - 40 * 86400000).toISOString().slice(0, 10);
  let html = await (await get(`/admin/inventory/stickers?location=${encodeURIComponent(LOC)}&since=${since}`)).text();
  assert.ok(html.includes(`Stk old ${RUN}`), "an earlier date includes the old copy");
  html = await (await get(`/admin/inventory/stickers?location=${encodeURIComponent(LOC)}&color=green`)).text();
  assert.ok(html.includes(`Stk green ${RUN}`));
  assert.ok(!html.includes(`Stk blue ${RUN}`));
  html = await (await get(`/admin/inventory/stickers?location=NOWHERE-${RUN}`)).text();
  assert.ok(!html.includes(`Stk green ${RUN}`));
  assert.match(html, /No in-stock copies match/);
  // garbage filters fall back to the defaults instead of failing
  assert.equal((await get("/admin/inventory/stickers?since=nope&color=pink")).status, 200);
});

test("the sticker sheet leaves out copies that are not in stock", async () => {
  await pool.query("UPDATE book_copies SET status = 'sold' WHERE book_id = $1", [titles.blueId]);
  const html = await (await get(`/admin/inventory/stickers?location=${encodeURIComponent(LOC)}`)).text();
  assert.ok(!html.includes(`Stk blue ${RUN}`));
  await pool.query("UPDATE book_copies SET status = 'in_stock' WHERE book_id = $1", [titles.blueId]);
});

test("CSV export: header, rows, formula guard, download headers and an audit entry", async () => {
  const res = await get(`/admin/inventory/stickers?format=csv&location=${encodeURIComponent(LOC)}`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="umas-books-stickers-since-\d{4}-\d{2}-\d{2}\.csv"/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const text = await res.text();
  const lines = text.replace(/^\uFEFF/, "").trim().split("\r\n");
  assert.equal(lines[0], '"Color","Price (EUR)","Title","Author","ISBN","Condition","Binding","Location"');
  assert.equal(lines.length, 8, "header + 7 recent copies");
  assert.match(lines[1], /^"Orange",1\.00,"Stk orange /);
  assert.match(lines[7], /^"White",14\.00,"Stk white /);
  assert.ok(text.includes(`"'=Stk purple ${RUN}"`), "a title starting with = is neutralised");
  const { rows } = await pool.query("SELECT detail FROM admin_audit_log WHERE action = 'stickers.csv'");
  assert.ok(rows.some((r) => r.detail.includes(`location=${LOC}`)), "the download is audited");
});

test("the stickers page and its CSV need an admin", async () => {
  for (const path of ["/admin/inventory/stickers", "/admin/inventory/stickers?format=csv"]) {
    const res = await fetch(`${app.base}${path}`, { redirect: "manual" });
    assert.ok([401, 403].includes(res.status) || (res.status === 302 && res.headers.get("location") === "/login"), `${path}: ${res.status}`);
    assert.doesNotMatch(await res.text(), /Stk green/);
  }
});

test("the smoke crawler skips the CSV link (it keeps ?format=csv)", () => {
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../scripts/sitemap/crawler.js"), "utf8");
  assert.match(src, /DOWNLOAD_QUERY = \/\[\?&\]format=csv/);
  const re = /[?&]format=csv(&|$)/i;
  assert.ok(re.test("?since=2026-01-01&location=&color=&format=csv"));
});
