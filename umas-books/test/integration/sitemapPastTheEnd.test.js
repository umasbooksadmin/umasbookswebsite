// A sitemap file number past the last file is a 404 answered from the cached book count: no ORDER BY ... OFFSET scan
// per distinct number (an anonymous visitor could otherwise make the database scan for every ?n up to 999999).
// In-process, so the queries the route sends can be counted.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startInProcessApp } = require("../helpers/testApp");

let app;
const sql = [];

before(async () => {
  app = await startInProcessApp({ env: { APP_BASE_URL: "https://books.example.test", SITEMAP_BOOKS_PER_FILE: "3" } });
  for (let i = 0; i < 7; i++) {
    const { rows } = await app.pool.query("INSERT INTO books (title) VALUES ($1) RETURNING id", [`Past end ${i}`]);
    await app.pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 5)", [rows[0].id]);
  }
  const original = app.pool.query.bind(app.pool);
  app.pool.query = (text, ...rest) => { sql.push(typeof text === "string" ? text : (text && text.text) || ""); return original(text, ...rest); };
});
after(async () => { await app.stop(); });

const offsetScans = () => sql.filter((s) => /OFFSET/.test(s)).length;

test("files 1..3 (7 books, 3 per file) are served; the last holds one book", async () => {
  for (let n = 1; n <= 3; n++) assert.equal((await fetch(`${app.base}/sitemap-books-${n}.xml`)).status, 200, `file ${n}`);
  assert.equal(offsetScans(), 3);
});

test("file 4 and file 999999 are 404 with no OFFSET scan", async () => {
  const before = offsetScans();
  for (const n of [4, 5, 999999, 123456]) {
    const res = await fetch(`${app.base}/sitemap-books-${n}.xml`);
    assert.equal(res.status, 404, `file ${n}`);
  }
  assert.equal(offsetScans(), before, "no heavy query for a number past the end");
});

test("the number is still validated first: 0, leading zeros and 7 digits are 404 as before", async () => {
  for (const n of ["0", "01", "1000000"]) assert.equal((await fetch(`${app.base}/sitemap-books-${n}.xml`)).status, 404, n);
});
