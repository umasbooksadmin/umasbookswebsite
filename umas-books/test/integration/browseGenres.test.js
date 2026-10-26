// The Browse Books genre buttons are drawn by the server from src/lib/browseGenres.js (public/page-books.js only reads them back):
// the same 14 buttons in the same order with the same colours, icons and search topics, labelled in English or French from
// the page's own dictionaries.
//
// Port 6491 is reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { GENRES, ICON_ATTRS } = require("../../src/lib/browseGenres");

const PORT = 6491;
let app;
before(async () => { app = await startTestApp({ port: PORT, isolated: true }); });
after(() => app.stop());

const page = async (lang) => (await fetch(`${app.base}/books.html`, { headers: { cookie: `umasbooks_lang=${lang}` } })).text();
const listOf = (html) => html.match(/<div class="bk-track bk-tiles" id="bk-genre-list"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/section>/)[1];

test("the genre list, in order, is what the page used to build in the browser", () => {
  assert.deepEqual(GENRES.map((g) => g.slug), ["fiction", "children", "ya", "nonfiction", "classics", "mystery", "romance", "biography", "health", "arts", "travel", "food", "home", "all"]);
  assert.deepEqual(GENRES.map((g) => g.topic), ["fiction", "juvenile,child,picture book,baby", "young adult", "nonfiction,non-fiction,history,social science,political,philosophy,psychology,business,education,true crime,nature,religion,language", "classic", "mystery,thriller,suspense,crime,detective", "romance,love", "biography,memoir,autobiography", "health,fitness,wellness,self-help,mind,body", "arts,crafts,hobbies,design,music,photography,antiques,performing", "travel", "cooking,food,drink,wine,recipe,baking", "gardening,garden,house,home,interior", ""], "the search each button runs");
  assert.equal(GENRES[GENRES.length - 1].topic, "", "All Genres runs the empty topic: every book");
  for (const g of GENRES) assert.equal(g.key, `g.${g.slug}`);
});

test("the server renders one button per genre with its index, slug, topic, colours and icon", async () => {
  const html = listOf(await page("en"));
  const buttons = html.match(/<button type="button" class="bk-genre"[\s\S]*?<\/button>/g);
  assert.equal(buttons.length, GENRES.length);
  GENRES.forEach((g, i) => {
    const b = buttons[i];
    assert.ok(b.startsWith(`<button type="button" class="bk-genre" data-index="${i}" data-slug="${g.slug}" data-topic="${g.topic}">`), `${g.slug} attributes`);
    assert.ok(b.includes(`<span class="chip" style="background:${g.bg};color:${g.fg}"><svg ${ICON_ATTRS} aria-hidden="true">${g.svg}</svg></span>`), `${g.slug} chip and icon`);
    assert.ok(b.includes(`<span data-i18n="${g.key}">`), `${g.slug} label hook`);
  });
});

test("the labels are English and French from the page dictionaries", async () => {
  const en = listOf(await page("en"));
  const fr = listOf(await page("fr"));
  const labels = (html) => [...html.matchAll(/<span data-i18n="g\.[a-z]+">([^<]*)<\/span>/g)].map((m) => m[1].replace(/&amp;/g, "&").replace(/&#39;/g, "'"));
  assert.deepEqual(labels(en), ["Fiction", "Children's Books", "Young Adult", "Non-Fiction", "Classics", "Mystery & Thriller", "Romance", "Biography & Memoir", "Health & Wellness", "Arts & Crafts", "Travel", "Food & Drink", "Home & Garden", "All Genres"]);
  assert.deepEqual(labels(fr), ["Fiction", "Jeunesse", "Jeune adulte", "Documentaires", "Classiques", "Polar & Thriller", "Romance", "Biographies & Mémoires", "Santé & Bien-être", "Arts & Loisirs créatifs", "Voyage", "Cuisine & Boissons", "Maison & Jardin", "Tous les genres"]);
});

test("the shared browser scripts load before the page script on Browse and on the pages that draw cards", async () => {
  const order = (html, names) => names.map((n) => html.indexOf(`/${n}.js`));
  const books = await page("en");
  const i = order(books, ["books-state", "ui", "carousel", "page-books"]);
  assert.ok(i.every((x) => x > 0) && [...i].sort((a, b) => a - b).join() === i.join(), `Browse script order ${i}`);
  const events = await (await fetch(`${app.base}/events.html`)).text();
  assert.ok(events.indexOf("/ui.js") > 0 && events.indexOf("/ui.js") < events.indexOf("/page-events.js"));
  const home = await (await fetch(`${app.base}/`)).text();
  assert.ok(home.indexOf("/ui.js") > 0 && home.indexOf("/ui.js") < home.indexOf("/blog.js"), "assets/blog.js needs ui.js first");
  const fav = await (await fetch(`${app.base}/favorites`)).text();
  assert.ok(fav.indexOf("/ui.js") > 0 && fav.indexOf("/ui.js") < fav.indexOf("/favorites-page.js"));
  const login = await (await fetch(`${app.base}/login`)).text();
  assert.ok(!login.includes("/ui.js"), "pages that draw no cards do not load it");
  const js = await fetch(`${app.base}/ui.js`);
  assert.equal(js.status, 200);
});
