// Alphabetical order ignores a leading "The" (migration 086, books.title_sort),
// against the real SQL: the public search API (/api/books/search), "More by
// this author" on the book page, and the admin Inventory list. The titles
// shown are never changed. Also the migration itself (re-runs cleanly, follows
// title edits) and that the JavaScript twin (src/lib/titleSort.js) orders the
// same titles the same way as the database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");

const db = prepareDatabase("title_sort", { isolated: true });
const { pool } = require("../../src/db");
const { compareTitles } = require("../../src/lib/titleSort");

const ROOT = path.join(__dirname, "..", "..");
const AUTHOR = "Sort Author";
// Inserted in a scrambled order on purpose.
const TITLES = [
  "Theory of Everything", "The Hobbit", "Roads", "Hunger Games", "The Road", "a tale", "The  Great Gatsby",
  "Hamlet", "THE END", '"The Road"', "1984", "The 39 Steps", "The", "Theodore Rex",
];
const EXPECTED = [
  "1984", "The 39 Steps", "a tale", "THE END", "The  Great Gatsby", "Hamlet", "The Hobbit", "Hunger Games",
  "The Road", '"The Road"', "Roads", "The", "Theodore Rex", "Theory of Everything",
];

let server;
const ids = {};
before(async () => {
  db.create();
  server = await listen(buildApp([require("../../src/routes/books"), require("../../src/routes/admin/inventory")]));
  for (const title of TITLES) {
    const { rows } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, $2) RETURNING id", [title, AUTHOR]);
    ids[title] = rows[0].id;
    await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 5, 'good')", [rows[0].id]);
  }
});
after(async () => {
  await server.close();
  await pool.end();
  db.drop();
});

const admin = { id: 1, email: "a@example.test", displayName: "Admin", isAdmin: true, isMember: false, isVolunteer: false };

test("catalogue search (/api/books/search): The is ignored, titles are shown as they are", async () => {
  const res = await fetch(`${server.base}/api/books/search`);
  const books = await res.json();
  assert.deepEqual(books.map((b) => b.title), EXPECTED);
});

test("catalogue search with a text filter keeps the same order", async () => {
  const books = await (await fetch(`${server.base}/api/books/search?q=${encodeURIComponent("ro")}`)).json();
  const got = books.map((b) => b.title);
  assert.deepEqual(got, EXPECTED.filter((t) => /ro/i.test(t)));
  assert.ok(got.indexOf("The Road") < got.indexOf("Roads"));
});

test("More by this author (6 books, never the book itself) is in the same order", async () => {
  const html = await (await fetch(`${server.base}/books/${ids["Hamlet"]}`)).text();
  const more = html.slice(html.indexOf("More by"));
  const shown = [...more.matchAll(/<a class="book-card" href="\/books\/(\d+)"/g)].map((m) => Number(m[1]));
  const byId = new Map(Object.entries(ids).map(([t, id]) => [id, t]));
  assert.deepEqual(shown.map((id) => byId.get(id)), EXPECTED.filter((t) => t !== "Hamlet").slice(0, 6));
});

test("admin Inventory list (/admin/inventory) is in the same order", async () => {
  const res = await fetch(`${server.base}/admin/inventory`, { headers: { "x-test-user": JSON.stringify(admin) } });
  assert.equal(res.status, 200);
  const html = await res.text();
  // Each book's detail link appears once per row, in list order.
  const linked = [...html.matchAll(/href="\/admin\/inventory\/(\d+)"/g)].map((m) => Number(m[1]));
  const seen = [...new Set(linked)];
  const byId = new Map(Object.entries(ids).map(([t, id]) => [id, t]));
  assert.deepEqual(seen.map((id) => byId.get(id)), EXPECTED);
});

test("the JavaScript helper orders these titles the same way as the database", async () => {
  const { rows } = await pool.query("SELECT title FROM books ORDER BY title_sort, title, id");
  const js = TITLES.slice().sort(compareTitles);
  assert.deepEqual(rows.map((r) => r.title), js);
});

test("title_sort follows a title edit, and the shown title is unchanged", async () => {
  const id = ids["Hamlet"];
  await pool.query("UPDATE books SET title = 'The Zebra Book' WHERE id = $1", [id]);
  const { rows } = await pool.query("SELECT title, title_sort FROM books WHERE id = $1", [id]);
  assert.deepEqual(rows[0], { title: "The Zebra Book", title_sort: "zebra book" });
  await pool.query("UPDATE books SET title = 'Hamlet' WHERE id = $1", [id]);
});

test("migration 086 re-runs cleanly and leaves the keys alone", async () => {
  const before = (await pool.query("SELECT id, title_sort FROM books ORDER BY id")).rows;
  await pool.query("DELETE FROM schema_migrations WHERE filename = '086_books_title_sort.sql'");
  execFileSync("node", ["src/migrate.js"], { cwd: ROOT, env: { ...process.env, PGSSLMODE: "disable" }, encoding: "utf8" });
  assert.deepEqual((await pool.query("SELECT id, title_sort FROM books ORDER BY id")).rows, before);
  const idx = await pool.query("SELECT 1 FROM pg_indexes WHERE indexname = 'idx_books_title_sort'");
  assert.equal(idx.rowCount, 1);
});
