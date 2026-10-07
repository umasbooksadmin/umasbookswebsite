// The public header after the second front-end review: a compact phone header
// whose nav is a <details> "Menu" (works without JavaScript, never hidden from
// keyboard users on a desktop), the one-line preview banner, the og:image choice
// (cover vs logo), the x-default hreflang, and the books.html no-JavaScript
// leftovers. Port 4287 is reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");

const PORT = 4287;
const SITE = "https://books.example.test";
process.env.APP_BASE_URL = SITE;

let app;
let pool;
const ids = {};
const stamp = Date.now();

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true, env: { PREVIEW_MODE: "true", APP_BASE_URL: SITE } });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const add = async (key, title, cover) => {
    const { rows } = await pool.query("INSERT INTO books (title, authors, cover_url) VALUES ($1, 'A. Writer', $2) RETURNING id", [`${title} ${stamp}`, cover]);
    await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 5, 'very_good')", [rows[0].id]);
    ids[key] = rows[0].id;
  };
  const hash = "a".repeat(64);
  await add("stored", "Stored cover", `/img/${hash}.jpg`);
  await add("external", "External cover", "https://covers.example.org/x.jpg");
  await add("none", "No cover", null);
});

after(async () => {
  await pool.query("DELETE FROM books WHERE title LIKE $1", [`% ${stamp}`]);
  await pool.end();
  app.stop();
});

const get = (p, lang) => fetch(`${app.base}${p}`, { headers: lang ? { cookie: `umasbooks_lang=${lang}` } : {} }).then((r) => r.text());
const meta = (html, name) => (html.match(new RegExp(`<meta property="${name}" content="([^"]*)"`)) || [])[1];
const header = (html) => html.slice(html.indexOf('<header class="mkt-header">'), html.indexOf("</header>"));

for (const [label, path] of [["app page (book)", () => `/books/${ids.stored}`], ["app page (cart)", () => "/cart"], ["marketing page (home)", () => "/"], ["marketing page (books.html)", () => "/books.html"]]) {
  test(`header on the ${label}: the nav is one <details> Menu with every link, none hidden from the keyboard`, async () => {
    for (const lang of ["en", "fr"]) {
      const head = header(await get(path(), lang));
      assert.match(head, /<nav class="h-nav" aria-label="[^"]+">\s*(<%#.*?%>)?\s*<details class="h-menu">\s*<summary class="h-menu-btn">/s, `${lang}: nav > details > summary`);
      const links = [...head.matchAll(/<a href="([^"]+)"[^>]*data-i18n="nav\.[a-z]+"/g)].map((m) => m[1]);
      assert.equal(links.length, 4, `${lang}: Home, Browse Books, English Programs, Events`);
      const nav = head.slice(head.indexOf('<nav class="h-nav"'), head.indexOf("</nav>")).replace(/<svg[\s\S]*?<\/svg>/g, ""); // the icon is decoration: aria-hidden is right there
      assert.doesNotMatch(nav, /aria-hidden|tabindex="-1"|\shidden[\s>]|display:\s*none|inert/, `${lang}: nothing in the nav is hidden from keyboard or screen reader users`);
      assert.doesNotMatch(nav, /<details[^>]*\sopen/, `${lang}: the server never renders the menu open (it is closed on phones before the page paints)`);
    }
    const html = await get(path());
    assert.match(html, /<\/header>\s*<script src="[^"]*site-menu\.js[^"]*"><\/script>/, "script right after the header: the closed state is set before the page below paints");
  });
}

test("French header: the Menu button, the nav links and the language toggle are all there", async () => {
  const head = header(await get("/", "fr"));
  assert.match(head, /Parcourir les livres/);
  assert.match(head, /<button type="button" data-lang="fr" class="is-active" aria-pressed="true">FR<\/button>/);
});

test("preview banner: a More / Less toggle (a <details>, no JavaScript needed), the full text and the feedback link", async () => {
  for (const lang of ["en", "fr"]) {
    const html = await get("/", lang);
    const banner = html.slice(html.indexOf('<div class="preview-banner"'), html.indexOf("</header>"));
    assert.match(banner, /<details class="pb-d"><summary class="pb-more">/);
    assert.match(banner, lang === "fr" ? />Plus</ : />More</);
    assert.match(banner, lang === "fr" ? />Moins</ : />Less</);
    assert.match(banner, /class="pb-text"/);
    assert.match(banner, /<a class="pb-link" href="\/contact\?topic=feedback"/);
    assert.ok(banner.indexOf('class="pb-d"') < banner.indexOf('class="pb-text"') && banner.indexOf('class="pb-text"') < banner.indexOf('class="pb-link"'), "details, then text, then link: the CSS sibling rules rely on this order");
  }
});

test("og:image on a book page: the stored cover (absolute URL), else the logo", async () => {
  const stored = await get(`/books/${ids.stored}`);
  assert.equal(meta(stored, "og:image"), `${SITE}/img/${"a".repeat(64)}.jpg`);
  assert.match(stored, /<meta name="twitter:card" content="summary">/);
  for (const key of ["external", "none"]) {
    const html = await get(`/books/${ids[key]}`);
    assert.equal(meta(html, "og:image"), `${SITE}/assets/img/logo-stamp-1280x720.png`, `${key} cover: the logo`);
    assert.match(html, /<meta name="twitter:card" content="summary_large_image">/);
  }
});

test("hreflang: only x-default (EN and FR share one URL), on app and marketing pages, none on a noindex page", async () => {
  for (const p of [`/books/${ids.stored}`, "/books.html", "/"]) {
    const html = await get(p);
    const canonical = (html.match(/<link rel="canonical" href="([^"]+)">/) || [])[1];
    assert.ok(canonical, `${p}: canonical`);
    assert.ok(html.includes(`<link rel="alternate" hreflang="x-default" href="${canonical}">`), `${p}: x-default points at the canonical URL`);
    assert.doesNotMatch(html, /hreflang="(en|fr)/, `${p}: no language pairs (one URL for both languages)`);
  }
  assert.doesNotMatch(await get("/login"), /hreflang/, "login is noindex: no canonical, no hreflang") ;
});

test("books.html without JavaScript: the script-filled sections are hidden by a <noscript> stylesheet", async () => {
  const html = await get("/books.html");
  assert.match(html, /<noscript><link rel="stylesheet" href="[^"]*books-nojs\.css[^"]*"><\/noscript>/);
  const css = await fetch(`${app.base}${(html.match(/href="([^"]*books-nojs\.css[^"]*)"/) || [])[1]}`).then((r) => r.text());
  for (const cls of ["bk-genres", "bk-rec", "bk-new", "bk-results"]) assert.match(css, new RegExp(`\\.${cls}\\b[^{]*\\{[^}]*display:\\s*none`), `${cls} hidden`);
  // The server-rendered list (inside <noscript>) is NOT among them.
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /bk-noscript/);
  assert.ok(html.includes('id="bk-genre-list"') && html.includes("Loading books"), "the sections the CSS hides do exist in the page (they are built by the script)");
});

test("French browse page: the genre chips are translated (Jeune adulte, Documentaires)", async () => {
  const html = await get("/books.html", "fr");
  const dict = JSON.parse(html.match(/<script type="application\/json" id="page-i18n-data">(.*?)<\/script>/s)[1]).fr;
  assert.equal(dict["g.ya"], "Jeune adulte");
  assert.equal(dict["g.nonfiction"], "Documentaires");
  assert.equal(dict["g.children"], "Jeunesse");
});

test("French book page: the favorite button's aria-label uses the curly apostrophe", async () => {
  await pool.query("UPDATE books SET title = $2 WHERE id = $1", [ids.none, `L'Étranger ${stamp}`]);
  const html = await get(`/books/${ids.none}`, "fr");
  assert.match(html, /aria-label="Ajouter L’Étranger \d+ aux favoris"/);
  const en = await get(`/books/${ids.none}`, "en");
  assert.match(en, /aria-label="Add L(&#39;|')Étranger \d+ to favorites"/, "English is untouched");
});
