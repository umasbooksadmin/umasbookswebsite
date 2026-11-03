// Browse Educational Items: the cards in a row line up (picture, name, genre and the price line with the cart icon at the same
// height in every card), and the cards use the book cards' cart icon. Checked from source (no browser, no database): the
// browser measurement is done by hand with a headless Chrome (button y-positions per row). If a rule is deleted the icons
// step up and down with the length of the names again, or the cards fall back to a text button.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..", "..");
const read = (...p) => fs.readFileSync(path.join(ROOT, ...p), "utf8");
const edu = read("..", "assets", "edu.css");

test("edu.css: the card is a flex column with the price line at the bottom, and shares the row's tracks with subgrid", () => {
  assert.match(edu, /\.edu-card \{ display: flex; flex-direction: column; \}/);
  assert.match(edu, /\.edu-card \.p \{[^}]*margin-top: auto;/);
  assert.match(edu, /@supports \(grid-template-rows: subgrid\) \{[^@]*\.edu-card \{ display: grid; grid-template-rows: subgrid; grid-row: span 4;/);
  for (const [sel, row] of [[".cover", 1], [".t", 2], [".edu-genre", 3], [".p", 4]]) {
    assert.match(edu, new RegExp(`\\.edu-card > \\${sel} \\{[^}]*grid-row: ${row};`), `${sel} sits in row ${row}`);
  }
});

test("the cards use the book cards' cart icon: the shared partial, ui.js and cart-add.js, and no wide text button", () => {
  const page = read("views", "marketing", "educational-items.ejs");
  assert.match(page, /<div class="p">.*include\('\.\.\/partials\/edu_cart'/s);
  assert.match(page, /extraScripts: \['\/ui\.js', '\/cart-add\.js'\]/);
  assert.ok(!/edu-add|edu-incart/.test(page + edu));
  const js = read("public", "cart-add.js");
  assert.match(js, /\/cart\/add-edu/);
  assert.match(js, /cartEduIds/);
});
