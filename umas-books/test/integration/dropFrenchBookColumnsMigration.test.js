// Migration 108: the unused French book columns are dropped (books.description_fr, books.categories_fr,
// managed_genres.name_fr, managed_genres.browse_label_fr). Tested on a database migrated only up to 107 and seeded
// the way a live one could look, including French values that are NOT in book_french_backup (the safety net must copy
// them there before dropping) and one that DIFFERS from the saved one (the migration must stop, dropping nothing).
// book_french_backup and every other table's French stay. A second run is a no-op with no second Admin activity line.
// The runbook's restore recipe (re-add the columns, fill them from the backup) puts the values back exactly.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { prepareDatabase } = require("../helpers/testDatabase");

const db = prepareDatabase("drop_french_book_columns", { isolated: true, migrateUpTo: 107 });
const { pool } = require("../../src/db");
const { runMigrations } = require("../../src/migrate");
before(() => db.create());
after(async () => { await pool.end(); db.drop(); });

const FILE = path.join(__dirname, "..", "..", "migrations", "108_drop_french_book_columns.sql");
const RUNBOOK = path.join(__dirname, "..", "..", "..", "docs", "runbook.md");
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const omit = (row, ...keys) => Object.fromEntries(Object.entries(row).filter(([k]) => !keys.includes(k)));
const DETAIL = "French book columns dropped (books.description_fr, books.categories_fr, managed_genres name_fr / browse_label_fr). "
  + "Book text, copies and prices are untouched. The old French values are kept in table book_french_backup.";

const columns = async (table) => (await q(
  "SELECT column_name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = $1 ORDER BY column_name", [table]
)).map((r) => r.column_name);
const backup = () => q("SELECT book_id, description_fr, categories_fr, saved_at FROM book_french_backup ORDER BY book_id");
const auditLines = () => q("SELECT actor_label, action, target_type, detail FROM admin_audit_log WHERE action = 'books.french_columns_dropped' ORDER BY id");
// Everything a book is, minus the two French columns (so before / after compare on what stays).
const bookRows = () => q("SELECT * FROM books ORDER BY id").then((rows) => rows.map((r) => omit(r, "description_fr", "categories_fr", "cover_origin", "cover_checked_at") /* 111 adds these after the 107 snapshot */));

function runbookRestoreSql() {
  const text = fs.readFileSync(RUNBOOK, "utf8");
  const m = text.match(/<!-- restore-french-books:start -->\s*```sql\n([\s\S]*?)```\s*<!-- restore-french-books:end -->/);
  assert.ok(m, "docs/runbook.md has the restore recipe between the restore-french-books markers");
  return m[1];
}

const ids = {};
let others = {};
let managedBefore = [];
let booksBefore = [];
let copiesBefore = [];

test("the database is at 107: the four columns exist, 107's backup table is there", async () => {
  assert.ok((await columns("books")).includes("description_fr"));
  assert.ok((await columns("books")).includes("categories_fr"));
  assert.ok((await columns("managed_genres")).includes("name_fr"));
  assert.ok((await columns("managed_genres")).includes("browse_label_fr"));
  assert.deepEqual(await columns("book_french_backup"), ["book_id", "categories_fr", "description_fr", "saved_at"]);
  assert.equal((await q("SELECT count(*)::int AS n FROM schema_migrations WHERE filename LIKE '108%'"))[0].n, 0);
});

test("seed books (French still in the columns, saved or not), genres, a collection, a blog post, an event, a charity", async () => {
  const add = async (title, dFr, cFr) => (await q(
    "INSERT INTO books (title, description, categories, description_fr, categories_fr) VALUES ($1, 'English text', 'Fiction', $2, $3) RETURNING id",
    [title, dFr, cFr]
  ))[0].id;
  ids.saved = await add("Saved by 107", "Texte sauvé", "Roman");
  await q("INSERT INTO book_french_backup (book_id, description_fr, categories_fr) VALUES ($1, 'Texte sauvé', 'Roman')", [ids.saved]);
  ids.unsaved = await add("Typed after 107", "Jamais sauvé", "Policier"); // no backup row: must be rescued
  ids.half = await add("Half saved", "Moitié", "Histoire");
  await q("INSERT INTO book_french_backup (book_id, description_fr, categories_fr) VALUES ($1, 'Moitié', NULL)", [ids.half]); // genre not saved
  ids.emptied = await add("Emptied by 107", null, null);
  await q("INSERT INTO book_french_backup (book_id, description_fr, categories_fr) VALUES ($1, 'Ancien texte', 'Poésie')", [ids.emptied]);
  ids.none = await add("Never French", null, null);
  await q("INSERT INTO book_copies (book_id, condition, price, status) VALUES ($1, 'good', 7.5, 'in_stock')", [ids.saved]);
  await q("UPDATE managed_genres SET name_fr = 'Roman', browse_label_fr = 'Romans' WHERE name_en = 'Fiction'");

  const { rows: [col] } = await pool.query(
    `INSERT INTO curated_collections (slug, title_en, description_en, title_fr, description_fr)
     VALUES ('mig-108', 'Shelf', 'English shelf', 'Étagère', 'Étagère française') RETURNING id`
  );
  await q("INSERT INTO curated_collection_books (collection_id, book_id, status, reason, reason_fr) VALUES ($1, $2, 'approved', 'Why', 'Pourquoi')", [col.id, ids.saved]);
  const { rows: [post] } = await pool.query(
    "INSERT INTO blog_posts (slug, title, body, title_fr, excerpt_fr, body_fr) VALUES ('mig-108', 'Post', '<p>EN</p>', 'Billet', 'Extrait', '<p>FR</p>') RETURNING id"
  );
  const { rows: [ev] } = await pool.query("INSERT INTO events (title, starts_at, title_fr, description_fr) VALUES ('Event', now(), 'Évènement', 'Une description') RETURNING id");
  const { rows: [ch] } = await pool.query("INSERT INTO charities (name, description, description_fr) VALUES ('Cause', 'EN', 'Une cause') RETURNING id");
  others = {
    collection: ["SELECT * FROM curated_collections WHERE id = $1", [col.id]],
    reasons: ["SELECT * FROM curated_collection_books WHERE collection_id = $1", [col.id]],
    post: ["SELECT * FROM blog_posts WHERE id = $1", [post.id]],
    event: ["SELECT * FROM events WHERE id = $1", [ev.id]],
    charity: ["SELECT * FROM charities WHERE id = $1", [ch.id]],
  };
  for (const k of Object.keys(others)) others[k].push(await q(...others[k]));
});

test("a French value that DIFFERS from the saved one stops the migration: nothing is dropped, nothing changes", async () => {
  const { rows: [b] } = await pool.query("INSERT INTO books (title, description_fr) VALUES ('Conflict', 'Nouveau') RETURNING id");
  await q("INSERT INTO book_french_backup (book_id, description_fr) VALUES ($1, 'Ancien')", [b.id]);
  const backupBefore = await backup();
  await assert.rejects(
    runMigrations({ endPool: false, log: () => {} }),
    /migration 108 stopped, nothing dropped: 1 book\(s\) hold a French value/
  );
  assert.ok((await columns("books")).includes("description_fr"), "the column is still there");
  assert.ok((await columns("managed_genres")).includes("name_fr"));
  assert.deepEqual(await backup(), backupBefore, "nothing was rescued either (the whole file rolled back)");
  assert.equal((await auditLines()).length, 0);
  assert.equal((await q("SELECT count(*)::int AS n FROM schema_migrations WHERE filename LIKE '108%'"))[0].n, 0, "108 is not recorded as applied");
  await q("DELETE FROM books WHERE id = $1", [b.id]); // the conflict resolved (its backup row goes with it)
});

test("the migration (through the real runner): unsaved values are copied first, then the four columns are dropped", async () => {
  managedBefore = await q("SELECT * FROM managed_genres ORDER BY id");
  booksBefore = await bookRows();
  copiesBefore = await q("SELECT * FROM book_copies ORDER BY id");
  const savedAtBefore = Object.fromEntries((await backup()).map((r) => [r.book_id, r.saved_at]));

  await runMigrations({ endPool: false, log: () => {} });

  for (const [table, gone] of [["books", ["description_fr", "categories_fr"]], ["managed_genres", ["name_fr", "browse_label_fr"]]]) {
    const cols = await columns(table);
    for (const c of gone) assert.ok(!cols.includes(c), `${table}.${c} is dropped`);
  }
  // The backup: the rows 107 / the shop had are unchanged (saved_at too), the unsaved values were added.
  const rows = await backup();
  assert.deepEqual(rows.map((r) => omit(r, "saved_at")), [
    { book_id: ids.saved, description_fr: "Texte sauvé", categories_fr: "Roman" },
    { book_id: ids.unsaved, description_fr: "Jamais sauvé", categories_fr: "Policier" },
    { book_id: ids.half, description_fr: "Moitié", categories_fr: "Histoire" },
    { book_id: ids.emptied, description_fr: "Ancien texte", categories_fr: "Poésie" },
  ]);
  for (const id of [ids.saved, ids.half, ids.emptied]) assert.deepEqual(rows.find((r) => r.book_id === id).saved_at, savedAtBefore[id]);
  // Books (everything else about them), their copies and prices: untouched.
  assert.deepEqual(await bookRows(), booksBefore);
  assert.deepEqual(await q("SELECT * FROM book_copies ORDER BY id"), copiesBefore);
  // Managed genres keep every other column and every row.
  assert.deepEqual(await q("SELECT * FROM managed_genres ORDER BY id"), managedBefore.map((r) => omit(r, "name_fr", "browse_label_fr")));
  // Other tables keep their French columns and data.
  assert.ok((await columns("curated_collections")).includes("description_fr"));
  assert.ok((await columns("curated_collection_books")).includes("reason_fr"));
  assert.ok((await columns("blog_posts")).includes("body_fr"));
  assert.ok((await columns("events")).includes("description_fr"));
  assert.ok((await columns("charities")).includes("description_fr"));
  assert.ok((await columns("genre_run_changes")).includes("old_categories_fr"), "genre run history is not touched");
  for (const [sql, params, rowsBefore] of Object.values(others)) assert.deepEqual(await q(sql, params), rowsBefore, sql);
  // One Admin activity line, with the agreed wording.
  assert.deepEqual(await auditLines(), [{ actor_label: "migration 108", action: "books.french_columns_dropped", target_type: "book", detail: DETAIL }]);
  assert.doesNotMatch(DETAIL, /removed/i, "the wording never says books were removed");
});

test("a second run is a no-op: nothing changes, no second Admin activity line", async () => {
  const saved = await backup();
  const books = await bookRows();
  await pool.query(fs.readFileSync(FILE, "utf8"));
  await pool.query(fs.readFileSync(FILE, "utf8"));
  assert.deepEqual(await backup(), saved);
  assert.deepEqual(await bookRows(), books);
  assert.equal((await auditLines()).length, 1);
});

test("RESTORE: the runbook recipe re-adds the two columns and puts every saved value back exactly; twice is harmless", async () => {
  const sql = runbookRestoreSql();
  assert.match(sql, /ALTER TABLE books ADD COLUMN IF NOT EXISTS description_fr TEXT, ADD COLUMN IF NOT EXISTS categories_fr TEXT;/);
  await pool.query(sql);
  const restored = await q("SELECT id AS book_id, description_fr, categories_fr FROM books WHERE description_fr IS NOT NULL OR categories_fr IS NOT NULL ORDER BY id");
  assert.deepEqual(restored, (await backup()).map((r) => omit(r, "saved_at")), "exactly the saved values, on exactly those books");
  assert.deepEqual((await q("SELECT description_fr, categories_fr FROM books WHERE id = $1", [ids.none]))[0], { description_fr: null, categories_fr: null });
  await pool.query(sql);
  assert.deepEqual(await q("SELECT id AS book_id, description_fr, categories_fr FROM books WHERE description_fr IS NOT NULL OR categories_fr IS NOT NULL ORDER BY id"), restored);
  // Running 108 again after a restore drops them again safely (every value is saved) and still logs only once.
  await pool.query(fs.readFileSync(FILE, "utf8"));
  assert.ok(!(await columns("books")).includes("description_fr"));
  assert.equal((await auditLines()).length, 1);
});
