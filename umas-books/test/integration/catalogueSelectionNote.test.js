// The online catalogue is only a selection of the shop (owner-approved wording, 2026-11-01): a short line on Browse,
// the long text on the no-results state (drawn by public/page-books.js) and on the Visit page, English and French.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");

const PORT = 3494;
let app;
before(async () => { app = await startTestApp({ port: PORT, isolated: true }); });
after(() => app.stop());

const SHORT_EN = "What you see online is only part of our shelves. Many more books are in the shop and not listed here, so come and browse.";
const LONG_EN = "Our online catalogue is a selection from the shop. We have many more second-hand books on the shelves than we list here, and new donations arrive regularly. Can't find a title? Ask us or drop in, and we'll look.";
const SHORT_FR = /Ce que vous voyez en ligne n’est qu’une partie de nos étagères\./;
const LONG_FR = /Notre catalogue en ligne n’est qu’une sélection de la boutique\./;
const get = async (p, lang) => (await fetch(`${app.base}${p}`, { headers: lang ? { cookie: `umasbooks_lang=${lang}` } : {} })).text();

test("Browse: the short line under the search box, English and French", async () => {
  const en = await get("/books.html");
  assert.match(en, /<p class="bk-selnote" id="bk-selnote" data-i18n="bk.selnote">/);
  assert.ok(en.includes(SHORT_EN));
  assert.ok(!en.includes(LONG_EN.slice(0, 40) + "</p>"), "the long text is not in the page markup of Browse");
  const fr = await get("/books.html", "fr");
  assert.match(fr, SHORT_FR);
  assert.match(fr, LONG_FR, "the long text is in the French dictionary for the no-results state");
});

test("Visit: the long text near the hours, English and French", async () => {
  const en = await get("/visit.html");
  assert.ok(en.indexOf("hours-row") < en.indexOf(LONG_EN) && en.includes(LONG_EN));
  assert.match(await get("/visit.html", "fr"), LONG_FR);
});

test("no-results state: the page script shows the long text, and the short line only when there are books", async () => {
  const js = await (await fetch(`${app.base}/page-books.js`)).text();
  assert.match(js, /getElementById\('bk-selnote'\)/);
  assert.match(js, /selNote\.hidden = !books\.length/);
  assert.match(js, /t\('bk\.empty\.long'\)/);
});
