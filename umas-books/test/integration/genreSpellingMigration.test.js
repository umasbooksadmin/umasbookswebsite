// Migration 109 (genre spelling clean-up of the books already saved), on a database migrated only up to 108 and seeded
// with dirty and clean books: bad rows are corrected exactly as the JS (planGenreCleanup) would, the old value of each
// is in book_genre_cleanup_backup, ONE Admin activity line is written, clean books and every other column / copy / price
// are untouched, and a second run changes nothing. The runbook's restore recipe puts the old genres back.
// Also: the SQL clean-up function equals cleanGenreName, and its lists equal COMMON_GENRES and GENRE_TYPOS.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { prepareDatabase } = require("../helpers/testDatabase");

const db = prepareDatabase("genre_spelling_migration", { isolated: true, migrateUpTo: 108 });
const { pool } = require("../../src/db");
before(() => db.create());
after(async () => { await pool.end(); db.drop(); });

const FILE = path.join(__dirname, "..", "..", "migrations", "109_genre_spelling_cleanup.sql");
const SQL = fs.readFileSync(FILE, "utf8");
const RUNBOOK = path.join(__dirname, "..", "..", "..", "docs", "runbook.md");
const { cleanGenreName, buildKnown, planGenreCleanup, GENRE_TYPOS } = require("../../src/lib/genreClean");
const { COMMON_GENRES } = require("../../src/lib/bookLookup");

const q = async (sql, params) => (await pool.query(sql, params)).rows;
const LINE = "Genre spelling tidied on N books. Old values kept in table book_genre_cleanup_backup. No book, copy or price was deleted.";
const auditLines = () => q("SELECT actor_label, action, target_type, detail FROM admin_audit_log WHERE action = 'books.genre_spelling_tidied' ORDER BY id");

test("the SQL lists equal COMMON_GENRES and GENRE_TYPOS", () => {
  const sqlList = (from, to) => [...SQL.slice(SQL.indexOf(from), SQL.indexOf(to)).matchAll(/\('((?:[^']|'')*)'\)/g)].map((m) => m[1].replace(/''/g, "'"));
  assert.deepEqual(sqlList("FROM (VALUES\n  ('Fiction')", ") AS v(en)"), COMMON_GENRES);
  const block = SQL.slice(SQL.indexOf("FROM (VALUES\n  ('chidren"), SQL.indexOf(") AS t(wrong, right_name)"));
  const typos = [...block.matchAll(/\('((?:[^']|'')*)', '((?:[^']|'')*)'\)/g)].map((m) => [m[1].replace(/''/g, "'"), m[2].replace(/''/g, "'")]);
  assert.deepEqual(typos, GENRE_TYPOS);
});

const SAMPLES = [
  "Children's Fiction§", "Children’s Fiction", "  children‘s   fiction ", "§Fantasy", "* Mystery.", "“Classics”", "'Poetry'",
  "Science-Fiction", "Health & Wellbeing", "Crime (Classic)", "C++", "[Rare] Books", "Économie et gestion", "Santé & Bien-être",
  "Œuvres§", "Été±", "Kids~", "§", "", "Drama;", "Humor:", "Travel`", "Art´", "×Art÷", "WW2…", "Æsop–", "Why?", "Wow!!§",
];

test("the SQL clean-up function gives exactly what cleanGenreName gives", async () => {
  const fn = SQL.slice(SQL.indexOf("CREATE OR REPLACE FUNCTION pg_temp.genre_clean_109"), SQL.indexOf("$fn$;") + 5);
  const c = await pool.connect();
  try {
    await c.query(fn);
    for (const s of SAMPLES) {
      const { rows } = await c.query("SELECT pg_temp.genre_clean_109($1) AS v", [s]);
      assert.equal(rows[0].v, cleanGenreName(s), JSON.stringify(s));
    }
  } finally {
    await c.query("DROP FUNCTION IF EXISTS pg_temp.genre_clean_109(text)").catch(() => {});
    c.release();
  }
});

// [categories] -> the first group is dirty, the second must stay exactly as stored.
const DIRTY = [
  "Children's Fiction§", "Children’s Fiction", "Chidren's Fiction", "childrens fiction, Mystery§", "art & Design", "ART & DESIGN, Fiction",
  "Fantasy, fantasy", "Fantasy,, §, Mystery", "  §Horror ; ", "Gothic§, Gothic", "Health & Wellness§",
];
const CLEAN = ["Children's Fiction", "Fiction,Mystery", "Gothic", "Art & Design", "Crime (Classic), Science-Fiction", "Mistery", "Gothic Horrors", "§", "", null, "Économie et gestion"];

let ids = {};
let booksBefore;
let copiesBefore;
let othersBefore;

test("seed dirty and clean books with copies, a managed genre, then run migration 109", async () => {
  assert.equal((await q("SELECT count(*)::int AS n FROM schema_migrations WHERE filename LIKE '109%'"))[0].n, 0);
  await pool.query("INSERT INTO managed_genres (name_en, sort_order, browse_slug) VALUES ('Art & Design', 900, 'art-design-test')");
  const add = async (cat, i) => (await q(
    "INSERT INTO books (title, description, categories, published_year, updated_at) VALUES ($1, 'English text', $2, 1999, now() - interval '3 days') RETURNING id", [`Seed ${i}`, cat]
  ))[0].id;
  ids.dirty = [];
  for (const [i, c] of DIRTY.entries()) ids.dirty.push(await add(c, i));
  ids.clean = [];
  for (const [i, c] of CLEAN.entries()) ids.clean.push(await add(c, 100 + i));
  for (const id of [ids.dirty[0], ids.clean[0]]) {
    await pool.query("INSERT INTO book_copies (book_id, condition, price, status) VALUES ($1, 'good', 7.50, 'in_stock')", [id]);
  }
  booksBefore = await q("SELECT * FROM books ORDER BY id");
  copiesBefore = await q("SELECT * FROM book_copies ORDER BY id");
  othersBefore = await q("SELECT * FROM managed_genres ORDER BY id");

  const known = buildKnown({ common: COMMON_GENRES, managed: await q("SELECT name_en FROM managed_genres") });
  await pool.query(SQL);

  const after = await q("SELECT * FROM books ORDER BY id");
  const byId = new Map(after.map((b) => [b.id, b]));
  const beforeById = new Map(booksBefore.map((b) => [b.id, b]));
  // Exactly the JS result, for every book.
  for (const b of booksBefore) assert.equal(byId.get(b.id).categories, planGenreCleanup(b.categories, known), JSON.stringify(b.categories));
  // The ones that matter, spelled out.
  const got = (i) => byId.get(ids.dirty[i]).categories;
  assert.deepEqual(DIRTY.map((_, i) => got(i)), [
    "Children's Fiction", "Children's Fiction", "Children's Fiction", "Children's Fiction, Mystery", "Art & Design", "Art & Design, Fiction",
    "Fantasy", "Fantasy, Mystery", "Horror", "Gothic", "Health & Wellness",
  ]);
  // Clean books (and unknown genres, spacing-only, '§' alone, empty, NULL) are exactly as they were, in every column.
  for (const id of ids.clean) assert.deepEqual(byId.get(id), beforeById.get(id));
  // Dirty books differ in categories ONLY (not even updated_at).
  for (const id of ids.dirty) {
    const { categories: _a, ...rowAfter } = byId.get(id);
    const { categories: _b, ...rowBefore } = beforeById.get(id);
    assert.deepEqual(rowAfter, rowBefore);
  }
  assert.deepEqual(await q("SELECT * FROM book_copies ORDER BY id"), copiesBefore, "copies and prices untouched");
  assert.deepEqual(await q("SELECT * FROM managed_genres ORDER BY id"), othersBefore);
  assert.equal((await q("SELECT count(*)::int AS n FROM books"))[0].n, booksBefore.length, "no book deleted");
});

test("every changed book's old value is in book_genre_cleanup_backup, and only those", async () => {
  const rows = await q("SELECT book_id, categories_before, saved_at IS NOT NULL AS stamped FROM book_genre_cleanup_backup ORDER BY book_id");
  assert.deepEqual(rows.map((r) => [r.book_id, r.categories_before]), ids.dirty.map((id, i) => [id, DIRTY[i]]));
  assert.ok(rows.every((r) => r.stamped));
});

test("ONE Admin activity line, wording without 'removed'", async () => {
  const lines = await auditLines();
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], {
    actor_label: "migration 109", action: "books.genre_spelling_tidied", target_type: "book",
    detail: `Genre spelling tidied on ${DIRTY.length} books. Old values kept in table book_genre_cleanup_backup. No book, copy or price was deleted.`,
  });
  assert.ok(!/removed/i.test(lines[0].detail));
  assert.ok(LINE.startsWith("Genre spelling tidied on"));
});

test("a second run changes nothing and writes no second line", async () => {
  const books = await q("SELECT * FROM books ORDER BY id");
  const backup = await q("SELECT * FROM book_genre_cleanup_backup ORDER BY book_id");
  await pool.query(SQL);
  assert.deepEqual(await q("SELECT * FROM books ORDER BY id"), books);
  assert.deepEqual(await q("SELECT * FROM book_genre_cleanup_backup ORDER BY book_id"), backup);
  assert.equal((await auditLines()).length, 1);
});

test("RESTORE: the runbook recipe puts the old genres back, and running it twice is harmless", async () => {
  const text = fs.readFileSync(RUNBOOK, "utf8");
  const m = text.match(/<!-- restore-genre-spelling:start -->\s*```sql\n([\s\S]*?)```\s*<!-- restore-genre-spelling:end -->/);
  assert.ok(m, "docs/runbook.md has the recipe between the restore-genre-spelling markers");
  await pool.query(m[1]);
  const restored = await q("SELECT id, categories FROM books WHERE id = ANY($1) ORDER BY id", [ids.dirty]);
  assert.deepEqual(restored.map((r) => r.categories), DIRTY);
  await pool.query(m[1]);
  assert.deepEqual((await q("SELECT categories FROM books WHERE id = ANY($1) ORDER BY id", [ids.dirty])).map((r) => r.categories), DIRTY);
});
