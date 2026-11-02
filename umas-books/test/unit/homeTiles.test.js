// Home page tiles: the top row is Browse Books, Educational Items, English Programs, Events (in that order);
// Donate Books sits in the bottom row with "More than a bookstore" and "Become a Member". Checked from the template source.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const src = fs.readFileSync(path.join(__dirname, "..", "..", "views", "marketing", "index.ejs"), "utf8");
const cards = src.slice(src.indexOf('<section class="h-cards">'), src.indexOf("</section>", src.indexOf('<section class="h-cards">')));
const bottom = src.slice(src.indexOf('<section class="member-band member-row">'), src.indexOf("<% const pageI18nEn"));
const keysOf = (html) => [...html.matchAll(/<h2 data-i18n="(home\.[a-z]+)\.t"/g)].map((m) => m[1]);

test("home tiles: top row order is browse, edu, eveil, events", () => {
  assert.deepEqual(keysOf(cards), ["home.browse", "home.edu", "home.eveil", "home.events"]);
  assert.equal((cards.match(/<article class="h-card/g) || []).length, 4, "still four tiles in the same grid");
});

test("home tiles: Educational Items links to the Browse Educational Items page, the same as the nav tab", () => {
  const header = fs.readFileSync(path.join(__dirname, "..", "..", "views", "marketing", "partials", "mkt_header.ejs"), "utf8");
  assert.match(header, /href: '\/educational-items\.html', i18n: 'nav\.edu'/);
  assert.match(cards, /<a class="h-btn" href="educational-items\.html"><span data-i18n="home\.edu\.cta">Browse items<\/span>/);
});

test("home tiles: Donate Books left the top row and is in the bottom row with its link", () => {
  assert.ok(!cards.includes("home.donate"), "no Donate tile in the top row");
  assert.deepEqual(keysOf(bottom), ["home.about", "home.donate"]);
  assert.ok(bottom.includes("mkt_member_band"), "the membership block is in the bottom row");
  assert.ok(bottom.includes('href="about.html#donate"'));
  assert.ok(bottom.indexOf("home.about") < bottom.indexOf("mkt_member_band") && bottom.indexOf("mkt_member_band") < bottom.indexOf("home.donate"));
});

test("home tiles: EN and FR text for the new tile, and the Donate keys are kept", () => {
  const en = src.slice(src.indexOf("const pageI18nEn"), src.indexOf("const pageI18nFr"));
  const fr = src.slice(src.indexOf("const pageI18nFr"));
  for (const k of ["home.edu.t", "home.edu.d", "home.edu.cta", "home.donate.t", "home.donate.d", "home.donate.cta"]) {
    assert.ok(en.includes(`"${k}"`), `${k} in EN`);
    assert.ok(fr.includes(`"${k}"`), `${k} in FR`);
  }
  assert.match(en, /"home\.edu\.t": "Educational Items"/);
  assert.match(fr, /"home\.edu\.t": "Articles éducatifs"/);
  assert.match(fr, /"home\.edu\.cta": "Voir les articles"/);
  assert.match(fr, /"home\.donate\.t": "Donner des livres"/);
});

test("home tiles: Educational Items uses the Donate medallion; the Donate card in the bottom row has none", () => {
  const edu = cards.slice(cards.indexOf("home.edu.t"), cards.indexOf("home.eveil.t"));
  const eduArticle = cards.slice(cards.lastIndexOf("<article", cards.indexOf("home.edu.t")), cards.indexOf("</article>", cards.indexOf("home.edu.t")));
  assert.ok(eduArticle.includes("/assets/img/medallion-donate.png"), "edu tile shows the donate medallion");
  assert.ok(!eduArticle.includes("flower.webp"));
  assert.ok(edu.length > 0);
  const donate = bottom.slice(bottom.indexOf('donate-card'));
  assert.ok(!donate.includes("medallion"), "the Donate card has no medallion");
  assert.ok(!cards.includes("medallion-donate.png") || cards.indexOf("medallion-donate.png") < cards.indexOf("home.eveil.t"), "only the edu tile uses it in the top row");
});
