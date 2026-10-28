// Customer-facing book page and Browse on the French site: books have an English description and English genres only
// (Sharon, 2026-10-28). /fr/ shows the ENGLISH description and genres (marked lang="en"), inside the French page.
// Books have no French columns (dropped by migration 108).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");

let app;
let pool;
let bookId;
let leftoverId;

before(async () => {
  app = await startTestApp({ port: 4291, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  // A book as every book is now: English description and genres only.
  const { rows } = await pool.query(
    "INSERT INTO books (title, authors, categories, description) VALUES ('Genre test book', 'A. Writer', 'Mystery, Science Fiction, Zymurgy', 'A quiet lighthouse mystery with zymurgy.') RETURNING id"
  );
  bookId = rows[0].id;
  // A second English-only book (History).
  const { rows: [l] } = await pool.query(
    "INSERT INTO books (title, authors, categories, description) VALUES ('Leftover book', 'B. Writer', 'History', 'An English history.') RETURNING id"
  );
  leftoverId = l.id;
  for (const id of [bookId, leftoverId]) await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 5, 'very_good')", [id]);
});

after(async () => {
  await pool.query("DELETE FROM books WHERE id = ANY($1)", [[bookId, leftoverId]]);
  await pool.end();
  app.stop();
});

const fetchPage = (p, lang) => fetch(`${app.base}${p}`, { headers: lang ? { cookie: `umasbooks_lang=${lang}` } : {} });
const get = (p, lang) => fetchPage(p, lang).then((r) => r.text());
const kicker = (html) => (html.match(/class="book-detail-kicker">(?:<span lang="en">)?([^<]*)</) || [])[1];
const about = (html) => (html.match(/<p class="book-about">([\s\S]*?)<\/p>/) || [])[1];

test("/fr/books/N answers 200: English genres and description, marked lang=en, in a French page", async () => {
  const res = await fetchPage(`/fr/books/${bookId}`);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /<html[^>]* lang="fr"/);
  assert.match(html, /À propos de ce livre/, "the page around the book is French");
  assert.match(html, /class="book-detail-kicker"><span lang="en">Mystery, Science Fiction, Zymurgy<\/span>/);
  assert.equal(about(html), '<span lang="en">A quiet lighthouse mystery with zymurgy.</span>');
  // meta description and JSON-LD: the English text
  assert.match(html, /<meta name="description" content="A quiet lighthouse mystery with zymurgy\."/);
  const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  const book = [ld].flat().find((x) => x["@type"] === "Book") || ld;
  assert.equal(book.description, "A quiet lighthouse mystery with zymurgy.");
});

test("book page: English genres in both languages (no lang mark on the English page)", async () => {
  assert.equal(kicker(await get(`/books/${bookId}`, "fr")), "Mystery, Science Fiction, Zymurgy");
  const en = await get(`/books/${bookId}`, "en");
  assert.match(en, /class="book-detail-kicker">Mystery, Science Fiction, Zymurgy</);
  assert.equal(about(en), "A quiet lighthouse mystery with zymurgy.");
});

test("a second book: the French page shows its English genre and description, no French", async () => {
  const fr = await get(`/fr/books/${leftoverId}`);
  assert.equal(kicker(fr), "History");
  assert.equal(about(fr), '<span lang="en">An English history.</span>');
  assert.doesNotMatch(fr, /Une histoire française|Histoire</);
});

test("book page: the back link names the English genre inside the French sentence, and keeps the filter in its URL", async () => {
  const fr = await get(`/books/${bookId}?genre=Mystery`, "fr");
  assert.match(fr, /Retour à Mystery/);
  assert.match(fr, /href="\/books\.html\?genre=Mystery"/);
  assert.match(await get(`/books/${bookId}?genre=Mystery`, "en"), /Back to Mystery/);
});

test("the French Browse page and its genre address answer 200; search on /fr/ (and the API with ?lang=fr) works on the English fields", async () => {
  for (const p of ["/fr/books.html", "/fr/books.html?genre=mystery"]) assert.equal((await fetchPage(p)).status, 200, p);
  const search = async (qs) => {
    const r = await fetch(`${app.base}/api/books/search?${qs}`, { headers: { cookie: "umasbooks_lang=fr" } });
    assert.equal(r.status, 200, qs);
    return (await r.json()).map((b) => b.id);
  };
  assert.ok((await search("q=lighthouse&lang=fr")).includes(bookId), "the English description is searched");
  assert.ok((await search("q=Science%20Fiction&lang=fr")).includes(bookId), "the English genre is searched");
  assert.ok((await search("genre=Mystery&lang=fr")).includes(bookId), "the English genre filter");
  assert.ok((await search("topic=mystery,thriller&lang=fr")).includes(bookId), "the Browse button's topic");
  assert.ok(!(await search("q=Policier&lang=fr")).includes(bookId), "no French genre to find");
});
