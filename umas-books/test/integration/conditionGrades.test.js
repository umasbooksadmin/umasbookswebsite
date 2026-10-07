// Condition grades and binding on the public side and in the database:
// migration 048 (remap of the old grades, default, CHECK constraints), the
// book page (every copy with its grade, legend, binding; English and French),
// the cart line and the public search API.
//
// Own throwaway database (isolated:true): the migration test changes the
// column's constraint and default for a moment.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken, waitForCartCount } = require("../helpers/httpClient");

const PORT = 3820;
const TAG = `Cg${Date.now().toString(36)}`;

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

async function page(p, lang, headers = {}) {
  const res = await fetch(`${app.base}${p}`, { headers: { cookie: `umasbooks_lang=${lang}`, ...headers } });
  return { status: res.status, text: await res.text(), json: () => null };
}

async function makeBook({ title, binding = null, copies }) {
  const { rows } = await pool.query("INSERT INTO books (title, authors, binding) VALUES ($1, 'Grade Author', $2) RETURNING id", [title, binding]);
  const ids = [];
  for (const [condition, price] of copies) {
    const r = await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', $2, $3) RETURNING id", [rows[0].id, price, condition]);
    ids.push(r.rows[0].id);
  }
  return { id: rows[0].id, copyIds: ids };
}

// ------------------------------------------------------------- migration 048

test("migration 048 remaps old grades, sets the default, and locks the column to the four grades (re-runnable)", async () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "048_condition_grades_and_binding.sql"), "utf8");
  // Put the table back in its pre-048 state, with one copy of every old grade.
  await pool.query("ALTER TABLE book_copies DROP CONSTRAINT book_copies_condition_check");
  await pool.query("ALTER TABLE book_copies ALTER COLUMN condition SET DEFAULT 'good'");
  const { rows: [b] } = await pool.query("INSERT INTO books (title) VALUES ($1) RETURNING id", [`${TAG} migration`]);
  const ids = {};
  for (const c of ["new", "like_new", "good", "fair", "poor"]) {
    const { rows } = await pool.query("INSERT INTO book_copies (book_id, condition) VALUES ($1, $2) RETURNING id", [b.id, c]);
    ids[c] = rows[0].id;
  }

  await pool.query(sql);
  await pool.query(sql); // idempotent

  const { rows } = await pool.query("SELECT id, condition FROM book_copies WHERE book_id = $1", [b.id]);
  const now = Object.fromEntries(Object.entries(ids).map(([old, id]) => [old, rows.find((r) => r.id === id).condition]));
  assert.deepEqual(now, { new: "new", like_new: "like_new", good: "very_good", fair: "acceptable", poor: "acceptable" });

  const { rows: [d] } = await pool.query("INSERT INTO book_copies (book_id) VALUES ($1) RETURNING condition", [b.id]);
  assert.equal(d.condition, "very_good", "new default");

  for (const bad of ["poor", "good", "fair", "pristine", ""]) {
    await assert.rejects(pool.query("INSERT INTO book_copies (book_id, condition) VALUES ($1, $2)", [b.id, bad]), { code: "23514" }, bad);
  }
  await assert.rejects(pool.query("UPDATE book_copies SET condition = 'poor' WHERE id = $1", [ids.new]), { code: "23514" });
});

test("books.binding accepts the three bindings and NULL, and rejects anything else", async () => {
  for (const ok of ["hardcover", "paperback", "mass_market", null]) {
    await pool.query("INSERT INTO books (title, binding) VALUES ($1, $2)", [`${TAG} binding ${ok}`, ok]);
  }
  await assert.rejects(pool.query("INSERT INTO books (title, binding) VALUES ($1, 'spiral')", [`${TAG} bad`]), { code: "23514" });
  const { rows } = await pool.query("SELECT binding FROM books WHERE title = $1", [`${TAG} binding ${null}`]);
  assert.equal(rows[0].binding, null, "existing books stay NULL");
});

// ---------------------------------------------------------------- book page

test("book page (English): every copy is listed with its grade and price, plus the legend and the binding", async () => {
  const b = await makeBook({
    title: `${TAG} Multi`, binding: "paperback",
    copies: [["acceptable", 3], ["new", 12], ["very_good", 6], ["like_new", 9]],
  });
  const { status, text } = await page(`/books/${b.id}`, "en");
  assert.equal(status, 200);
  for (const [grade, price] of [["Acceptable", "3.00"], ["New", "12.00"], ["Very Good", "6.00"], ["Like New", "9.00"]]) {
    assert.match(text, new RegExp(`condition-badge condition-[a-z_]+">${grade}</span></td>\\s*<td>€${price}</td>`), grade);
  }
  for (const id of b.copyIds) assert.match(text, new RegExp(`name="copyId" value="${id}"`), "an add-to-cart form per copy");
  assert.match(text, /<details class="grade-legend">/);
  assert.match(text, /What the grades mean/);
  assert.match(text, /Unread, as published \(sold at the publisher(?:'|&#39;)s price\)\./);
  assert.match(text, /Looks unread: no marks, no wear\./);
  assert.match(text, /Light wear only: clean pages, no writing or highlighting\./);
  assert.match(text, /Clearly used but complete and readable: wear, creases or some markings\./);
  assert.match(text, /Binding<\/dt> :\s*<dd>Paperback<\/dd>|Binding :<\/dt> <dd>Paperback/);
  assert.ok(!/>Good<|>Fair<|>Poor</.test(text), "no old grade name");
});

test("book page (French): grades, legend and binding are in French", async () => {
  const b = await makeBook({ title: `${TAG} Multi FR`, binding: "mass_market", copies: [["very_good", 6], ["acceptable", 3]] });
  const { text } = await page(`/books/${b.id}`, "fr");
  assert.match(text, /condition-badge condition-very_good">Très bon état</);
  assert.match(text, /condition-badge condition-acceptable">État acceptable</);
  assert.match(text, /Que signifient les états\u00a0\?/);
  assert.match(text, /Légère usure seulement\u00a0: pages propres, sans annotations ni surlignage\./);
  assert.match(text, /Visiblement utilisé mais complet et lisible/);
  assert.match(text, /Reliure :\s*<\/dt> <dd>Poche<\/dd>|Reliure[^<]*<\/dt> <dd>Poche/);
  assert.ok(!text.includes(">Very Good<") && !text.includes("Mass Market"), "no English grade or binding");
});

test("book page: a single copy shows its grade too; no binding line when the book has none", async () => {
  const b = await makeBook({ title: `${TAG} Single`, copies: [["like_new", 8]] });
  const { text } = await page(`/books/${b.id}`, "en");
  assert.match(text, /condition-badge condition-like_new">Like New</);
  assert.match(text, /1 copy on our shelves/);
  assert.ok(!text.includes("book-facts"), "binding unknown: nothing shown");
});

test("book page: sold copies are not listed", async () => {
  const b = await makeBook({ title: `${TAG} Partly sold`, copies: [["new", 12], ["acceptable", 2]] });
  await pool.query("UPDATE book_copies SET status = 'sold' WHERE id = $1", [b.copyIds[1]]);
  const { text } = await page(`/books/${b.id}`, "en");
  assert.ok(!text.includes(">Acceptable</span></td>"));
  assert.match(text, />New<\/span><\/td>/);
});

// --------------------------------------------------------------------- cart

test("cart: the line shows the copy's grade in English and French", async () => {
  const b = await makeBook({ title: `${TAG} Cart book`, copies: [["acceptable", 4]] });
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const add = await fetch(`${app.base}/cart/add`, {
    method: "POST", redirect: "manual",
    headers: { cookie: jar.header(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ copyId: String(b.copyIds[0]), _csrf: token }).toString(),
  });
  assert.equal(add.status, 302);
  await waitForCartCount(app.base, jar, 1); // the 302 can arrive before the session write lands
  const en = await page("/cart", "en", { cookie: `umasbooks_lang=en; ${jar.header()}` });
  assert.match(en.text, /condition-badge condition-acceptable">Acceptable</);
  const fr = await page("/cart", "fr", { cookie: `umasbooks_lang=fr; ${jar.header()}` });
  assert.match(fr.text, /condition-badge condition-acceptable">État acceptable</);
});

// ---------------------------------------------------------------------- API

test("search API: results carry the grades on the shelf and the binding", async () => {
  const b = await makeBook({ title: `${TAG} Api book`, binding: "hardcover", copies: [["acceptable", 3], ["new", 10], ["acceptable", 4]] });
  const res = await fetch(`${app.base}/api/books/search?q=${encodeURIComponent(`${TAG} Api book`)}`);
  assert.equal(res.status, 200);
  const hit = (await res.json()).find((x) => x.id === b.id);
  assert.deepEqual(hit.conditions, [{ value: "new", label: "New" }, { value: "acceptable", label: "Acceptable" }]);
  assert.equal(hit.binding, "hardcover");
  assert.equal(hit.bindingLabel, "Hardcover");
  assert.equal(hit.price, 3);
});

test("book page: the friendly used-book note, the no-returns notice that keeps legal rights, the grade line and the tax line (English and French)", async () => {
  const b = await makeBook({ title: `${TAG} Disclaimer`, copies: [["very_good", 6]] });
  const en = (await page(`/books/${b.id}`, "en")).text;
  assert.ok(en.includes("Our second-hand books are sold as described, so please read the condition grade, and ask us if you have any question."));
  assert.ok(en.includes("Used books are not taken back for a change of mind once bought in the shop; the legal guarantees still apply."));
  assert.ok(en.includes("The grade is the description of the book: please read it before you buy."));
  assert.ok(en.includes("Price incl. tax, TVA non applicable"));
  assert.match(en, /class="muted small book-disclaimer">[^<]*<a href="\/terms-of-sale\.html">Terms of sale<\/a>/);
  assert.doesNotMatch(en, /waive|renounce/i);
  const fr = (await page(`/books/${b.id}`, "fr")).text;
  assert.ok(fr.includes("Nos livres d’occasion sont vendus tels que décrits\u00a0: lisez bien l’état indiqué, et posez-nous toutes vos questions."));
  assert.ok(fr.includes("Les livres d’occasion ne sont ni repris ni échangés pour simple changement d’avis une fois achetés en boutique"));
  assert.ok(fr.includes("L’état indiqué est la description du livre\u00a0: merci de le lire avant d’acheter."));
  assert.ok(fr.includes("Prix TTC, TVA non applicable"));
});
