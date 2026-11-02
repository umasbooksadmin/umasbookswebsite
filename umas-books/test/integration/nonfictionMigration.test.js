// Migration 114 ("Nonfiction" is one word), on a database migrated only up to 112 and seeded with books in every
// spelling of non-fiction: the managed genre, its Browse label, the genre rules and every book's genre list move to
// "Nonfiction"; the other genres and their order stay; the old values are in the backup tables; ONE Admin activity
// line; a second run changes nothing; the undo recipe in the migration's header restores the old data.
// Also: the SQL spelling equals NONFICTION_VARIANT_RE of src/lib/genreClean.js.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { prepareDatabase } = require("../helpers/testDatabase");

const db = prepareDatabase("nonfiction_migration", { isolated: true, migrateUpTo: 112 });
const { pool } = require("../../src/db");
before(() => db.create());
after(async () => { await pool.end(); db.drop(); });

const SQL = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "114_nonfiction_spelling.sql"), "utf8");
const { isNonfictionVariant } = require("../../src/lib/genreClean");
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const auditLines = () => q("SELECT actor_label, action, target_type, detail FROM admin_audit_log WHERE action = 'books.nonfiction_spelling' ORDER BY id");

// [stored categories, expected after]
const CASES = [
  ["Non-fiction", "Nonfiction"],
  ["non-fiction", "Nonfiction"],
  ["NON-FICTION", "Nonfiction"],
  ["Non-Fiction", "Nonfiction"],
  ["non fiction", "Nonfiction"],
  ["Non  Fiction", "Nonfiction"],
  ["NONFICTION", "Nonfiction"],
  ["nonfiction", "Nonfiction"],
  ["Non‐fiction", "Nonfiction"],
  ["History, Non-fiction", "History, Nonfiction"],
  ["Non-fiction, History", "Nonfiction, History"],
  ["Fiction,non fiction ,Mystery", "Fiction, Nonfiction, Mystery"],
  ["Biography, Non-fiction, Science Fiction", "Biography, Nonfiction, Science Fiction"],
  ["Non-fiction, nonfiction, History", "Nonfiction, History"],
  ["Non-fiction, Fiction, Non fiction", "Nonfiction, Fiction"],
];
// Must stay exactly as stored (including spacing): no nonfiction element, or already correct.
const UNTOUCHED = [
  "Fiction", "Science Fiction", "Fiction,Mystery", "Nonfiction", "History,Nonfiction", "Nonfiction, History", "Nonfictional",
  "Non-fiction books", "Fiction, Nonfiction,History", "Historical Fiction", "", null,
];

let caseIds = [];
let untouchedIds = [];
let before_;

test("seed the old data, then run migration 114", async () => {
  assert.equal((await q("SELECT count(*)::int AS n FROM schema_migrations WHERE filename LIKE '114%'"))[0].n, 0);
  const nf = (await q("SELECT id, name_en, browse_label_en, browse_slug, browse_topic FROM managed_genres WHERE lower(name_en) = 'non-fiction'"))[0];
  assert.ok(nf, "migration 100 seeds Non-fiction");
  assert.equal(nf.browse_label_en, "Non-Fiction");
  const ruleOf = async (kind, pattern, action) => (await q(
    "INSERT INTO genre_rules (kind, pattern, pattern_key, action) VALUES ($1, $2, lower($2), $3) RETURNING id", [kind, pattern, action]))[0].id;
  const exactId = await ruleOf("exact", "Non-fiction", "keep");
  const wordId = await ruleOf("contains-word", "non-fiction", "keep");
  const otherId = await ruleOf("exact", "True crime", "keep");
  await pool.query("INSERT INTO genre_rules (kind, pattern, pattern_key, action, target_managed_genre_id) VALUES ('exact', 'Factual', 'factual', 'map', $1)", [nf.id]);

  const add = async (cat, i) => (await q(
    "INSERT INTO books (title, description, categories, published_year, updated_at) VALUES ($1, 'A non-fiction description stays.', $2, 1999, now() - interval '3 days') RETURNING id", [`NF ${i}`, cat]))[0].id;
  for (const [i, [c]] of CASES.entries()) caseIds.push(await add(c, i));
  for (const [i, c] of UNTOUCHED.entries()) untouchedIds.push(await add(c, 100 + i));
  await pool.query("INSERT INTO book_copies (book_id, condition, price, status) VALUES ($1, 'good', 7.50, 'in_stock')", [caseIds[0]]);
  const booksBefore = await q("SELECT * FROM books ORDER BY id");
  const copiesBefore = await q("SELECT * FROM book_copies ORDER BY id");
  const genresBefore = await q("SELECT * FROM managed_genres WHERE id <> $1 ORDER BY id", [nf.id]);
  before_ = { nf, exactId, wordId, otherId, booksBefore, copiesBefore };

  await pool.query(SQL);

  // the managed genre and its Browse button
  const g = (await q("SELECT * FROM managed_genres WHERE id = $1", [nf.id]))[0];
  assert.equal(g.name_en, "Nonfiction");
  assert.equal(g.browse_label_en, "Nonfiction");
  assert.equal(g.browse_slug, "nonfiction", "the slug (old links) stays");
  assert.equal(g.browse_topic, nf.browse_topic, "the search words keep BOTH spellings");
  assert.ok(g.browse_topic.includes("non-fiction") && g.browse_topic.includes("nonfiction"));
  assert.deepEqual(await q("SELECT * FROM managed_genres WHERE id <> $1 ORDER BY id", [nf.id]), genresBefore, "no other genre changes");
  // rules: the exact one is renamed, the word rule and the others stay; the map rule still points at the genre
  const rules = new Map((await q("SELECT id, kind, pattern, pattern_key FROM genre_rules")).map((r) => [r.id, r]));
  assert.deepEqual([rules.get(exactId).pattern, rules.get(exactId).pattern_key], ["Nonfiction", "nonfiction"]);
  assert.equal(rules.get(wordId).pattern, "non-fiction");
  assert.equal(rules.get(otherId).pattern, "True crime");
  assert.equal((await q("SELECT target_managed_genre_id FROM genre_rules WHERE pattern = 'Factual'"))[0].target_managed_genre_id, nf.id);

  // the books
  const byId = new Map((await q("SELECT * FROM books ORDER BY id")).map((b) => [b.id, b]));
  const beforeById = new Map(booksBefore.map((b) => [b.id, b]));
  assert.deepEqual(CASES.map((_, i) => byId.get(caseIds[i]).categories), CASES.map(([, want]) => want));
  for (const id of untouchedIds) assert.deepEqual(byId.get(id), beforeById.get(id), "untouched in every column");
  for (const id of caseIds) {
    const { categories: _a, ...rowAfter } = byId.get(id);
    const { categories: _b, ...rowBefore } = beforeById.get(id);
    assert.deepEqual(rowAfter, rowBefore, "only categories changed (descriptions, updated_at, ... stay)");
  }
  assert.ok(byId.get(caseIds[0]).description.includes("non-fiction"), "free text is never rewritten");
  assert.deepEqual(await q("SELECT * FROM book_copies ORDER BY id"), copiesBefore, "copies and prices untouched");
  assert.equal((await q("SELECT count(*)::int AS n FROM books"))[0].n, booksBefore.length, "no book deleted");
});

test("the managed names and the books now agree: every book genre of the nonfiction kind IS the managed name", async () => {
  const rows = await q(`SELECT count(*)::int AS n FROM books b, unnest(string_to_array(b.categories, ',')) g
                        WHERE btrim(g) <> 'Nonfiction' AND btrim(g) ~* '^non([-‐‑]|\\s+)?fiction$'`);
  assert.equal(rows[0].n, 0);
  const managed = (await q("SELECT name_en FROM managed_genres WHERE lower(name_en) LIKE 'non%fiction'")).map((r) => r.name_en);
  assert.deepEqual(managed, ["Nonfiction"]);
});

test("the old value of every changed book is in categories_nonfiction_backup, and only those", async () => {
  const rows = await q("SELECT book_id, categories_before FROM categories_nonfiction_backup ORDER BY book_id");
  assert.deepEqual(rows.map((r) => [r.book_id, r.categories_before]), caseIds.map((id, i) => [id, CASES[i][0]]).filter(([, old], i) => old !== CASES[i][1]));
  const b = await q("SELECT on_table, row_id, on_column, value_before FROM nonfiction_rename_backup ORDER BY on_table, on_column, row_id");
  assert.deepEqual(b.map((r) => [r.on_table, r.on_column, r.value_before]), [
    ["genre_rules", "pattern", "Non-fiction"], ["managed_genres", "browse_label_en", "Non-Fiction"], ["managed_genres", "name_en", "Non-fiction"],
  ]);
});

test("ONE Admin activity line", async () => {
  const lines = await auditLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].actor_label, "migration 114");
  assert.equal(lines[0].detail, `Non-fiction spelled Nonfiction on ${CASES.length} books and in the genre list. Old values kept in tables categories_nonfiction_backup and nonfiction_rename_backup. No book, copy or price was deleted.`);
});

test("a second run changes nothing and writes no second line", async () => {
  const snap = async () => ({
    books: await q("SELECT * FROM books ORDER BY id"), genres: await q("SELECT * FROM managed_genres ORDER BY id"),
    rules: await q("SELECT * FROM genre_rules ORDER BY id"), b1: await q("SELECT * FROM categories_nonfiction_backup ORDER BY book_id"),
    b2: await q("SELECT * FROM nonfiction_rename_backup ORDER BY on_table, on_column, row_id"),
  });
  const first = await snap();
  await pool.query(SQL);
  assert.deepEqual(await snap(), first);
  assert.equal((await auditLines()).length, 1);
});

test("UNDO: the recipe in the header of the migration puts the old data back", async () => {
  const m = SQL.match(/-- UNDO[^\n]*\n((?:-- {3}[^\n]*\n)+)/);
  assert.ok(m, "the header has an UNDO recipe");
  const undo = m[1].split("\n").map((l) => l.replace(/^-- {3}/, "")).join("\n");
  await pool.query(undo);
  assert.equal((await q("SELECT categories FROM books WHERE id = $1", [caseIds[9]]))[0].categories, "History, Non-fiction");
  assert.equal((await q("SELECT name_en, browse_label_en FROM managed_genres WHERE id = $1", [before_.nf.id]))[0].name_en, "Non-fiction");
  assert.equal((await q("SELECT pattern FROM genre_rules WHERE id = $1", [before_.exactId]))[0].pattern, "Non-fiction");
  assert.equal((await q("SELECT categories FROM books WHERE id = $1", [caseIds[0]]))[0].categories, "Non-fiction", "first seeded book is back");
});

test("an existing managed Nonfiction (or exact Nonfiction rule) is never duplicated: the rename is skipped, books still move", async () => {
  await pool.query("DELETE FROM categories_nonfiction_backup; DELETE FROM nonfiction_rename_backup; DELETE FROM admin_audit_log WHERE action = 'books.nonfiction_spelling'");
  await pool.query("UPDATE managed_genres SET name_en = 'Non-fiction', browse_label_en = 'Non-Fiction' WHERE id = $1", [before_.nf.id]);
  await pool.query("INSERT INTO managed_genres (name_en, sort_order, browse_slug, show_on_browse) VALUES ('Nonfiction', 901, 'nonfiction-two', FALSE)");
  await pool.query("UPDATE genre_rules SET pattern = 'Non-fiction', pattern_key = 'non-fiction' WHERE id = $1", [before_.exactId]);
  await pool.query("INSERT INTO genre_rules (kind, pattern, pattern_key, action) VALUES ('exact', 'Nonfiction', 'nonfiction', 'keep')");
  const [{ id }] = await q("INSERT INTO books (title, categories) VALUES ('Late', 'Non-fiction, Poetry') RETURNING id");
  await pool.query(SQL);
  assert.equal((await q("SELECT name_en FROM managed_genres WHERE id = $1", [before_.nf.id]))[0].name_en, "Non-fiction", "no duplicate managed name");
  assert.equal((await q("SELECT pattern FROM genre_rules WHERE id = $1", [before_.exactId]))[0].pattern, "Non-fiction", "no duplicate rule");
  assert.equal((await q("SELECT categories FROM books WHERE id = $1", [id]))[0].categories, "Nonfiction, Poetry");
});

test("the SQL spelling and the JS spelling of a nonfiction genre agree", async () => {
  const SAMPLES = ["Non-fiction", "non fiction", "NONFICTION", "Non‐fiction", "Non‑fiction", "Non  fiction", "Nonfictional", "Non-fiction books", "Non--fiction", "Fiction", "Non", "Non/fiction"];
  for (const s of SAMPLES) {
    const sqlSays = (await q("SELECT btrim($1) ~* '^non([-‐‑]|\\s+)?fiction$' AS v", [s]))[0].v;
    assert.equal(sqlSays, isNonfictionVariant(s), JSON.stringify(s));
  }
});
