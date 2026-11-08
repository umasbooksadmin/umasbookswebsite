// "Children's Fiction" with a capital F everywhere (Sharon, 2026-11-08), through the REAL app and database. Production had the
// managed genre spelled "Children's fiction" (and so the books): the data is put in that state, migration 119 is run on it, and
// then the Browse genre button, a book's genre, the Admin > Genres list and the genre search (including an old link with another
// capital or a curly apostrophe) are read over HTTP. Port 6498 is reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar } = require("../helpers/httpClient");
const { createAccount, loginOverHttp } = require("../helpers/accounts");

const PORT = 6498;
const SQL = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "119_childrens_fiction_spelling.sql"), "utf8");
let app;
let db;
let jar;
let bookId;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  db = new Client({ connectionString: app.databaseUrl, ssl: false });
  await db.connect();
  // production's state: the managed genre and the Browse label with a lower-case f, a book with the lower-case genre in stock
  await db.query("UPDATE managed_genres SET name_en = 'Children''s fiction', browse_label_en = 'Children’s fiction' WHERE browse_slug = 'children'");
  const { rows: [b] } = await db.query("INSERT INTO books (title, authors, description, categories) VALUES ('The Gruffalo Test', 'Julia D', 'A mouse.', 'Children''s fiction, Poetry') RETURNING id");
  bookId = b.id;
  await db.query("INSERT INTO book_copies (book_id, condition, price, status) VALUES ($1, 'good', 4.00, 'in_stock')", [bookId]);
  const { rows: [n] } = await db.query("INSERT INTO books (title, authors, description, categories) VALUES ('Not a kids book', 'Someone', 'Dry.', 'Nonfiction') RETURNING id");
  await db.query("INSERT INTO book_copies (book_id, condition, price, status) VALUES ($1, 'good', 3.00, 'in_stock')", [n.id]);
  const admin = await createAccount({ query: (s, p) => db.query(s, p) }, { email: "childfic-admin@example.test", displayName: "CF Admin" });
  await db.query("UPDATE users SET is_admin = true WHERE id = $1", [admin.id]);
  jar = makeCookieJar();
  assert.equal((await loginOverHttp(app.base, jar, admin)).status, 302);
});
after(async () => { await db.end(); app.stop(); });

const q = async (sql, params) => (await db.query(sql, params)).rows;
const unescape = (s) => s.replace(/&amp;/g, "&").replace(/&#39;/g, "'").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
const getText = async (p, cookie) => (await fetch(`${app.base}${p}`, { redirect: "manual", headers: cookie ? { cookie } : {} })).text();
const search = async (genre) => (await (await fetch(`${app.base}/api/books/search?genre=${encodeURIComponent(genre)}`)).json());
const titles = (r) => (Array.isArray(r) ? r : r.books || r.results || []).map((b) => b.title).sort();

test("the data starts in production's state (lower-case f), as the old spelling", async () => {
  assert.equal((await q("SELECT name_en FROM managed_genres WHERE browse_slug = 'children'"))[0].name_en, "Children's fiction");
  assert.equal((await q("SELECT categories FROM books WHERE id = $1", [bookId]))[0].categories, "Children's fiction, Poetry");
});

test("after migration 119: the managed genre, the book and the Browse button say Children's Fiction", async () => {
  await db.query(SQL);
  assert.equal((await q("SELECT name_en, browse_slug FROM managed_genres WHERE browse_slug = 'children'"))[0].name_en, "Children's Fiction");
  assert.equal((await q("SELECT categories FROM books WHERE id = $1", [bookId]))[0].categories, "Children's Fiction, Poetry");

  // the Browse genre button (its label is the one an admin typed with the old spelling: respelled)
  const browse = await getText("/books.html");
  const track = browse.match(/id="bk-genre-list"[^>]*>([\s\S]*?)<\/section>/)[1];
  const labels = [...track.matchAll(/<span data-i18n="g\.([a-z0-9-]+)"[^>]*>([^<]*)<\/span>/g)].map((m) => [m[1], unescape(m[2])]);
  assert.deepEqual(labels.find((l) => l[0] === "children"), ["children", "Children's Fiction"]);
  assert.ok(!/Children(?:'|&#39;|’)s fiction/.test(track), "no lower-case spelling left in the genre buttons");
  // the button's slug is unchanged: old links keep working
  assert.match(track, /data-slug="children"/);

  // the book's page shows its genre
  const page = await getText(`/books/${bookId}`);
  assert.match(page, /book-detail-kicker">[^<]*Children(?:'|&#39;|’)s Fiction, Poetry/);
  assert.ok(!/Children(?:'|&#39;|’)s fiction/.test(page));
  const fr = await getText(`/fr/books/${bookId}`);
  assert.match(fr, /Children(?:'|&#39;|’|&#8217;)s Fiction/, "genre names are English on the French site too");
});

test("Admin > Genres lists Children's Fiction (managed list and Found genres), never the lower-case spelling", async () => {
  const html = await getText("/admin/genres", jar.header());
  const managed = [...html.matchAll(/<input form="mg-\d+" name="nameEn" value="([^"]*)"/g)].map((m) => unescape(m[1]));
  assert.ok(managed.includes("Children's Fiction"), managed.join(" | "));
  assert.ok(!managed.some((n) => n === "Children's fiction"));
  assert.ok(!/Children(?:'|&#39;|’)s fiction/.test(html), "nowhere on the page");
  assert.match(html, /Children(?:'|&#39;|’)s Fiction/);
});

test("the genre search finds the book for the right spelling and for old links (any capitals, curly apostrophe)", async () => {
  for (const g of ["Children's Fiction", "children's fiction", "Children's fiction", "CHILDREN'S FICTION", "Children’s fiction", "children’s Fiction"]) {
    assert.deepEqual(titles(await search(g)), ["The Gruffalo Test"], g);
  }
  assert.deepEqual(titles(await search("Nonfiction")), ["Not a kids book"]);
});

test("an incoming Children's fiction (a source, a phone) is spelled Children's Fiction even if the managed name were lower-case again", async () => {
  await db.query("UPDATE managed_genres SET name_en = 'Children''s fiction' WHERE browse_slug = 'children'");
  try {
    const { buildKnown, canonicalGenres } = require("../../src/lib/genreClean");
    const known = buildKnown({ common: [], managed: await q("SELECT name_en FROM managed_genres") });
    assert.equal(canonicalGenres("children’s fiction, Poetry", known), "Children's Fiction, Poetry");
  } finally {
    await db.query("UPDATE managed_genres SET name_en = 'Children''s Fiction' WHERE browse_slug = 'children'");
  }
});
