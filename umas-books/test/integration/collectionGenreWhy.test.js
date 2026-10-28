/* global document, window */
// The customer collection page shows, under each book, its genre and the AI's "why it's here" line (lib/collections.js
// bookExtras). Real app, throwaway database:
//   - English page: the genre as stored, then the English reason on its own (no "Why it’s here:" label, owner's choice)
//   - French page: the ENGLISH genre (books have English genres only since 2026-10-28, as on the book page; marked
//     lang="en"), the French reason on its own (no label),
//     and NEVER the English reason: a reason with no French yet hides the line
//   - a book added by hand (reason "Added by hand", an admin note) shows its genre only, in both languages
//   - the API (?lang=en|fr) gives the same genre and why as the page, so "Show more" prints what the page prints
//   - every text is escaped on the page and, in a real browser, in the cards "Show more" draws
//   - in headless Chrome: the lines drawn by "Show more" are the same HTML as the server's, in English and French

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");

const PORT = 6484;
let app;
let pool;
let browser;
let skipReason = null;

const HOSTILE = '<img src=x onerror="window.__xss=1">';

async function newBook(title, categories, { categoriesFr = null } = {}) {
  const { rows } = await pool.query(
    "INSERT INTO books (title, authors, categories, categories_fr, description) VALUES ($1, 'Some Author', $2, $3, 'x') RETURNING id",
    [title, categories, categoriesFr]
  );
  await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 7, 'good')", [rows[0].id]);
  return rows[0].id;
}

async function newShelf(slug, rows) {
  const { rows: c } = await pool.query(
    `INSERT INTO curated_collections (slug, title_en, description_en, title_fr, description_fr, curation_prompt, published)
     VALUES ($1, 'Why Shelf', 'Books with reasons.', 'Étagère pourquoi', 'Des livres et leurs raisons.', 'x', TRUE) RETURNING id`,
    [slug]
  );
  let pos = 1;
  for (const r of rows) {
    await pool.query(
      "INSERT INTO curated_collection_books (collection_id, book_id, status, reason, reason_fr, position) VALUES ($1, $2, 'approved', $3, $4, $5)",
      [c[0].id, r.id, r.reason, r.reasonFr ?? null, pos++]
    );
  }
  return c[0].id;
}

let ids = {};
before(async () => {
  try {
    browser = await require("puppeteer").launch({ headless: true, args: ["--no-sandbox"] });
  } catch (err) {
    skipReason = `no headless Chrome available: ${String(err.message).split("\n")[0]}`;
  }
  app = await startTestApp({ port: PORT, isolated: true, env: { ANTHROPIC_API_KEY: "", ANON_SESSION_LIMIT: "100000" } });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  ids = {
    both: await newBook("A Both Languages Book", "Mystery, Science Fiction"),
    enOnly: await newBook("B English Only Book", "Romance"),
    hand: await newBook("C Hand Added Book", "Thriller"),
    noGenre: await newBook("D No Genre Book", ""),
    hostile: await newBook("E Hostile Book", `Fantasy, ${HOSTILE}`),
  };
  await newShelf("why-shelf", [
    { id: ids.both, reason: "A clever puzzle set in a rainy Paris.", reasonFr: "Une énigme astucieuse dans un Paris pluvieux." },
    { id: ids.enOnly, reason: "A sweet love story across the Channel." },
    { id: ids.hand, reason: "Added by hand" },
    { id: ids.noGenre, reason: "Quiet and kind.", reasonFr: "Calme et bienveillant." },
    { id: ids.hostile, reason: `Brave ${HOSTILE} & bold.`, reasonFr: `Courageux ${HOSTILE} & audacieux.` },
  ]);
  // The hand-added book also goes through the real "add by hand" (lib/collections.js addBookByHand).
  const { rows } = await pool.query("SELECT id FROM curated_collections WHERE slug = 'why-shelf'");
  const { addBookByHand } = require("../../src/lib/collections");
  ids.handReal = await newBook("F Really Hand Added", "Horror");
  assert.equal((await addBookByHand(pool, rows[0].id, ids.handReal)).ok, true);
});

after(async () => {
  if (browser) await browser.close();
  if (pool) await pool.end();
  if (app) await app.stop();
});

const get = (p) => fetch(`${app.base}${p}`);
const html = async (p) => (await get(p)).text();
// The .col-item of one book in the page's HTML (its card and the lines under it).
const item = (t, id) => {
  const m = new RegExp(`<div class="col-item"><div class="bk-book">(?:(?!<div class="col-item">)[\\s\\S])*?href="/(?:fr/)?books/${id}"(?:(?!<div class="col-item">|<div class="bk-more-row">)[\\s\\S])*`).exec(t);
  assert.ok(m, `book ${id} is on the page`);
  return m[0];
};
const api = async (q) => (await (await get(`/api/collections/why-shelf/books${q}`)).json()).books;

test("English page: the genre and the English reason under each book", async () => {
  const t = await html("/collections/why-shelf");
  assert.match(item(t, ids.both), /<div class="col-more"><p class="col-genre">Mystery, Science Fiction<\/p><p class="col-why">A clever puzzle set in a rainy Paris\.<\/p><\/div><\/div>/);
  assert.match(item(t, ids.enOnly), /<p class="col-genre">Romance<\/p><p class="col-why">A sweet love story across the Channel\.<\/p>/);
  assert.match(item(t, ids.noGenre), /<div class="col-more"><p class="col-why">/, "no genre: no genre line");
  assert.ok(!item(t, ids.noGenre).includes("col-genre"));
  assert.ok(!/Why it(’|'|&#39;)s here/.test(t) && !t.includes("col-why-label"), "the reason has no label (owner's choice)");
});

test("French page: the English genre (lang=en) and the French reason; a reason without French is hidden, never shown in English", async () => {
  const t = await html("/fr/collections/why-shelf");
  assert.match(item(t, ids.both), new RegExp(`<p class="col-genre" lang="en">Mystery, Science Fiction</p><p class="col-why">Une énigme astucieuse dans un Paris pluvieux\\.</p>`));
  // no French reason yet: the genre only
  assert.match(item(t, ids.enOnly), /<div class="col-more"><p class="col-genre" lang="en">Romance<\/p><\/div><\/div>/);
  assert.ok(!item(t, ids.enOnly).includes("col-why"));
  // (the page's script dictionary carries both languages, as on Browse: only what the page prints counts)
  const printed = t.replace(/<script[\s\S]*?<\/script>/g, "");
  for (const en of ["A clever puzzle", "A sweet love story", "Quiet and kind", "Brave ", "Why it’s here", "Why it's here", "Added by hand"]) {
    assert.ok(!printed.includes(en), `English "${en}" on the French page`);
  }
  assert.match(item(t, ids.noGenre), /<div class="col-more"><p class="col-why">Calme et bienveillant\.<\/p><\/div>/);
  assert.ok(!t.includes("Pourquoi ce livre") && !t.includes("col-why-label"), "the reason has no label (owner's choice)");
});

test("a book added by hand shows its genre only (EN and FR): its 'Added by hand' note is for the admin", async () => {
  for (const prefix of ["", "/fr"]) {
    const t = await html(`${prefix}/collections/why-shelf`);
    for (const id of [ids.hand, ids.handReal]) {
      const it = item(t, id);
      assert.match(it, /<div class="col-more"><p class="col-genre"(?: lang="en")?>[^<]+<\/p><\/div><\/div>/, `${prefix || "/"} book ${id}: genre only`);
      assert.ok(!it.includes("col-why"));
    }
    assert.ok(!t.includes("Added by hand"));
  }
  assert.match(item(await html("/fr/collections/why-shelf"), ids.hand), /<p class="col-genre" lang="en">Thriller<\/p>/);
  assert.match(item(await html("/fr/collections/why-shelf"), ids.handReal), /<p class="col-genre" lang="en">Horror<\/p>/, "the English genre, never a French one");
});

test("every text is escaped on the page (a genre or a reason cannot add markup)", async () => {
  for (const prefix of ["", "/fr"]) {
    const t = await html(`${prefix}/collections/why-shelf`);
    assert.ok(!t.includes(HOSTILE) && !t.includes("<img src=x"), `${prefix || "/"}: raw markup from the data`);
    assert.match(item(t, ids.hostile), /&lt;img src=x onerror=&#34;window\.__xss=1&#34;&gt;/);
  }
});

test("API: ?lang=en and ?lang=fr give the same genre and why as the page; no ?lang is English; no French reason is why null", async () => {
  const en = await api("?offset=0&limit=48&lang=en");
  const fr = await api("?offset=0&limit=48&lang=fr");
  const plain = await api("?offset=0&limit=48");
  assert.deepEqual(plain, en);
  const by = (list) => Object.fromEntries(list.map((b) => [b.id, { genre: b.genre, why: b.why }]));
  const E = by(en);
  const F = by(fr);
  assert.deepEqual(E[ids.both], { genre: "Mystery, Science Fiction", why: "A clever puzzle set in a rainy Paris." });
  assert.deepEqual(F[ids.both], { genre: "Mystery, Science Fiction", why: "Une énigme astucieuse dans un Paris pluvieux." });
  assert.deepEqual(E[ids.enOnly], { genre: "Romance", why: "A sweet love story across the Channel." });
  assert.deepEqual(F[ids.enOnly], { genre: "Romance", why: null }, "no French: no why, never the English");
  assert.deepEqual(E[ids.hand], { genre: "Thriller", why: null });
  assert.deepEqual(F[ids.handReal], { genre: "Horror", why: null });
  assert.deepEqual(E[ids.noGenre], { genre: null, why: "Quiet and kind." });
  assert.equal(E[ids.hostile].why, `Brave ${HOSTILE} & bold.`, "JSON carries the text as it is; the page script escapes it");
  // the page prints exactly the API's words (the first 24 and the next ones say the same)
  const page = { en: await html("/collections/why-shelf"), fr: await html("/fr/collections/why-shelf") };
  const unesc = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#34;/g, '"').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
  for (const [lang, list] of [["en", en], ["fr", fr]]) {
    for (const b of list) {
      const it = item(page[lang], b.id);
      const g = /<p class="col-genre"(?: lang="en")?>([^<]*)<\/p>/.exec(it);
      const w = /<p class="col-why">([^<]*)<\/p>/.exec(it);
      assert.equal(g ? unesc(g[1]) : null, b.genre, `${lang} ${b.id} genre`);
      assert.equal(w ? unesc(w[1]) : null, b.why, `${lang} ${b.id} why`);
    }
  }
});

// ---------- in a real browser: "Show more" draws the same lines ----------

async function withPage(t, fn, width = 1280) {
  if (skipReason) return t.skip(skipReason);
  const page = await browser.newPage();
  try {
    await page.setViewport({ width, height: 900 });
    await fn(page);
  } finally {
    await page.close();
  }
}

test("Show more draws the genre and why lines exactly as the server does (EN and FR), escaped, hiding English on the French page", async (t) => {
  // "long-shelf": 24 filler books first, then copies of the five kinds of book (reached only with Show more). "short-shelf":
  // the same five, drawn by the server. The .col-more of each must be the same HTML on both.
  const filler = [];
  for (let i = 0; i < 24; i++) filler.push({ id: await newBook(`0 Filler ${String(i).padStart(2, "0")}`, "Fiction"), reason: "Filler.", reasonFr: "Remplissage." });
  const five = [
    { id: await newBook("Z1 Both", "Mystery, Science Fiction"), reason: "Clever and rainy.", reasonFr: "Astucieux et pluvieux." },
    { id: await newBook("Z2 English only", "Romance"), reason: "Sweet and English." },
    { id: await newBook("Z3 Hand", "Thriller"), reason: "Added by hand" },
    { id: await newBook("Z4 No genre", ""), reason: "Kind.", reasonFr: "Bienveillant." },
    { id: await newBook("Z5 Hostile", `Fantasy, ${HOSTILE}`), reason: `Brave ${HOSTILE} l'audace.`, reasonFr: `Courageux ${HOSTILE} l'audace !` },
  ];
  await newShelf("long-shelf", [...filler, ...five]);
  await newShelf("short-shelf", five);
  const lines = (page) => page.$$eval(".bk-grid .col-item", (els) => els.map((el) => ({
    href: el.querySelector(".bk-book a").getAttribute("href").replace(/^.*\/books\//, ""),
    more: (el.querySelector(".col-more") || { outerHTML: "" }).outerHTML,
  })));
  for (const prefix of ["", "/fr"]) {
    await withPage(t, async (page) => {
      await page.goto(`${app.base}${prefix}/collections/short-shelf`, { waitUntil: "networkidle0" });
      const server = Object.fromEntries((await lines(page)).map((x) => [x.href, x.more]));
      await page.goto(`${app.base}${prefix}/collections/long-shelf`, { waitUntil: "networkidle0" });
      await page.click("#bk-more");
      await page.waitForFunction(() => document.querySelectorAll(".bk-grid .col-item").length === 29, { timeout: 8000 });
      const drawn = (await lines(page)).slice(24);
      assert.equal(drawn.length, 5);
      for (const d of drawn) assert.equal(d.more, server[d.href], `${prefix || "/"} book ${d.href}: Show more draws the same lines as the server`);
      assert.equal(await page.evaluate(() => window.__xss), undefined, "no markup from the data ran");
      assert.equal(await page.$$eval(".bk-grid .col-more img", (e) => e.length), 0);
      const text = await page.$eval(".bk-grid", (g) => g.textContent);
      if (prefix) {
        assert.ok(!text.includes("Sweet and English") && !text.includes("Why it") && !text.includes("Added by hand"), "no English on the French page after Show more");
        assert.ok(text.includes("Astucieux et pluvieux.") && !text.includes("Pourquoi ce livre"), "the French reason, with no label");
        assert.ok(text.includes("l’audace !"), "French typography on the French reason drawn by the script");
      } else {
        assert.ok(text.includes("Sweet and English.") && !text.includes("Why it"), "the English reason, with no label");
      }
    });
  }
});
