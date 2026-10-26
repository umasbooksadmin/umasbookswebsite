// Language of parts (WCAG 3.1.2): lib/bookText.js (server) and public/ui.js enSpan (browser) wrap English book text on a
// French page in <span lang="en"> by the same rule, and leave an English page, and a book that says it is not English, alone.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { bookText, favName, isEnglishBook } = require("../../src/lib/bookText");

function loadUi(lang) {
  const ctx = { document: { documentElement: { lang } }, window: { PAGE_I18N: { fr: { "bk.fav.add": "Ajouter {t} aux favoris" }, en: { "bk.fav.add": "Add {t} to favorites" } } } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "..", "..", "public", "ui.js"), "utf8"), ctx);
  return ctx.window.UmasUI;
}

test("server: wrapped on a French page, plain on an English one, escaped either way", () => {
  assert.equal(bookText("A & B <i>", "fr"), '<span lang="en">A &amp; B &lt;i&gt;</span>');
  assert.equal(bookText("A & B", "en"), "A &amp; B");
  assert.equal(bookText("", "fr"), "");
  assert.equal(bookText(null, "fr"), "");
});

test("a book that says it is French is not wrapped; no language, en, en-GB, English are", () => {
  assert.equal(bookText("Le Petit Prince", "fr", "fr"), "Le Petit Prince");
  for (const l of [undefined, null, "", "en", "en-GB", "English", "eng"]) assert.ok(isEnglishBook(l), String(l));
  assert.equal(isEnglishBook("fre"), false);
});

test("the heart's name: French sentence around the English title; English keeps a plain label", () => {
  assert.equal(favName("Emma", "fr"), 'Ajouter <span lang="en">Emma</span> aux favoris');
  assert.equal(favName("Emma", "en"), "Add Emma to favorites");
});

test("the browser helper agrees with the server one", () => {
  for (const lang of ["fr", "en"]) {
    const ui = loadUi(lang);
    for (const [txt, bl] of [["Emma & Co", undefined], ["Emma", "fr"], ["", undefined], ["O'Brien", "en"]]) {
      assert.equal(ui.enSpan(txt, bl), bookText(txt, lang, bl), `${lang} ${txt} ${bl}`);
    }
  }
  assert.equal(loadUi("fr").favNameHtml("L'Étranger"), 'Ajouter <span lang="en">L’Étranger</span> aux favoris');
});

test("cards: French cards wrap title and author and use a hidden name for the heart; English cards do not; placeholder is aria-hidden", () => {
  const b = { id: 7, title: "Emma", author: "Jane Austen", price: 4, coverUrl: "", url: "/books/7" };
  const fr = loadUi("fr").bookCardHtml(b, true);
  assert.match(fr, /<div class="t"><span lang="en">Emma<\/span><\/div>/);
  assert.match(fr, /<div class="a"><span lang="en">Jane Austen<\/span><\/div>/);
  assert.match(fr, /<span class="fav-name">Ajouter <span lang="en">Emma<\/span> aux favoris<\/span>/);
  assert.doesNotMatch(fr, /aria-label/);
  assert.match(fr, /<div class="cover cover-none" aria-hidden="true">/);
  const en = loadUi("en").bookCardHtml(b, true);
  assert.doesNotMatch(en, /lang="en"/);
  assert.match(en, /aria-label="Add Emma to favorites"/);
  const fav = loadUi("fr").favoriteCardHtml({ ...b, inStockCount: 1 });
  assert.match(fav, /<div class="book-card-title"><span lang="en">Emma<\/span><\/div>/);
  assert.match(fav, /class="book-card-cover book-thumb-placeholder" aria-hidden="true"/);
});
