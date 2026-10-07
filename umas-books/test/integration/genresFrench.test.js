// Customer-facing book page: genres in the visitor's language.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");

let app;
let pool;
let bookId;

before(async () => {
  app = await startTestApp({ port: 4291, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  // categories_fr left empty (the usual case for older stock) plus one custom genre.
  const { rows } = await pool.query(
    "INSERT INTO books (title, authors, categories) VALUES ('Genre test book', 'A. Writer', 'Mystery, Science Fiction, Zymurgy') RETURNING id"
  );
  bookId = rows[0].id;
  await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 5, 'very_good')", [bookId]);
});

after(async () => {
  await pool.query("DELETE FROM books WHERE id = $1", [bookId]);
  await pool.end();
  app.stop();
});

const get = (p, lang) => fetch(`${app.base}${p}`, { headers: lang ? { cookie: `umasbooks_lang=${lang}` } : {} }).then((r) => r.text());
const kicker = (html) => (html.match(/class="book-detail-kicker">([^<]*)</) || [])[1];

test("book page: genres are French in French (even with no stored French), English otherwise", async () => {
  assert.equal(kicker(await get(`/books/${bookId}`, "fr")), "Policier, Science-fiction, Zymurgy");
  assert.equal(kicker(await get(`/books/${bookId}`, "en")), "Mystery, Science Fiction, Zymurgy");
});

test("book page: the back link names the genre in French, and keeps the English filter in its URL", async () => {
  const fr = await get(`/books/${bookId}?genre=Mystery`, "fr");
  assert.match(fr, /Retour à Policier/);
  assert.match(fr, /href="\/books\.html\?genre=Mystery"/);
  assert.match(await get(`/books/${bookId}?genre=Mystery`, "en"), /Back to Mystery/);
});
