// Phone polish on the rendered pages: print sheet link, colour-scheme meta, font preload,
// and srcset/sizes on covers (book page, "more by this author"). Port 4932 is reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");

const PORT = 4932;
let app;
let pool;
const stamp = Date.now();
const ids = {};
const hash = (c) => c.repeat(64);

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const add = async (key, title, cover) => {
    const { rows } = await pool.query("INSERT INTO books (title, authors, cover_url) VALUES ($1, $2, $3) RETURNING id", [`${title} ${stamp}`, `Polish Author ${stamp}`, cover]);
    await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 5, 'very_good')", [rows[0].id]);
    ids[key] = rows[0].id;
  };
  await add("main", "Main cover", `/img/${hash("b")}.jpg`);
  await add("sibling", "Sibling cover", `/img/${hash("c")}.jpg`);
  await add("external", "External cover", "https://covers.example.org/x.jpg");
});

after(async () => {
  await pool.query("DELETE FROM books WHERE title LIKE $1", [`% ${stamp}`]);
  await pool.end();
  app.stop();
});

const get = (p, lang) => fetch(`${app.base}${p}`, { headers: lang ? { cookie: `umasbooks_lang=${lang}` } : {} }).then((r) => r.text());
const head = (html) => html.slice(0, html.indexOf("</head>"));

for (const page of ["/", "/privacy-policy.html", "/books/PLACEHOLDER", "/login", "/cart", "/events"]) {
  test(`${page}: light colour scheme, print sheet, preloaded fonts, in English and French`, async () => {
    for (const lang of ["en", "fr"]) {
      const url = page.replace("PLACEHOLDER", ids.main);
      const html = head(await get(url, lang));
      assert.ok(html.includes('<meta name="color-scheme" content="light">'), `${url} ${lang}: color-scheme meta`);
      assert.match(html, /<link rel="stylesheet" href="\/print\.css\?v=[0-9a-f]+" media="print">/, `${url} ${lang}: print stylesheet`);
      assert.match(html, /<link rel="preload" href="\/assets\/fonts\/cormorant-garamond-normal-latin-500-700\.woff2" as="font" type="font\/woff2" crossorigin>/);
      assert.match(html, /<link rel="preload" href="\/assets\/fonts\/nunito-sans-normal-latin-400-600\.woff2" as="font" type="font\/woff2" crossorigin>/);
      assert.ok(!/viewport-fit/.test(html));
      // A preload must come before the stylesheet that would otherwise discover the font late.
      assert.ok(html.indexOf('rel="preload"') < html.indexOf('rel="stylesheet"'), `${url}: preload before the first stylesheet`);
    }
  });
}

test("the print sheet and the fonts are really served, and the fonts are cacheable", async () => {
  const css = await fetch(`${app.base}/print.css`);
  assert.equal(css.status, 200);
  assert.match(css.headers.get("content-type"), /css/);
  assert.match(await css.text(), /@media print/);
  const font = await fetch(`${app.base}/assets/fonts/cormorant-garamond-normal-latin-500-700.woff2`);
  assert.equal(font.status, 200);
  assert.match(font.headers.get("cache-control") || "", /max-age=\d{5,}/);
});

test("the book page: the cover and 'more by this author' cards carry srcset and sizes, an outside cover address gets none", async () => {
  const html = await get(`/books/${ids.main}`);
  const big = /<img src="\/img\/b{64}\.jpg" srcset="([^"]+)" sizes="([^"]+)"[^>]*class="book-detail-cover"/.exec(html);
  assert.ok(big, "the big cover has srcset + sizes");
  assert.equal(big[1], `/img/${hash("b")}-w300.jpg 300w, /img/${hash("b")}-w450.jpg 450w, /img/${hash("b")}.jpg 600w`);
  assert.match(big[2], /150px.*240px/);
  const card = /<img src="\/img\/c{64}\.jpg" srcset="([^"]+)" sizes="([^"]+)" alt="" class="book-card-cover" width="200" height="300"/.exec(html);
  assert.ok(card, "the sibling card has srcset + sizes");
  assert.match(card[1], new RegExp(`/img/${hash("c")}-w300\\.jpg 300w`));
  const ext = await get(`/books/${ids.external}`);
  assert.ok(!/example\.org/.test(ext.slice(ext.indexOf("<main"))), "an outside cover address is never printed in the page, so it gets no srcset either");
  assert.ok(!/class="book-detail-cover"[^>]*srcset|srcset="[^"]*class="book-detail-cover/.test(ext), "no big-cover srcset without a stored cover");
});

test("the API still returns the plain cover address (the pages add the sizes themselves)", async () => {
  const res = await fetch(`${app.base}/api/books/new-in?limit=100`);
  const list = await res.json();
  const mine = (Array.isArray(list) ? list : list.books || []).filter((b) => /Main cover|Sibling cover/.test(b.title));
  assert.ok(mine.length >= 1);
  for (const b of mine) assert.match(b.coverUrl, /^\/img\/[0-9a-f]{64}\.jpg$/);
});
