// The Browse Books collection buttons in a REAL browser (headless Chrome through puppeteer, the same one the e2e
// suite and scripts/phone-overflow-audit.js use) against the real app and a throwaway database:
//   - shown on the plain view, hidden while a genre, a search or ?new=1 is showing (and shown again after Back),
//   - on a 375 px phone: about three to a row, every button at least 44 px, no sideways scrolling, lazy pictures,
//   - the buttons and the collection page work with JavaScript switched off,
//   - the French page.
// Skipped (with a message) when no Chrome can be started on this computer.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");

const PORT = 6482;
let app;
let pool;
let browser;
let skipReason = null;
let slug;

before(async () => {
  try {
    const puppeteer = require("puppeteer");
    browser = await puppeteer.launch({ headless: true, args: ["--no-sandbox"] });
  } catch (err) {
    skipReason = `no headless Chrome available: ${String(err.message).split("\n")[0]}`;
    return;
  }
  app = await startTestApp({ port: PORT, isolated: true, env: { ANTHROPIC_API_KEY: "" } });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  // Four published collections with an approved book in stock, so the row wraps on a phone.
  const { rows } = await pool.query("INSERT INTO books (title, authors, categories) VALUES ('Browser Test Book', 'Some Author', 'Fiction') RETURNING id");
  await pool.query("INSERT INTO book_copies (book_id, status, price, condition) VALUES ($1, 'in_stock', 7, 'good')", [rows[0].id]);
  const { rows: cols } = await pool.query("SELECT id, slug FROM curated_collections ORDER BY sort_order, id LIMIT 7");
  slug = cols[0].slug;
  for (const c of cols) await pool.query("INSERT INTO curated_collection_books (collection_id, book_id, status, position) VALUES ($1, $2, 'approved', 1)", [c.id, rows[0].id]);
  await pool.query("UPDATE curated_collections SET published = TRUE WHERE id = ANY($1)", [cols.map((c) => c.id)]);
});

after(async () => {
  if (browser) await browser.close();
  if (pool) await pool.end();
  if (app) await app.stop();
});

async function withPage(t, fn, { viewport = { width: 1100, height: 900 }, js = true } = {}) {
  if (skipReason) return t.skip(skipReason);
  const page = await browser.newPage();
  try {
    await page.setViewport(viewport);
    await page.setJavaScriptEnabled(js);
    await fn(page);
  } finally {
    await page.close();
  }
}

const shown = (page) => page.$eval("#bk-collections", (e) => !e.hidden && e.getBoundingClientRect().height > 0).catch(() => false);
const go = (page, p) => page.goto(`${app.base}${p}`, { waitUntil: "networkidle0" });

test("the row is shown on the plain view and hidden with a genre, a search or ?new=1, and back again", async (t) => {
  await withPage(t, async (page) => {
    await go(page, "/books.html");
    await page.waitForSelector("#bk-genre-list .bk-genre");
    assert.equal(await shown(page), true, "shown on the default view");
    assert.ok((await page.$$("#bk-collections .col-btn")).length >= 7);

    await page.click("#bk-genre-list .bk-genre");
    await page.waitForSelector("#bk-results:not([hidden])");
    assert.equal(await shown(page), false, "hidden when a genre is chosen");
    await page.goBack();
    await page.waitForFunction(() => document.querySelector("#bk-results").hidden);
    assert.equal(await shown(page), true, "shown again after Back");

    await page.type("#shop-search-input", "browser");
    await page.keyboard.press("Enter");
    await page.waitForSelector("#bk-results:not([hidden])");
    assert.equal(await shown(page), false, "hidden when a search is showing");

    await go(page, "/books.html?new=1");
    await page.waitForSelector("#bk-results:not([hidden])");
    assert.equal(await shown(page), false, "hidden on ?new=1");
    await go(page, "/books.html?genre=fiction");
    assert.equal(await shown(page), false, "hidden on ?genre=");
    await go(page, "/books.html?q=browser");
    assert.equal(await shown(page), false, "hidden on ?q=");
    await go(page, "/books.html?topic=mystery");
    assert.equal(await shown(page), false, "hidden on ?topic=");
    await go(page, "/books.html");
    assert.equal(await shown(page), true);
  });
});

test("on a 375 px phone the buttons wrap about three to a row, are at least 44 px, and nothing scrolls sideways", async (t) => {
  await withPage(t, async (page) => {
    await go(page, "/books.html");
    const r = await page.$$eval("#bk-collections .col-btn", (els) => els.map((e) => { const b = e.getBoundingClientRect(); return { top: Math.round(b.top), w: b.width, h: b.height, right: b.right }; }));
    assert.ok(r.length >= 7);
    assert.ok(r.every((b) => b.w >= 44 && b.h >= 44), "every button is at least 44 x 44 px");
    assert.equal(r.filter((b) => Math.abs(b.top - r[0].top) < 4).length, 3, "three to a row");
    assert.ok(r.every((b) => b.right <= 375), "no button runs off the screen");
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(sw <= 375, `the page is ${sw} px wide on a 375 px screen`);
    const img = await page.$eval("#bk-collections .col-btn img", (i) => ({ alt: i.getAttribute("alt"), lazy: i.loading, w: i.getAttribute("width"), h: i.getAttribute("height") }));
    assert.deepEqual(img, { alt: "", lazy: "lazy", w: "120", h: "120" });
  }, { viewport: { width: 375, height: 812, deviceScaleFactor: 2, isMobile: true, hasTouch: true } });
});

test("with JavaScript off the buttons are links and the collection page lists its books", async (t) => {
  await withPage(t, async (page) => {
    await go(page, "/books.html");
    assert.equal(await shown(page), true, "the row is in the page itself, not drawn by a script");
    const href = await page.$eval("#bk-collections .col-btn", (a) => a.getAttribute("href"));
    assert.match(href, /^\/collections\/[a-z0-9-]+$/);
    await go(page, href);
    assert.ok((await page.$$(".bk-grid .bk-book a[href^='/books/']")).length >= 1);
    assert.equal(await page.$eval(".col-back a", (a) => a.getAttribute("href")), "/books.html");
  }, { js: false });
});

test("a button opens the collection page; the French pages are French from top to bottom", async (t) => {
  await withPage(t, async (page) => {
    await go(page, "/books.html");
    const first = await page.$eval("#bk-collections .col-btn", (a) => ({ href: a.getAttribute("href"), name: a.innerText.trim() }));
    await Promise.all([page.waitForNavigation({ waitUntil: "networkidle0" }), page.click("#bk-collections .col-btn")]);
    assert.equal(new URL(page.url()).pathname, first.href);
    assert.equal(await page.$eval("h1", (h) => h.innerText.trim()), first.name);

    await go(page, `/fr${first.href}`);
    assert.equal(await page.$eval("html", (h) => h.lang), "fr");
    const text = await page.evaluate(() => document.body.innerText);
    assert.match(text, /Retour à Parcourir les livres/);
    assert.ok(!/Back to Browse|Cover images come from/.test(text));
    await go(page, "/fr/books.html");
    assert.match(await page.$eval("#bk-collections", (e) => e.innerText), /Parcourir par collection/);
    assert.equal(slug && first.href.endsWith(slug), true, "the first button is the first collection in sort order");
  });
});
