// The public side of clearance pricing, against the real app: a "Clearance"
// badge (Déstockage in French) on the book page, and `clearance: true` in the
// books search JSON when an in-stock copy is on clearance. Also a smoke test
// that the admin pricing pages are behind the admin login and that the price
// suggestion script is served and is valid JavaScript.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { startTestApp } = require("../helpers/testApp");

const PORT = 3840;
const TAG = `Zc${Date.now().toString(36)}`;

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
  await app.stop();
});

let n = 0;
async function makeBook(copies) {
  const title = `${TAG} Book ${++n}`;
  const { rows } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'Pub Author') RETURNING id", [title]);
  for (const c of copies) {
    await pool.query("INSERT INTO book_copies (book_id, status, price, condition, is_clearance) VALUES ($1, $2, $3, 'good', $4)", [rows[0].id, c.status || "in_stock", c.price, Boolean(c.clearance)]);
  }
  return { id: rows[0].id, title };
}

const page = async (id, lang) => {
  const res = await fetch(`${app.base}/books/${id}`, { headers: lang ? { cookie: `umasbooks_lang=${lang}` } : {} });
  return res.text();
};

test("book page: a Clearance badge (Déstockage in French) when an in-stock copy is on clearance, and not otherwise", async () => {
  const clearance = await makeBook([{ price: 5 }, { price: 1, clearance: true }]);
  const plain = await makeBook([{ price: 5 }, { price: 8 }]);
  const soldOnly = await makeBook([{ price: 5 }, { price: 1, clearance: true, status: "sold" }]);

  const en = await page(clearance.id);
  assert.match(en, /<span class="clearance-badge">Clearance<\/span>/);
  assert.match(en, /€1\.00 <span class="clearance-badge">Clearance<\/span><\/td>/, "the copy row in the table of copies");
  const fr = await page(clearance.id, "fr");
  assert.match(fr, /<span class="clearance-badge">Déstockage<\/span>/);
  assert.match(fr, /1,00\u00a0€ <span class="clearance-badge">Déstockage<\/span><\/td>/);
  assert.doesNotMatch(fr, />Clearance</);

  for (const book of [plain, soldOnly]) {
    assert.doesNotMatch(await page(book.id), /clearance-badge/);
    assert.doesNotMatch(await page(book.id, "fr"), /Déstockage/);
  }
});

test("books search JSON: clearance is true only when an in-stock copy is on clearance", async () => {
  const on = await makeBook([{ price: 5 }, { price: 1, clearance: true }]);
  const off = await makeBook([{ price: 5 }]);
  const sold = await makeBook([{ price: 5 }, { price: 1, clearance: true, status: "sold" }]);
  const res = await fetch(`${app.base}/api/books/search?q=${TAG}`);
  const json = await res.json();
  const flag = (b) => json.find((x) => x.id === b.id).clearance;
  assert.deepEqual([flag(on), flag(off), flag(sold)], [true, false, false]);
  assert.equal(json.find((x) => x.id === on.id).price, 1);
});

test("admin pricing pages are behind the admin login; the suggestion script is served and compiles", async () => {
  for (const p of ["/admin/pricing", "/admin/pricing/review", "/admin/inventory/price-suggestion?isbn=1"]) {
    const res = await fetch(`${app.base}${p}`, { redirect: "manual" });
    assert.equal(res.status, 302, p);
    assert.equal(res.headers.get("location"), "/login");
  }
  const res = await fetch(`${app.base}/price-suggestion.js`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /javascript/);
  const source = await res.text();
  assert.doesNotThrow(() => new vm.Script(source));
  assert.equal(source, fs.readFileSync(path.join(__dirname, "..", "..", "public", "price-suggestion.js"), "utf8"));
  // the page-level "dirty" rule lives in the script; what it relies on is the endpoint (tested in pricingAdmin.test.js)
  assert.match(source, /dirty/);
});
