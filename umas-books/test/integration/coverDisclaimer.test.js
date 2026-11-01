// The note "Cover images come from an online book library and may not show the actual condition of the copy in our
// shop" appears only for covers that really came from an online library (review 6B L4, lib/coverNote.js): never for
// the shop's own photo (cover_origin 'photo') or a book with no cover. Book page, its "More by" list, the cart, the
// favourites and the Browse / collection lists (the last three are drawn in the browser from the JSON's libraryCover).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");
const { isLibraryCover } = require("../../src/lib/coverNote");

const PORT = 3493;
const NOTE_EN = "Cover images come from an online book library and may not show the actual condition of the copy in our shop.";
const NOTE_FR = /Les couvertures proviennent d’une bibliothèque/;
let app, pool;
const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

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

// A book in stock: cover null (no cover), or a cover with its origin and source.
async function book({ cover = `/img/${"a".repeat(64)}.jpg`, origin = null, source = null, authors = `A ${uniq()}`, title = `Note Book ${uniq()}` } = {}) {
  const { rows: b } = await pool.query(
    "INSERT INTO books (title, authors, cover_url, cover_origin, cover_source_url) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [title, authors, cover, origin, source]);
  const { rows: c } = await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 5) RETURNING id", [b[0].id]);
  return { id: b[0].id, copyId: c[0].id, title };
}
const page = async (p, lang) => (await fetch(`${app.base}${p}`, { headers: lang ? { cookie: `umasbooks_lang=${lang}` } : {} })).text();
// The note as shown (not the hidden copy a page's script may reveal).
const shown = (html) => /<p class="cover-note" data-cover-note>/.test(html);

test("which covers count as online-library covers", () => {
  const c = "/img/x.jpg";
  assert.equal(isLibraryCover({ cover_url: c, cover_origin: "isbn" }), true);
  assert.equal(isLibraryCover({ cover_url: c, cover_origin: "chosen" }), true);
  assert.equal(isLibraryCover({ cover_url: c, cover_origin: "form" }), true);
  assert.equal(isLibraryCover({ cover_url: c, cover_origin: "photo", cover_source_url: "https://covers.openlibrary.org/b/id/1-L.jpg" }), false, "the own photo, even over an old library source");
  assert.equal(isLibraryCover({ cover_url: null, cover_origin: "isbn" }), false, "no cover");
  assert.equal(isLibraryCover({ cover_url: c, cover_origin: null, cover_source_url: "https://covers.openlibrary.org/b/id/1-L.jpg" }), true, "before origins were recorded: downloaded from a library");
  assert.equal(isLibraryCover({ cover_url: c, cover_origin: null, cover_source_url: null }), false);
});

test("book page: the note for a library cover (English and French), not for the shop's photo or no cover", async () => {
  const lib = await book({ origin: "isbn" });
  const html = await page(`/books/${lib.id}`);
  assert.ok(shown(html) && html.includes(NOTE_EN), html.slice(html.indexOf("book-detail-cover"), html.indexOf("book-detail-cover") + 900));
  const fr = await page(`/books/${lib.id}`, "fr");
  assert.match(fr, NOTE_FR);
  assert.ok(!fr.includes(NOTE_EN));
  const photo = await book({ origin: "photo" });
  assert.ok(!(await page(`/books/${photo.id}`)).includes(NOTE_EN), "own photo: no note");
  const none = await book({ cover: null });
  assert.ok(!(await page(`/books/${none.id}`)).includes(NOTE_EN), "no cover: no note");
});

test("book page 'More by': the note only when one of those covers came from a library", async () => {
  const authors = `Author ${uniq()}`;
  const main = await book({ origin: "photo", authors });
  await book({ origin: "photo", authors });
  assert.ok(!(await page(`/books/${main.id}`)).includes(NOTE_EN));
  await book({ origin: "chosen", authors });
  assert.ok((await page(`/books/${main.id}`)).includes(NOTE_EN));
});

test("cart: the note only when a book in it has a library cover", async () => {
  const jar = makeCookieJar();
  const add = async (copyId) => {
    const token = await fetchCsrfToken(app.base, jar);
    const res = await fetch(`${app.base}/cart/add`, {
      method: "POST", redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
      body: new URLSearchParams({ copyId: String(copyId), _csrf: token }).toString(),
    });
    jar.capture(res);
  };
  const cart = async () => (await fetch(`${app.base}/cart`, { headers: { cookie: jar.header() } })).text();
  await add((await book({ origin: "photo" })).copyId);
  let html = await cart();
  assert.ok(html.includes("Note Book"), "the book is in the cart");
  assert.ok(!html.includes(NOTE_EN));
  await add((await book({ origin: "isbn" })).copyId);
  html = await cart();
  assert.ok(shown(html));
});

test("favourites and Browse: the note is written hidden, and the JSON says which covers came from a library", async () => {
  const fav = await page("/favorites");
  assert.match(fav, /<p class="cover-note" data-cover-note hidden>/);
  const browse = await page("/books.html");
  assert.match(browse, /<p class="bk-covernote" data-i18n="bk.covernote" data-cover-note hidden>/);
  assert.match(browse, /"bk\.covernote":"Les couvertures proviennent/);
  const tag = `Flag${uniq()}`;
  const lib = await book({ origin: "isbn", title: `${tag} library` });
  const photo = await book({ origin: "photo", title: `${tag} photo` });
  const none = await book({ cover: null, title: `${tag} none` });
  const byIds = await (await fetch(`${app.base}/api/books/by-ids?ids=${lib.id},${photo.id},${none.id}`)).json();
  const flags = Object.fromEntries(byIds.map((b) => [b.id, b.libraryCover]));
  assert.deepEqual([flags[lib.id], flags[photo.id], flags[none.id]], [true, false, false]);
  const search = await (await fetch(`${app.base}/api/books/search?q=${tag}`)).json();
  assert.deepEqual(search.map((b) => [b.id, b.libraryCover]).sort((a, b) => a[0] - b[0]), [[lib.id, true], [photo.id, false], [none.id, false]]);
});

test("the pages' scripts show the note only for a library cover", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  for (const file of ["page-books.js", "favorites-page.js", "page-collection.js"]) {
    const src = fs.readFileSync(path.join(__dirname, "../../public", file), "utf8");
    assert.match(src, /\[data-cover-note\]/, `${file} finds the note`);
    assert.match(src, /libraryCover/, `${file} reads libraryCover`);
  }
});
