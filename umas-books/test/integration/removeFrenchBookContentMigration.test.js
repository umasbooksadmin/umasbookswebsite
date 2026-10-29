// Migration 107: books lose their French description and French genre (Sharon, 2026-10-28). The French values are
// COPIED into book_french_backup first, then books.description_fr / categories_fr are emptied, and one Admin activity
// line says how many books changed. Collections, blog posts and every other table keep their French. A second run
// changes nothing and logs nothing. The restore recipe in docs/runbook.md puts the values back exactly.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { prepareDatabase } = require("../helpers/testDatabase");

// Migration 108 drops the two columns, so this file tests 107 on a database migrated only up to 107.
const db = prepareDatabase("remove_french_books", { isolated: true, migrateUpTo: 107 });
const { pool } = require("../../src/db");
before(() => db.create());
after(async () => { await pool.end(); db.drop(); });

const FILE = path.join(__dirname, "..", "..", "migrations", "107_remove_french_book_content.sql");
const RUNBOOK = path.join(__dirname, "..", "..", "..", "docs", "runbook.md");
const q = async (sql, params) => (await pool.query(sql, params)).rows;

// The SQL block of the runbook's restore recipe (the one between the two markers), so the test runs exactly what the
// runbook tells Sharon to paste.
function runbookRestoreSql() {
  const text = fs.readFileSync(RUNBOOK, "utf8");
  const m = text.match(/<!-- restore-french-books:start -->\s*```sql\n([\s\S]*?)```\s*<!-- restore-french-books:end -->/);
  assert.ok(m, "docs/runbook.md has the restore recipe between the restore-french-books markers");
  return m[1];
}

const auditLines = () => q("SELECT actor_label, action, target_type, detail FROM admin_audit_log WHERE action = 'books.french_removed' ORDER BY id");
const bookFrench = () => q("SELECT id, title, description, categories, description_fr, categories_fr FROM books ORDER BY id");
const backup = () => q("SELECT book_id, description_fr, categories_fr FROM book_french_backup ORDER BY book_id");

let ids = {};
let others = {};

test("on a database with no French book text (the migration ran at create), the table exists and the line says 0 books", async () => {
  const cols = await q(
    "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'book_french_backup' ORDER BY ordinal_position"
  );
  assert.deepEqual(cols.map((c) => c.column_name), ["book_id", "description_fr", "categories_fr", "saved_at"]);
  const lines = await auditLines();
  assert.equal(lines.length, 1);
  assert.equal(lines[0].detail, "French book descriptions and genres removed: 0 books. A copy is kept in table book_french_backup.");
  // The book columns are still there (not dropped).
  const bookCols = (await q("SELECT column_name FROM information_schema.columns WHERE table_name = 'books' AND column_name IN ('description_fr', 'categories_fr') ORDER BY 1")).map((r) => r.column_name);
  assert.deepEqual(bookCols, ["categories_fr", "description_fr"]);
});

test("seeded books: the French is copied, then emptied; other tables untouched; the line has the right N", async () => {
  const add = async (title, d, dFr, c, cFr) => (await q(
    "INSERT INTO books (title, description, description_fr, categories, categories_fr) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [title, d, dFr, c, cFr]
  ))[0].id;
  ids = {
    both: await add("Both", "An English text.", "Un texte français.", "Mystery, Fiction", "Policier, Fiction"),
    descOnly: await add("Description only", "English only genre.", "Seulement la description.", "Poetry", null),
    genreOnly: await add("Genre only", null, null, "History", "Histoire"),
    neither: await add("Neither", "Plain English.", null, "Travel", null),
  };
  const { rows: [col] } = await pool.query(
    `INSERT INTO curated_collections (slug, title_en, description_en, title_fr, description_fr)
     VALUES ('mig-107', 'Shelf', 'English shelf', 'Étagère', 'Étagère française') RETURNING id`
  );
  await pool.query("INSERT INTO curated_collection_books (collection_id, book_id, status, reason, reason_fr) VALUES ($1, $2, 'approved', 'Why', 'Pourquoi')", [col.id, ids.both]);
  const { rows: [post] } = await pool.query(
    "INSERT INTO blog_posts (slug, title, body, title_fr, excerpt_fr, body_fr) VALUES ('mig-107', 'Post', '<p>EN</p>', 'Billet', 'Extrait', '<p>FR</p>') RETURNING id"
  );
  others = {
    collection: await q("SELECT * FROM curated_collections WHERE id = $1", [col.id]),
    collectionBook: await q("SELECT collection_id, book_id, reason, reason_fr FROM curated_collection_books WHERE collection_id = $1", [col.id]),
    post: await q("SELECT * FROM blog_posts WHERE id = $1", [post.id]),
    managed: await q("SELECT * FROM managed_genres ORDER BY id"),
  };
  const before = await bookFrench();

  await pool.query(fs.readFileSync(FILE, "utf8"));

  const after = await bookFrench();
  assert.ok(after.every((b) => b.description_fr === null && b.categories_fr === null), "every book's French columns are NULL");
  // The English stays exactly as it was.
  assert.deepEqual(after.map((b) => [b.id, b.title, b.description, b.categories]), before.map((b) => [b.id, b.title, b.description, b.categories]));
  // The backup holds exactly the removed values: one row per book that had any French, the other value NULL.
  assert.deepEqual(await backup(), [
    { book_id: ids.both, description_fr: "Un texte français.", categories_fr: "Policier, Fiction" },
    { book_id: ids.descOnly, description_fr: "Seulement la description.", categories_fr: null },
    { book_id: ids.genreOnly, description_fr: null, categories_fr: "Histoire" },
  ]);
  const lines = await auditLines();
  assert.equal(lines.length, 2, "one new Admin activity line");
  assert.deepEqual(lines[1], {
    actor_label: "migration 107", action: "books.french_removed", target_type: "book",
    detail: "French book descriptions and genres removed: 3 books. A copy is kept in table book_french_backup.",
  });
  // Collections, the collection's reasons, the blog post and the managed genres keep their French.
  assert.deepEqual(await q("SELECT * FROM curated_collections WHERE id = $1", [others.collection[0].id]), others.collection);
  assert.deepEqual(await q("SELECT collection_id, book_id, reason, reason_fr FROM curated_collection_books WHERE collection_id = $1", [others.collection[0].id]), others.collectionBook);
  assert.deepEqual(await q("SELECT * FROM blog_posts WHERE id = $1", [others.post[0].id]), others.post);
  assert.deepEqual(await q("SELECT * FROM managed_genres ORDER BY id"), others.managed);
});

test("a second run changes nothing and writes no second Admin activity line", async () => {
  const books = await bookFrench();
  const saved = await q("SELECT * FROM book_french_backup ORDER BY book_id");
  await pool.query(fs.readFileSync(FILE, "utf8"));
  assert.deepEqual(await bookFrench(), books);
  assert.deepEqual(await q("SELECT * FROM book_french_backup ORDER BY book_id"), saved, "the backup (and its saved_at) is unchanged");
  assert.equal((await auditLines()).length, 2);
});

test("one book: the line says '1 book'", async () => {
  const { rows: [b] } = await pool.query("INSERT INTO books (title, description_fr) VALUES ('Single', 'Seul') RETURNING id");
  await pool.query(fs.readFileSync(FILE, "utf8"));
  const lines = await auditLines();
  assert.equal(lines.at(-1).detail, "French book descriptions and genres removed: 1 book. A copy is kept in table book_french_backup.");
  assert.deepEqual(await q("SELECT description_fr FROM book_french_backup WHERE book_id = $1", [b.id]), [{ description_fr: "Seul" }]);
  await pool.query("DELETE FROM books WHERE id = $1", [b.id]);
  assert.equal((await q("SELECT count(*)::int AS n FROM book_french_backup WHERE book_id = $1", [b.id]))[0].n, 0, "deleting a book deletes its backup row (ON DELETE CASCADE)");
});

test("RESTORE: the runbook recipe puts every value back exactly, and running it twice is harmless", async () => {
  const sql = runbookRestoreSql();
  await pool.query(sql);
  const restored = await q("SELECT id, description_fr, categories_fr FROM books WHERE id = ANY($1) ORDER BY id", [Object.values(ids)]);
  assert.deepEqual(restored, [
    { id: ids.both, description_fr: "Un texte français.", categories_fr: "Policier, Fiction" },
    { id: ids.descOnly, description_fr: "Seulement la description.", categories_fr: null },
    { id: ids.genreOnly, description_fr: null, categories_fr: "Histoire" },
    { id: ids.neither, description_fr: null, categories_fr: null },
  ]);
  await pool.query(sql);
  assert.deepEqual(await q("SELECT id, description_fr, categories_fr FROM books WHERE id = ANY($1) ORDER BY id", [Object.values(ids)]), restored);
  // The recipe never overwrites a French value a book has now.
  await pool.query("UPDATE books SET description_fr = 'Typed since' WHERE id = $1", [ids.both]);
  await pool.query(sql);
  assert.equal((await q("SELECT description_fr FROM books WHERE id = $1", [ids.both]))[0].description_fr, "Typed since");
});
