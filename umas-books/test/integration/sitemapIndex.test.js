// The sitemap is an index (/sitemap.xml) of one pages file and N books files, newest books first, so a shop with more
// books than one file holds never stops listing its new books. SITEMAP_BOOKS_PER_FILE=3 makes the files small enough
// to test with a handful of books.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");

const PORT = 4721;
const SITE = "https://books.example.test";
const PER_FILE = 3;
const IN_STOCK_BOOKS = 8; // -> 3 files: 3 + 3 + 2
let app;
let pool;
const ids = []; // in-stock book ids, oldest first
let soldId;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true, env: { APP_BASE_URL: SITE, SITEMAP_BOOKS_PER_FILE: String(PER_FILE) } });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const mk = async (title, status, ageDays) => {
    const { rows } = await pool.query(
      "INSERT INTO books (title, created_at) VALUES ($1, now() - make_interval(days => $2::int)) RETURNING id", [title, ageDays]);
    await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, $2, 5)", [rows[0].id, status]);
    return rows[0].id;
  };
  for (let i = 0; i < IN_STOCK_BOOKS; i++) ids.push(await mk(`Index book ${i}`, "in_stock", IN_STOCK_BOOKS - i)); // last = newest
  soldId = await mk("Index sold", "sold", 0);
});

after(async () => {
  await pool.end();
  app.stop();
});

const get = (p) => fetch(`${app.base}${p}`);
const locsOf = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
const bookIdsOf = (xml) => locsOf(xml).filter((l) => l.startsWith(`${SITE}/books/`)).map((l) => Number(l.split("/").pop()));

test("the index lists the pages file and exactly as many books files as the in-stock books need", async () => {
  const res = await get("/sitemap.xml");
  assert.equal(res.status, 200);
  assert.deepEqual(locsOf(await res.text()), [
    `${SITE}/sitemap-pages.xml`, `${SITE}/sitemap-books-1.xml`, `${SITE}/sitemap-books-2.xml`, `${SITE}/sitemap-books-3.xml`,
  ]);
});

test("book files hold the newest books first, each in-stock book once, and the total is twice the in-stock books", async () => {
  const newestFirst = [...ids].reverse();
  const files = [];
  for (let n = 1; n <= 3; n++) {
    const res = await get(`/sitemap-books-${n}.xml`);
    assert.equal(res.status, 200, `file ${n}`);
    assert.match(res.headers.get("content-type"), /^application\/xml/);
    assert.match(res.headers.get("cache-control"), /max-age=3600/);
    files.push(await res.text());
  }
  assert.deepEqual(bookIdsOf(files[0]).filter((id, i, a) => a.indexOf(id) === i), newestFirst.slice(0, 3), "file 1 = the newest three");
  assert.ok(bookIdsOf(files[0]).includes(newestFirst[0]), "the newest book is in file 1");
  const all = files.flatMap((f) => bookIdsOf(f));
  assert.ok(!all.includes(soldId), "a sold book is not listed");
  assert.equal(all.length, IN_STOCK_BOOKS, "English addresses: one per in-stock book, none twice");
  assert.equal(new Set(all).size, IN_STOCK_BOOKS);
  const urlCount = files.reduce((n, f) => n + (f.match(/<url>/g) || []).length, 0);
  assert.equal(urlCount, IN_STOCK_BOOKS * 2, "English and French address for every in-stock book");
  assert.equal((files[2].match(/<url>/g) || []).length, 2 * 2, "the last file holds the remaining two books");
  assert.ok(files[0].includes(`hreflang="fr" href="${SITE}/fr/books/${newestFirst[0]}"`), "hreflang alternates kept");
});

test("the pages file lists the static pages but no book", async () => {
  const xml = await (await get("/sitemap-pages.xml")).text();
  assert.match(xml, /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9" xmlns:xhtml=/);
  assert.ok(locsOf(xml).includes(`${SITE}/sessions`));
  assert.ok(locsOf(xml).includes(`${SITE}/fr/events`));
  assert.deepEqual(bookIdsOf(xml), []);
});

test("a books file that does not exist is a 404", async () => {
  for (const p of ["/sitemap-books-4.xml", "/sitemap-books-0.xml", "/sitemap-books-01.xml", "/sitemap-books-abc.xml", "/sitemap-books--1.xml", "/sitemap-books-99999999.xml"]) {
    assert.equal((await get(p)).status, 404, p);
  }
});

test("robots.txt still points at /sitemap.xml", async () => {
  assert.match(await (await get("/robots.txt")).text(), new RegExp(`^Sitemap: ${SITE}/sitemap\\.xml$`, "m"));
});
