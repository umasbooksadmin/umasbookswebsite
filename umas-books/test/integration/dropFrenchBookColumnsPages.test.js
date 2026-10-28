// After migration 109 (no books.description_fr / categories_fr, no managed_genres.name_fr / browse_label_fr) the REAL
// app (child process, real sessions and CSRF) boots and the main customer and admin pages answer 200: the book page in
// English and French, the genre pages and the genre search, a collection, Admin > Genres, the inventory list, its
// search and both CSV exports, scan intake, add manually, edit book and the till. Port 6539 is reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { Client } = require("pg");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar } = require("../helpers/httpClient");
const { createAccount, loginOverHttp } = require("../helpers/accounts");

const PORT = 6539;
let app;
let db;
let adminJar;
let bookId;
let collectionSlug;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  db = new Client({ connectionString: app.databaseUrl, ssl: false });
  await db.connect();
  const admin = await createAccount({ query: (s, p) => db.query(s, p) }, { email: "drop-fr-admin@example.test", displayName: "Drop FR Admin" });
  await db.query("UPDATE users SET is_admin = true WHERE id = $1", [admin.id]);
  adminJar = makeCookieJar();
  assert.equal((await loginOverHttp(app.base, adminJar, admin)).status, 302);
  const { rows: [b] } = await db.query(
    "INSERT INTO books (title, authors, isbn, categories, description, binding) VALUES ('Dropped Columns Book', 'D. Writer', '9780141439518', 'Mystery, Fiction', 'An English description.', 'trade') RETURNING id"
  );
  bookId = b.id;
  await db.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 6, 'good')", [bookId]);
  const { rows: [c] } = await db.query("SELECT slug FROM curated_collections WHERE published ORDER BY sort_order, id LIMIT 1");
  collectionSlug = c && c.slug;
});
after(async () => { await db.end(); app.stop(); });

const get = async (path, jar) => {
  const r = await fetch(`${app.base}${path}`, { redirect: "manual", headers: jar ? { cookie: jar.header() } : {} });
  if (jar) jar.capture(r);
  return { status: r.status, text: await r.text() };
};

test("the database really has no French book / managed-genre columns", async () => {
  const { rows } = await db.query(
    `SELECT table_name || '.' || column_name AS c FROM information_schema.columns WHERE table_schema = current_schema()
      AND (table_name, column_name) IN (('books', 'description_fr'), ('books', 'categories_fr'), ('managed_genres', 'name_fr'), ('managed_genres', 'browse_label_fr'))`
  );
  assert.deepEqual(rows, []);
  assert.equal((await db.query("SELECT to_regclass('book_french_backup') IS NOT NULL AS t")).rows[0].t, true, "the backup table stays");
});

test("customer pages answer 200 (English and French)", async () => {
  const paths = [
    `/books/${bookId}`, `/fr/books/${bookId}`,
    "/books.html", "/fr/books.html", "/books.html?genre=mystery", "/fr/books.html?genre=mystery",
    "/api/books/search?genre=Mystery", "/api/books/search?genre=Mystery&lang=fr", "/api/books/search?q=English%20description&lang=fr",
    "/api/books/new-in", `/api/books/by-ids?ids=${bookId}`,
  ];
  if (collectionSlug) paths.push(`/collections/${collectionSlug}`, `/fr/collections/${collectionSlug}`, `/api/collections/${collectionSlug}/books`);
  for (const p of paths) assert.equal((await get(p)).status, 200, p);
  const fr = await get(`/fr/books/${bookId}`);
  assert.match(fr.text, /An English description\./);
  const search = JSON.parse((await get("/api/books/search?genre=Mystery&lang=fr")).text);
  assert.ok(search.some((b) => b.id === bookId), "the genre search finds the book");
});

test("admin pages answer 200: Genres, inventory list / search / CSV, scan, add, edit book, till", async () => {
  for (const p of [
    "/admin/genres",
    "/admin/inventory", "/admin/inventory?q=Dropped", "/admin/inventory?q=9780141439518",
    "/admin/inventory/export.csv", "/admin/inventory/export.csv?books=1",
    "/admin/inventory/scan", "/admin/inventory/new", `/admin/inventory/${bookId}`,
    "/admin/till", "/admin/till/day",
  ]) {
    const r = await get(p, adminJar);
    assert.equal(r.status, 200, `${p}: ${r.status}`);
  }
  assert.match((await get("/admin/inventory?q=Dropped", adminJar)).text, /Dropped Columns Book/);
  assert.match((await get("/admin/inventory/export.csv", adminJar)).text, /Dropped Columns Book/);
});
