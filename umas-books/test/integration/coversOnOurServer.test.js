// Covers are shown from our own server only: no page's CSP lists Open Library or
// the Internet Archive, no rendered page or JSON answer carries their addresses,
// and every cover <img> reserves its space (width/height, aspect ratio) so the
// page does not jump, loads lazily in lists, and falls back without an inline
// onerror attribute. Real app, real database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { startTestApp } = require("../helpers/testApp");

const ROOT = path.join(__dirname, "..", "..");
const PORT = 3913;
let app, pool;
const STORED = `/img/${"1".repeat(64)}.jpg`;
const STORED2 = `/img/${"2".repeat(64)}.jpg`;
const EXTERNAL = "https://covers.openlibrary.org/b/id/999-L.jpg";
const get = async (p, headers) => fetch(`${app.base}${p}`, { headers });

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});
after(async () => {
  await pool.end();
  await app.stop();
});

async function makeBook(title, cover, authors = "Cover Author") {
  const { rows } = await pool.query("INSERT INTO books (title, authors, cover_url) VALUES ($1, $2, $3) RETURNING id", [title, authors, cover]);
  await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 5)", [rows[0].id]);
  return rows[0].id;
}

test("no page's Content-Security-Policy lists an external image host", async () => {
  const id = await makeBook("CSP Book", STORED);
  for (const p of ["/login", "/signup", "/contact", "/cart", `/books/${id}`, "/books.html", "/", "/membership.html", "/pre-registration.html", "/privacy-policy.html"]) {
    const res = await get(p);
    const csp = res.headers.get("content-security-policy");
    assert.ok(csp, `${p} has a CSP`);
    assert.match(csp, /img-src 'self' data:(;|$)/, p);
    assert.doesNotMatch(csp, /openlibrary|archive\.org/i, p);
  }
});

test("a book page shows our copy of the cover with reserved space, high priority; related covers are lazy", async () => {
  const author = `Author ${Date.now()}`;
  const id = await makeBook("Detail Book", STORED, author);
  await makeBook("Sibling Book", STORED2, author);
  const html = await (await get(`/books/${id}`)).text();
  const main = /<img src="\/img\/1{64}\.jpg"[^>]*class="book-detail-cover"[^>]*>/.exec(html);
  assert.ok(main, "the detail cover is rendered");
  assert.match(main[0], /width="240" height="360"/);
  assert.match(main[0], /fetchpriority="high"/);
  assert.doesNotMatch(main[0], /loading="lazy"/, "the main image is never lazy");
  assert.match(main[0], /data-cover/);
  const card = /<img src="\/img\/2{64}\.jpg"[^>]*class="book-card-cover"[^>]*>/.exec(html);
  assert.ok(card, "the related book's cover is rendered");
  assert.match(card[0], /width="200" height="300"/);
  assert.match(card[0], /loading="lazy"/);
  assert.doesNotMatch(html, /onerror=/i, "no inline handler (the CSP would block it)");
});

test("a leftover external cover address is never printed: the page shows the neutral placeholder box", async () => {
  const id = await makeBook("Legacy Cover Book", EXTERNAL);
  const html = await (await get(`/books/${id}`)).text();
  assert.doesNotMatch(html, /openlibrary|archive\.org/);
  assert.match(html, /class="book-detail-cover book-thumb-placeholder"/);
});

test("JSON answers (search, new in) never carry an external cover address", async () => {
  const id = await makeBook("JSON Cover Legacy", EXTERNAL);
  await makeBook("JSON Cover Stored", STORED);
  const search = await (await get("/api/books/search?q=JSON%20Cover")).json();
  assert.ok(search.length >= 2);
  const legacy = search.find((b) => b.id === id);
  assert.equal(legacy.coverUrl, null);
  assert.ok(search.some((b) => b.coverUrl === STORED));
  assert.ok(!JSON.stringify(search).match(/openlibrary|archive\.org/));
  const latest = await (await get("/api/books/new-in?limit=50")).text();
  assert.doesNotMatch(latest, /openlibrary|archive\.org/);
});

// ---- static checks of the sources ----

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
  e.name === "node_modules" ? [] : e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const read = (f) => fs.readFileSync(f, "utf8");

test("no view, script or stylesheet loads an image from Open Library or the Internet Archive", () => {
  const files = [
    ...walk(path.join(ROOT, "views")), ...walk(path.join(ROOT, "public")), ...walk(path.join(ROOT, "..", "assets")),
  ].filter((f) => /\.(ejs|js|css|html)$/.test(f));
  const offenders = files.filter((f) => /openlibrary\.org|archive\.org/i.test(read(f))).map((f) => path.relative(ROOT, f));
  assert.deepEqual(offenders, []);
  // The server side only mentions them in the lookup/download libraries and the allow-list.
  const srcOffenders = walk(path.join(ROOT, "src")).filter((f) => /openlibrary\.org|archive\.org/i.test(read(f))).map((f) => path.relative(ROOT, f)).sort();
  assert.deepEqual(srcOffenders, ["src/lib/bookLookup.js", "src/lib/bookSources.js", "src/lib/coverStore.js"]);
});

test("every cover <img> in the views and public scripts has width, height, an aspect ratio class and a fallback hook", () => {
  // A cover <img> is on one source line (in the JS files it is a string literal inside a longer line).
  const COVER_LINE = /<img\b.*(?:book-detail-cover|book-card-cover|cart-item-cover|book-thumb|class="cover")/;
  const files = [
    path.join(ROOT, "views", "book_detail.ejs"), path.join(ROOT, "views", "cart.ejs"), path.join(ROOT, "views", "admin", "inventory", "index.ejs"),
    path.join(ROOT, "public", "ui.js"),
  ];
  let n = 0;
  for (const f of files) {
    for (const line of read(f).split("\n").filter((l) => COVER_LINE.test(l))) {
      n++;
      assert.match(line, /\bwidth=\\?"\d+/, `${path.basename(f)}: width in ${line.trim()}`);
      assert.match(line, /\bheight=\\?"\d+/, `${path.basename(f)}: height in ${line.trim()}`);
      assert.match(line, /data-cover/, `${path.basename(f)}: fallback hook in ${line.trim()}`);
    }
  }
  assert.ok(n >= 6, `found ${n} cover images`);
  // Lists load lazily; the one main image does not.
  assert.match(read(path.join(ROOT, "public", "ui.js")), /class="cover" src="' \+ esc\(b\.coverUrl\) \+ '"' \+ coverAttrs\(b\.coverUrl, (?:'[^']+'|COVER_SIZES)\) \+ ' alt="" width="200" height="300" loading="lazy"/);
  assert.match(read(path.join(ROOT, "public", "ui.js")), /class="book-card-cover" width="200" height="300" loading="lazy"/);
});

test("cover CSS reserves a 2:3 box and a neutral background; failed loads are handled by an external script, not onerror", () => {
  const css = read(path.join(ROOT, "public", "style.css"));
  assert.match(css, /\.book-detail-cover \{[^}]*aspect-ratio: 2 \/ 3/);
  assert.match(css, /\.book-card-cover \{[^}]*aspect-ratio: 2 \/ 3/);
  assert.match(css, /\.cart-item-cover \{[^}]*aspect-ratio: 2 \/ 3/);
  assert.match(css, /\.cover-missing \{/);
  assert.match(read(path.join(ROOT, "public", "app.js")), /document\.addEventListener\("error"[\s\S]*?, true\)/, "capture-phase error listener");
  for (const f of [...walk(path.join(ROOT, "views")), ...walk(path.join(ROOT, "public")), ...walk(path.join(ROOT, "..", "assets"))].filter((x) => /\.(ejs|js)$/.test(x))) {
    assert.doesNotMatch(read(f), /\bonerror\s*=\s*["']/i, `${path.relative(ROOT, f)} has an inline onerror`);
  }
});

test("covers are shown whole: no object-fit: cover, and height:auto so the height=300 attribute cannot override the 2:3 box", () => {
  const rule = (css, sel) => {
    const m = new RegExp(`(?:^|\\n)${sel.replace(/[.]/g, "\\.")} \\{([^}]*)\\}`).exec(css);
    assert.ok(m, `${sel} rule not found`);
    return m[1];
  };
  const books = read(path.join(ROOT, "..", "assets", "books.css"));
  const style = read(path.join(ROOT, "public", "style.css"));
  const checks = [[books, ".bk-book .cover"], [style, ".book-card-cover"], [style, ".book-detail-cover"], [style, ".cart-item-cover"]];
  for (const [css, sel] of checks) {
    const body = rule(css, sel);
    assert.match(body, /object-fit: contain/, `${sel} must use object-fit: contain`);
    assert.doesNotMatch(body, /object-fit: cover/, `${sel} must not crop`);
    assert.match(body, /aspect-ratio: 2 \/ 3/, `${sel} keeps its 2:3 box`);
  }
  // These imgs carry height="300"; without height:auto that attribute wins over aspect-ratio.
  assert.match(rule(books, ".bk-book .cover"), /height: auto/);
});
