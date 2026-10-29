// Migration 110: 26 AI-guessed English book descriptions (reviewed by Sharon, 2026-10-28) are cleared. Each old text is
// COPIED into cleared_book_descriptions first; a book is only cleared while its description still STARTS WITH the
// reviewed text (30 letters/digits, ignoring case, spaces and punctuation). Nothing else changes, one Admin activity line
// is written, a second run changes nothing and logs nothing, and the runbook's restore recipe puts the texts back.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { prepareDatabase } = require("../helpers/testDatabase");

const db = prepareDatabase("clear_ai_descriptions", { isolated: true, migrateUpTo: 109 });
const { pool } = require("../../src/db");
before(() => db.create());
after(async () => { await pool.end(); db.drop(); });

const FILE = path.join(__dirname, "..", "..", "migrations", "110_clear_ai_guess_descriptions.sql");
const SQL = fs.readFileSync(FILE, "utf8");
const RUNBOOK = path.join(__dirname, "..", "..", "..", "docs", "runbook.md");
const q = async (sql, params) => (await pool.query(sql, params)).rows;
const auditLines = () => q("SELECT actor_label, action, target_type, detail FROM admin_audit_log WHERE action = 'books.descriptions_cleared' ORDER BY id");

// The reviewed list, read from the migration itself.
const LIST = [...SQL.matchAll(/\((\d+), '([a-z0-9]+)'\)/g)].map((m) => [Number(m[1]), m[2]]);

// Real starting words of three reviewed books (the rest of each text is made up; only the start matters).
const OLD = {
  573: "A delightful collection of stories from the riverbank, told for young readers. Some more generated text.",
  574: "Join William Brown and his loyal gang of Outlaws as they get into scrapes. Some more generated text.",
  597: "I'm not certain of a book titled \"Freed...\" and cannot write a description without more information.",
};
// Same words, different case/punctuation/spacing: still counts as the reviewed text.
OLD[573] = "  A delightful collection of stories, from the riverbank. " + OLD[573].slice(31);
const EDITED = { id: 575, text: "Hand-written by Sharon: eleven Just William tales, with the original illustrations." };
const UNRELATED = { id: 9001, text: "A real description of an unrelated book that nobody reviewed." };
const NULLDESC = { id: 576 }; // reviewed id, but nothing to clear
const OUTSIDE = { id: 9002, text: OLD[574] }; // same text as a reviewed one, but not a reviewed book

let booksBefore;
let copiesBefore;

test("the migration reviews 26 distinct books with 30-character prefixes", () => {
  assert.equal(LIST.length, 26);
  assert.equal(new Set(LIST.map(([id]) => id)).size, 26);
  assert.ok(LIST.every(([, p]) => p.length === 30));
  assert.ok(/\(of 26 reviewed\)/.test(SQL));
});

test("the seeded texts really start with their reviewed prefixes (so the test is meaningful)", () => {
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
  for (const id of [573, 574, 597]) assert.equal(norm(OLD[id]), LIST.find(([i]) => i === id)[1]);
});

test("seed, then run migration 110", async () => {
  assert.equal((await q("SELECT count(*)::int AS n FROM schema_migrations WHERE filename LIKE '110%'"))[0].n, 0);
  const add = (id, title, description) => pool.query("INSERT INTO books (id, title, description, published_year) VALUES ($1, $2, $3, 1999)", [id, title, description]);
  for (const id of [573, 574, 597]) await add(id, `Reviewed ${id}`, OLD[id]);
  await add(EDITED.id, "Edited since", EDITED.text);
  await add(NULLDESC.id, "No description", null);
  await add(UNRELATED.id, "Unrelated", UNRELATED.text);
  await add(OUTSIDE.id, "Not on the list", OUTSIDE.text);
  for (const id of [573, 575, 9001]) await pool.query("INSERT INTO book_copies (book_id, condition, price, status) VALUES ($1, 'good', 7.50, 'in_stock')", [id]);
  booksBefore = await q("SELECT * FROM books ORDER BY id");
  copiesBefore = await q("SELECT * FROM book_copies ORDER BY id");
  await pool.query(SQL);
});

test("only the reviewed, unchanged books lost their description; nothing else changed", async () => {
  const after = new Map((await q("SELECT * FROM books ORDER BY id")).map((b) => [b.id, b]));
  const before = new Map(booksBefore.map((b) => [b.id, b]));
  for (const id of [573, 574, 597]) assert.equal(after.get(id).description, null, `book ${id}`);
  // edited since, unrelated, not on the list, already NULL: exactly as before, in every column
  for (const id of [EDITED.id, UNRELATED.id, OUTSIDE.id, NULLDESC.id]) assert.deepEqual(after.get(id), before.get(id), `book ${id}`);
  // cleared books differ in description only (titles, updated_at, etc. untouched)
  for (const id of [573, 574, 597]) {
    const { description: _a, ...rowAfter } = after.get(id);
    const { description: _b, ...rowBefore } = before.get(id);
    assert.deepEqual(rowAfter, rowBefore);
  }
  assert.equal(after.size, before.size, "no book deleted");
  assert.deepEqual(await q("SELECT * FROM book_copies ORDER BY id"), copiesBefore, "copies and prices untouched");
});

test("each cleared text is kept exactly, and only those", async () => {
  const rows = await q("SELECT book_id, description, reason, saved_at IS NOT NULL AS stamped FROM cleared_book_descriptions ORDER BY book_id");
  assert.deepEqual(rows.map((r) => [r.book_id, r.description]), [573, 574, 597].map((id) => [id, OLD[id]]));
  assert.ok(rows.every((r) => r.stamped && r.reason.length > 0));
});

test("ONE Admin activity line, wording without 'removed'", async () => {
  const lines = await auditLines();
  assert.deepEqual(lines, [{
    actor_label: "migration 110", action: "books.descriptions_cleared", target_type: "book",
    detail: "Description text cleared on 3 books (of 26 reviewed). The books themselves are untouched; the old texts are kept in table cleared_book_descriptions.",
  }]);
  assert.ok(!/removed/i.test(lines[0].detail));
});

test("a second run changes nothing and writes no second line", async () => {
  const books = await q("SELECT * FROM books ORDER BY id");
  const backup = await q("SELECT * FROM cleared_book_descriptions ORDER BY book_id");
  await pool.query(SQL);
  assert.deepEqual(await q("SELECT * FROM books ORDER BY id"), books);
  assert.deepEqual(await q("SELECT * FROM cleared_book_descriptions ORDER BY book_id"), backup);
  assert.equal((await auditLines()).length, 1);
});

test("RESTORE: the runbook recipe puts the texts back, spares a description written since, and is harmless twice", async () => {
  const text = fs.readFileSync(RUNBOOK, "utf8");
  const m = text.match(/<!-- restore-cleared-descriptions:start -->\s*```sql\n([\s\S]*?)```\s*<!-- restore-cleared-descriptions:end -->/);
  assert.ok(m, "docs/runbook.md has the recipe between the restore-cleared-descriptions markers");
  await pool.query("UPDATE books SET description = 'Written by hand after the clean-up' WHERE id = 574");
  await pool.query(m[1]);
  const got = Object.fromEntries((await q("SELECT id, description FROM books WHERE id = ANY($1)", [[573, 574, 597]])).map((r) => [r.id, r.description]));
  assert.equal(got[573], OLD[573]);
  assert.equal(got[597], OLD[597]);
  assert.equal(got[574], "Written by hand after the clean-up", "a description written since is never overwritten");
  await pool.query(m[1]);
  assert.equal((await q("SELECT description FROM books WHERE id = 573"))[0].description, OLD[573]);
});
