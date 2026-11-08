// Migration 118 ("Children's Fiction" with a capital F), on a database migrated only up to 118 and seeded with books in every
// spelling: the managed genre (spelled "Children's fiction" in production), its Browse label, the genre rules and every
// book's genre list move to "Children's Fiction"; the other genres and their order stay; the old values are in the backup
// tables; ONE Admin activity line; a second run changes nothing; the undo recipe in the header restores the old data; a
// curly-apostrophe duplicate genre is merged; a database without the genre is left alone.
// Also: the SQL spelling equals CHILDRENS_FICTION_VARIANT_RE of src/lib/genreClean.js.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { prepareDatabase } = require("../helpers/testDatabase");

const db = prepareDatabase("childrens_fiction_migration", { isolated: true, migrateUpTo: 118 });
const { pool } = require("../../src/db");
before(() => db.create());
after(async () => { await pool.end(); db.drop(); });

const SQL = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "119_childrens_fiction_spelling.sql"), "utf8");
const { isChildrensFictionVariant } = require("../../src/lib/genreClean");
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const auditLines = () => q("SELECT actor_label, action, target_type, detail FROM admin_audit_log WHERE action = 'books.childrens_fiction_spelling' ORDER BY id");

// [stored categories, expected after]
const CASES = [
  ["Children's fiction", "Children's Fiction"],
  ["children's fiction", "Children's Fiction"],
  ["CHILDREN'S FICTION", "Children's Fiction"],
  ["Children’s fiction", "Children's Fiction"],
  ["children’s Fiction", "Children's Fiction"],
  ["Children‘s fiction", "Children's Fiction"],
  ["Children's  fiction", "Children's Fiction"],
  ["Poetry, Children's fiction", "Poetry, Children's Fiction"],
  ["Children's fiction, Poetry", "Children's Fiction, Poetry"],
  ["Fiction,children's fiction ,Mystery", "Fiction, Children's Fiction, Mystery"],
  ["Biography, Children’s fiction, Science Fiction", "Biography, Children's Fiction, Science Fiction"],
  ["Children's fiction, children’s Fiction, Poetry", "Children's Fiction, Poetry"],
  ["Children's fiction, Fiction, Children's Fiction", "Children's Fiction, Fiction"],
];
// Must stay exactly as stored (including spacing): no such element, or already correct.
const UNTOUCHED = [
  "Fiction", "Children's Books", "Juvenile Fiction", "Children's Books, Fiction", "Childrens fiction", "Chidren's Fiction",
  "Children's fiction books", "Children's", "Children's Fiction", "Poetry,Children's Fiction", "Children's Fiction, Poetry", "", null,
];

let caseIds = [];
let untouchedIds = [];
let ctx;

test("seed the old data, then run migration 119", async () => {
  assert.equal((await q("SELECT count(*)::int AS n FROM schema_migrations WHERE filename LIKE '119%'"))[0].n, 0);
  // production has the managed genre spelled with a lower-case f (migration 100 seeded it as Children's Fiction)
  const cf = (await q("UPDATE managed_genres SET name_en = 'Children''s fiction', browse_label_en = 'children’s fiction' WHERE lower(name_en) = 'children''s fiction' RETURNING *"))[0];
  assert.ok(cf, "migration 100 seeds Children's Fiction");
  assert.equal(cf.browse_slug, "children");
  const ruleOf = async (kind, pattern, action) => (await q(
    "INSERT INTO genre_rules (kind, pattern, pattern_key, action) VALUES ($1, $2, lower($2), $3) RETURNING id", [kind, pattern, action]))[0].id;
  const exactId = await ruleOf("exact", "Children's fiction", "keep");
  const wordId = await ruleOf("contains-word", "children's fiction", "keep");
  const otherId = await ruleOf("exact", "Kids", "keep");
  await pool.query("INSERT INTO genre_rules (kind, pattern, pattern_key, action, target_managed_genre_id) VALUES ('exact', 'Juvenile Fiction', 'juvenile fiction', 'map', $1)", [cf.id]);

  const add = async (cat, i) => (await q(
    "INSERT INTO books (title, description, categories, published_year, updated_at) VALUES ($1, 'A children''s fiction description stays.', $2, 1999, now() - interval '3 days') RETURNING id", [`CF ${i}`, cat]))[0].id;
  for (const [i, [c]] of CASES.entries()) caseIds.push(await add(c, i));
  for (const [i, c] of UNTOUCHED.entries()) untouchedIds.push(await add(c, 100 + i));
  await pool.query("INSERT INTO book_copies (book_id, condition, price, status) VALUES ($1, 'good', 7.50, 'in_stock')", [caseIds[0]]);
  const booksBefore = await q("SELECT * FROM books ORDER BY id");
  const copiesBefore = await q("SELECT * FROM book_copies ORDER BY id");
  const genresBefore = await q("SELECT * FROM managed_genres WHERE id <> $1 ORDER BY id", [cf.id]);
  ctx = { cf, exactId, wordId, otherId };

  await pool.query(SQL);

  // the managed genre and its Browse label
  const g = (await q("SELECT * FROM managed_genres WHERE id = $1", [cf.id]))[0];
  assert.equal(g.name_en, "Children's Fiction");
  assert.equal(g.browse_label_en, "Children's Fiction");
  assert.equal(g.browse_slug, "children", "the slug (old links) stays");
  assert.equal(g.browse_topic, cf.browse_topic, "the search words stay");
  assert.deepEqual([g.colour, g.icon, g.browse_order, g.show_on_browse], [cf.colour, cf.icon, cf.browse_order, cf.show_on_browse]);
  assert.deepEqual(await q("SELECT * FROM managed_genres WHERE id <> $1 ORDER BY id", [cf.id]), genresBefore, "no other genre changes");
  // rules: the exact one is renamed, the word rule and the others stay; the map rule still points at the genre
  const rules = new Map((await q("SELECT id, kind, pattern, pattern_key FROM genre_rules")).map((r) => [r.id, r]));
  assert.deepEqual([rules.get(exactId).pattern, rules.get(exactId).pattern_key], ["Children's Fiction", "children's fiction"]);
  assert.equal(rules.get(wordId).pattern, "children's fiction");
  assert.equal(rules.get(otherId).pattern, "Kids");
  assert.equal((await q("SELECT target_managed_genre_id FROM genre_rules WHERE pattern = 'Juvenile Fiction'"))[0].target_managed_genre_id, cf.id);

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
  assert.ok(byId.get(caseIds[0]).description.includes("children's fiction"), "free text is never rewritten");
  assert.deepEqual(await q("SELECT * FROM book_copies ORDER BY id"), copiesBefore, "copies and prices untouched");
  assert.equal((await q("SELECT count(*)::int AS n FROM books"))[0].n, booksBefore.length, "no book deleted");
});

test("the managed names and the books now agree: every book genre of this kind IS the managed name", async () => {
  const rows = await q(`SELECT count(*)::int AS n FROM books b, unnest(string_to_array(b.categories, ',')) g
                        WHERE btrim(g) <> 'Children''s Fiction' AND translate(btrim(g), '‘’‛ʼ′', '''''''''''') ~* '^children''s\\s+fiction$'`);
  assert.equal(rows[0].n, 0);
  const managed = (await q("SELECT name_en FROM managed_genres WHERE lower(name_en) LIKE 'children%fiction'")).map((r) => r.name_en);
  assert.deepEqual(managed, ["Children's Fiction"]);
});

test("the old value of every changed book is in categories_childrens_fiction_backup, and only those", async () => {
  const rows = await q("SELECT book_id, categories_before FROM categories_childrens_fiction_backup ORDER BY book_id");
  assert.deepEqual(rows.map((r) => [r.book_id, r.categories_before]), caseIds.map((id, i) => [id, CASES[i][0]]));
  const b = await q("SELECT on_table, row_id, on_column, value_before FROM children_fiction_rename_backup ORDER BY on_table, on_column, row_id");
  assert.deepEqual(b.map((r) => [r.on_table, r.on_column, r.value_before]), [
    ["genre_rules", "pattern", "Children's fiction"], ["managed_genres", "browse_label_en", "children’s fiction"], ["managed_genres", "name_en", "Children's fiction"],
  ]);
});

test("ONE Admin activity line", async () => {
  const lines = await auditLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].actor_label, "migration 119");
  assert.equal(lines[0].detail, `Children's fiction spelled Children's Fiction on ${CASES.length} books and in the genre list. Old values kept in tables categories_childrens_fiction_backup and children_fiction_rename_backup. No book, copy or price was deleted.`);
});

test("a second run changes nothing and writes no second line", async () => {
  const snap = async () => ({
    books: await q("SELECT * FROM books ORDER BY id"), genres: await q("SELECT * FROM managed_genres ORDER BY id"),
    rules: await q("SELECT * FROM genre_rules ORDER BY id"), b1: await q("SELECT * FROM categories_childrens_fiction_backup ORDER BY book_id"),
    b2: await q("SELECT * FROM children_fiction_rename_backup ORDER BY on_table, on_column, row_id"),
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
  assert.equal((await q("SELECT categories FROM books WHERE id = $1", [caseIds[7]]))[0].categories, "Poetry, Children's fiction");
  assert.equal((await q("SELECT categories FROM books WHERE id = $1", [caseIds[3]]))[0].categories, "Children’s fiction");
  const g = (await q("SELECT name_en, browse_label_en FROM managed_genres WHERE id = $1", [ctx.cf.id]))[0];
  assert.deepEqual([g.name_en, g.browse_label_en], ["Children's fiction", "children’s fiction"]);
  assert.equal((await q("SELECT pattern FROM genre_rules WHERE id = $1", [ctx.exactId]))[0].pattern, "Children's fiction");
});

test("the usual Browse label (Children's Books) and a label the admin wrote herself are left alone", async () => {
  await pool.query("DELETE FROM categories_childrens_fiction_backup; DELETE FROM children_fiction_rename_backup; DELETE FROM admin_audit_log WHERE action = 'books.childrens_fiction_spelling'");
  await pool.query("UPDATE managed_genres SET browse_label_en = 'Children''s Books' WHERE id = $1", [ctx.cf.id]);
  await pool.query(SQL);
  const g = (await q("SELECT name_en, browse_label_en FROM managed_genres WHERE id = $1", [ctx.cf.id]))[0];
  assert.deepEqual([g.name_en, g.browse_label_en], ["Children's Fiction", "Children's Books"]);
});

test("a duplicate managed genre (curly apostrophe) is merged into one: its rules move, its row is saved, books are respelled", async () => {
  await pool.query("DELETE FROM categories_childrens_fiction_backup; DELETE FROM children_fiction_rename_backup; DELETE FROM admin_audit_log WHERE action = 'books.childrens_fiction_spelling'");
  await pool.query("UPDATE managed_genres SET name_en = 'Children''s fiction' WHERE id = $1", [ctx.cf.id]);
  const dup = (await q("INSERT INTO managed_genres (name_en, sort_order, browse_slug, show_on_browse) VALUES ('Children’s fiction', 902, 'children-two', FALSE) RETURNING id"))[0].id;
  await pool.query("INSERT INTO genre_rules (kind, pattern, pattern_key, action, target_managed_genre_id) VALUES ('exact', 'Little ones', 'little ones', 'map', $1)", [dup]);
  const [{ id }] = await q("INSERT INTO books (title, categories) VALUES ('Late', 'Children’s fiction, Poetry') RETURNING id");
  await pool.query(SQL);
  assert.deepEqual((await q("SELECT name_en FROM managed_genres WHERE lower(name_en) LIKE 'children%fiction'")).map((r) => r.name_en), ["Children's Fiction"], "one managed genre left");
  assert.equal((await q("SELECT id FROM managed_genres WHERE id = $1", [dup])).length, 0, "the curly duplicate is gone");
  assert.equal((await q("SELECT target_managed_genre_id FROM genre_rules WHERE pattern = 'Little ones'"))[0].target_managed_genre_id, ctx.cf.id, "its rule points at the survivor");
  assert.equal((await q("SELECT categories FROM books WHERE id = $1", [id]))[0].categories, "Children's Fiction, Poetry");
  const saved = await q("SELECT on_column, value_before FROM children_fiction_rename_backup WHERE on_table = 'managed_genres' AND row_id = $1", [dup]);
  assert.deepEqual(saved.map((r) => r.on_column), ["row"]);
  assert.equal(JSON.parse(saved[0].value_before).name_en, "Children’s fiction", "the whole row is saved");
  assert.equal((await q("SELECT value_before FROM children_fiction_rename_backup WHERE on_table = 'genre_rules' AND on_column = 'target_managed_genre_id'"))[0].value_before, String(dup));
});

test("an existing exact Children's Fiction rule is never duplicated: the rename of the other is skipped", async () => {
  await pool.query("DELETE FROM categories_childrens_fiction_backup; DELETE FROM children_fiction_rename_backup; DELETE FROM admin_audit_log WHERE action = 'books.childrens_fiction_spelling'");
  await pool.query("UPDATE genre_rules SET pattern = 'Children’s fiction', pattern_key = 'children’s fiction' WHERE id = $1", [ctx.exactId]);
  await pool.query("INSERT INTO genre_rules (kind, pattern, pattern_key, action) VALUES ('exact', 'Children''s Fiction', 'children''s fiction', 'keep') ON CONFLICT DO NOTHING");
  await pool.query(SQL);
  assert.equal((await q("SELECT pattern FROM genre_rules WHERE id = $1", [ctx.exactId]))[0].pattern, "Children’s fiction", "no duplicate rule");
});

test("a database without the genre: nothing breaks, nothing changes, one line saying 0", async () => {
  await pool.query("DELETE FROM genre_rules; DELETE FROM managed_genres WHERE lower(name_en) LIKE 'children%fiction'; DELETE FROM books WHERE categories ~* 'children.s\\s+fiction'; DELETE FROM admin_audit_log WHERE action = 'books.childrens_fiction_spelling'");
  const before_ = { books: await q("SELECT * FROM books ORDER BY id"), genres: await q("SELECT * FROM managed_genres ORDER BY id") };
  await pool.query(SQL);
  await pool.query(SQL);
  assert.deepEqual(await q("SELECT * FROM books ORDER BY id"), before_.books);
  assert.deepEqual(await q("SELECT * FROM managed_genres ORDER BY id"), before_.genres);
  const lines = await auditLines();
  assert.equal(lines.length, 1);
  assert.ok(lines[0].detail.startsWith("Children's fiction spelled Children's Fiction on 0 books"));
});

test("the SQL spelling and the JS spelling of children's fiction agree", async () => {
  const SAMPLES = ["Children's fiction", "children’s FICTION", "Children‘s fiction", "Children`s fiction", "Children's  fiction", "Children’s Fiction§", "Childrens fiction", "Chidren's Fiction",
    "Children's fiction books", "Children's", "Fiction", "Children's-fiction", "Children/s fiction"];
  for (const s of SAMPLES) {
    // JS tests the cleaned name (it also drops the stray §); SQL tests the stored element, so compare on the cleaned form
    const { cleanGenreName } = require("../../src/lib/genreClean");
    const sqlSays = (await q("SELECT translate(btrim($1), E'‘’‛ʼ′`´', repeat('''', 7)) ~* '^children''s\\s+fiction$' AS v", [cleanGenreName(s)]))[0].v;
    assert.equal(sqlSays, isChildrensFictionVariant(s), JSON.stringify(s));
  }
});
