// Every customer-facing page that shows a book cover carries the note that
// covers come from an online library and may not match the shop's copy.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startTestApp } = require("../helpers/testApp");

const PORT = 3493;
const NOTE_EN = "Cover images come from an online book library and may not show the actual condition of the copy in our shop.";
let app, pool;

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

test("book detail page shows the cover note", async () => {
  const { rows: b } = await pool.query(
    "INSERT INTO books (title, authors, cover_url) VALUES ('Note Book', 'A', 'https://example.test/c.jpg') RETURNING id");
  await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 5)", [b[0].id]);
  const html = await (await fetch(`${app.base}/books/${b[0].id}`)).text();
  assert.ok(html.includes(NOTE_EN));
  const fr = await (await fetch(`${app.base}/books/${b[0].id}`, { headers: { cookie: "umasbooks_lang=fr" } })).text();
  assert.match(fr, /Les couvertures proviennent d’une bibliothèque/);
  assert.ok(!fr.includes(NOTE_EN));
});

test("favorites page shows the cover note", async () => {
  const html = await (await fetch(`${app.base}/favorites`)).text();
  assert.ok(html.includes(NOTE_EN));
});

test("books page shows the note in English and French", async () => {
  const html = await (await fetch(`${app.base}/books.html`)).text();
  assert.ok(html.includes(NOTE_EN));
  assert.match(html, /"bk\.covernote":"Les couvertures proviennent/);
});

test("cart page template includes the note when there are items", () => {
  const src = fs.readFileSync(path.join(__dirname, "../../views/cart.ejs"), "utf8");
  assert.match(src, /include\('partials\/cover_note'\)/);
});
