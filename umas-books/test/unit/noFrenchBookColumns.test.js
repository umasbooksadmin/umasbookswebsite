// Migration 108 dropped books.description_fr, books.categories_fr, managed_genres.name_fr and
// managed_genres.browse_label_fr. No source file (code, views, scripts, tests, e2e) may name them again: a query
// that did would fail on the live database. Old migrations are history and are not scanned; the two migration tests
// (107, 108) and the page test (which checks the columns are gone) need the names.
//
// description_fr stays a real column elsewhere (collections, events, charities; the condition grades' French text),
// so for it only a mention tied to the books table is refused. The other names exist nowhere else and are refused
// everywhere (word-bounded: genre_run_changes.old_categories_fr / new_categories_fr are history and stay).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const APP = path.join(__dirname, "..", "..");
const ROOTS = ["src", "views", "public", "scripts", "e2e", "test"].map((d) => path.join(APP, d)).concat(path.join(APP, "..", "assets"));
const EXEMPT = new Set([
  "test/integration/removeFrenchBookContentMigration.test.js",
  "test/integration/dropFrenchBookColumnsMigration.test.js",
  "test/integration/dropFrenchBookColumnsPages.test.js", // checks the columns are absent
  "test/unit/noFrenchBookColumns.test.js",
].map((f) => path.join(APP, f)));
const EXT = /\.(js|mjs|cjs|ejs|json|sql|sh|css|html)$/;

const ANYWHERE = /\b(categories_fr|name_fr|browse_label_fr|genreFr|descriptionFr|categoriesFr|nameFr|browseLabelFr)\b/;
// description_fr on the same line as the books table in SQL ("FROM books", "INTO books", "UPDATE books", "books.") or
// an IMAGE_REFERENCES-style { table: "books" } entry.
const BOOKS_TABLE = /\b(FROM|INTO|UPDATE|JOIN|TABLE)\s+books\b|\bbooks\.\w|table: "books"/i;
const mentions = (line) => ANYWHERE.test(line) || (/\bdescription_fr\b/.test(line) && BOOKS_TABLE.test(line));

function* files(dir) {
  if (!fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (EXT.test(e.name)) yield p;
  }
}

function offenders() {
  const found = [];
  for (const root of ROOTS) {
    for (const file of files(root)) {
      if (EXEMPT.has(file)) continue;
      const lines = fs.readFileSync(file, "utf8").split("\n");
      lines.forEach((line, i) => {
        if (mentions(line)) found.push(`${path.relative(APP, file)}:${i + 1}: ${line.trim().slice(0, 140)}`);
      });
    }
  }
  return found;
}

test("no source file names a dropped French book / managed-genre column", () => {
  assert.deepEqual(offenders(), [], "these lines name a column migration 108 dropped");
});

test("the check itself catches each kind of mention (so an empty result means something)", () => {
  const probe = mentions;
  assert.ok(probe("SELECT categories_fr FROM books"));
  assert.ok(probe("UPDATE books SET description_fr = $1"));
  assert.ok(probe('{ table: "books", column: "description_fr" }'));
  assert.ok(probe("INSERT INTO managed_genres (name_en, name_fr) VALUES ($1, $2)"));
  assert.ok(probe("m.browse_label_fr"));
  assert.ok(probe("body.genreFr"));
  assert.ok(!probe("SELECT title_fr, description_fr FROM curated_collections"), "a collection's French is fine");
  assert.ok(!probe("SELECT old_categories_fr FROM genre_run_changes"), "genre run history is fine");
  assert.ok(!probe('{ table: "book_french_backup", column: "description_fr" }'), "the backup table is fine");
  assert.ok(!probe('translateEmptyFrench({ description_en: "A shelf of warm books.", description_fr: "" })'), "the word books in a text is fine");
});
