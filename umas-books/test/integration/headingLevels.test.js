// Heading levels (review item PH-21): a page that goes h1 -> h3 skips a level, which breaks the outline a screen-reader
// user navigates by. This renders every public page (English and French) and checks that no heading is more than one
// level deeper than the heading before it. Headings that the browser draws with JavaScript (the blog list, the events
// list) are not in the server's HTML, so the scripts that create them are checked from source instead.
//
// ALLOW holds the pages that are knowingly exempt, each with the reason. It is empty on purpose: add a line only with a
// reason a person can read.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startTestApp } = require("../helpers/testApp");

const PORT = 6142;
let app;
let pool;
let bookId;

// page -> reason (why a skipped level is accepted there)
const ALLOW = {};
// pages whose headings are all drawn by the browser, so the server's HTML has none (checked from source below)
const DRAWN_BY_SCRIPT = { "/blog.html": "the page and its list are drawn by assets/blog.js and public/page-blog.js" };

const PAGES = [
  "/", "/about.html", "/books.html", "/events.html", "/programs.html", "/immersion.html", "/membership.html", "/visit.html",
  "/volunteer.html", "/pre-registration.html", "/blog.html", "/privacy-policy.html", "/terms-of-sale.html", "/mentions-legales.html",
  "/membership-terms.html", "/sessions", "/events", "/contact", "/request-a-book", "/cart", "/login", "/signup", "/forgot-password",
  "/favorites", "/this-page-does-not-exist",
];

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const { rows } = await pool.query("INSERT INTO books (title, authors, description, categories) VALUES ('Heading Test Book', 'Jane Austen', 'A comedy of manners.', 'Fiction') RETURNING id");
  bookId = rows[0].id;
  await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 4.5, 'very_good')", [bookId]);
  // a second book by the same author so "More by ..." (an h2) shows
  const { rows: r2 } = await pool.query("INSERT INTO books (title, authors, categories) VALUES ('Heading Test Book Two', 'Jane Austen', 'Fiction') RETURNING id");
  await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 5, 'good')", [r2[0].id]);
});

after(async () => {
  await pool.query("DELETE FROM books WHERE title LIKE 'Heading Test Book%'");
  await pool.end();
  app.stop();
});

// [{ level, text }] in document order, outside <script>, <style>, <noscript> and HTML comments
function headings(html) {
  const body = html.replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  return [...body.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({ level: Number(m[1]), text: m[2].replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim().slice(0, 40) }));
}

// the problems in one list of headings: a jump of more than one level down, or a first heading that is not h1
function skips(list) {
  const out = [];
  let prev = 0;
  for (const h of list) {
    if (h.level > prev + 1) out.push(`h${prev || "(none)"} -> h${h.level} "${h.text}"`);
    prev = h.level;
  }
  return out;
}

test("the checker itself: it flags h1 -> h3 and accepts h1 -> h2 -> h3 and going back up", () => {
  assert.deepEqual(skips(headings("<h1>A</h1><h3>B</h3>")), ['h1 -> h3 "B"']);
  assert.deepEqual(skips(headings("<h1>A</h1><h2>B</h2><h3>C</h3><h2>D</h2><h3>E</h3>")), []);
  assert.deepEqual(skips(headings("<h2>No title</h2>")), ['h(none) -> h2 "No title"']);
  assert.deepEqual(skips(headings("<h1>A</h1><noscript><h4>x</h4></noscript><script>'<h5>'</script>")), []);
});

for (const lang of ["en", "fr"]) {
  test(`every public page (${lang}) has no skipped heading level`, async () => {
    const problems = [];
    for (const p of PAGES.concat(["BOOK"])) {
      const url = p === "BOOK" ? `/books/${bookId}` : p;
      const res = await fetch(`${app.base}${url}`, { headers: { cookie: `umasbooks_lang=${lang}` }, redirect: "follow" });
      const html = await res.text();
      if (ALLOW[url]) continue;
      const list = headings(html);
      if (DRAWN_BY_SCRIPT[url]) continue;
      assert.ok(list.length > 0, `${url} (${lang}) has headings at all (status ${res.status})`);
      for (const s of skips(list)) problems.push(`${url} (${lang}): ${s}`);
    }
    assert.deepEqual(problems, []);
  });
}

test("the book page's 'About this book' is an h2 drawn at the old h3 size", () => {
  const view = fs.readFileSync(path.join(__dirname, "..", "..", "views", "book_detail.ejs"), "utf8");
  assert.match(view, /<h2 class="book-about-title">/);
  assert.doesNotMatch(view, /<h3\b/);
  const css = fs.readFileSync(path.join(__dirname, "..", "..", "public", "style.css"), "utf8");
  assert.match(css, /\.book-about-title \{[^}]*font-size: 1\.17em/);
  assert.match(css, /\.as-h3 \{ font-size: 1\.17em; \}/);
});

test("headings made by the browser's scripts: blog cards are h2 (they sit right under the page's h1)", () => {
  const blog = fs.readFileSync(path.join(__dirname, "..", "..", "..", "assets", "blog.js"), "utf8");
  assert.match(blog, /<h2 class="blog-title">' \+ esc\(pick\(p\.title, l\)\) \+ '<\/h2>/);
  assert.doesNotMatch(blog, /blog-title">' \+ [^;]*<\/h3>/);
});

test("signed-in pages: the forum thread and the announcements list use h2 under their h1", () => {
  const views = path.join(__dirname, "..", "..", "views");
  const thread = fs.readFileSync(path.join(views, "forum_thread.ejs"), "utf8");
  assert.doesNotMatch(thread, /<h3\b/);
  assert.match(thread, /<h2 class="as-h3">/);
  const ann = fs.readFileSync(path.join(views, "announcements.ejs"), "utf8");
  assert.doesNotMatch(ann, /<h3\b/);
  assert.match(ann, /<h2><%= a\.title %><\/h2>/);
  const vol = fs.readFileSync(path.join(views, "marketing", "volunteer.ejs"), "utf8");
  assert.doesNotMatch(vol, /<h3\b/);
});
