// Migration 107 (genre clean-up of the books already saved) on a seeded database: the bad rows are corrected, good rows
// and unknown genres are left alone, a second run changes nothing, and the count is recorded in Admin activity and as a
// run of Admin > Genres (with Undo). Also: the SQL gives exactly what the JS gives (planGenreCleanup), its clean-up
// function equals cleanGenreName, and its list of known genres equals the JS lists (so they cannot drift).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { adminHarness } = require("../helpers/adminHarness");
const h = adminHarness("genre_cleanup_migration", ["genres", "audit"], { isolated: true });
const { cleanGenreName, buildKnown, planGenreCleanup } = require("../../src/lib/genreClean");
const { GENRE_ALIASES_FR, COMMON_GENRES, COMMON_GENRES_FR } = require("../../src/lib/bookLookup");

const SQL = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "107_genre_cleanup.sql"), "utf8");

before(() => h.start());
after(() => h.stop());

const q = async (sql, params) => (await h.pool.query(sql, params)).rows;
// The whole file in one call, on one connection (it uses temporary tables), in a transaction like the runner.
async function runMigration() {
  const c = await h.pool.connect();
  try {
    await c.query("BEGIN");
    await c.query(SQL);
    await c.query("COMMIT");
  } catch (err) {
    await c.query("ROLLBACK");
    throw err;
  } finally {
    c.release();
  }
}

test("the SQL list of known genres equals GENRE_ALIASES_FR + COMMON_GENRES / COMMON_GENRES_FR", () => {
  const block = SQL.slice(SQL.indexOf("FROM (VALUES"), SQL.indexOf(") AS v(list, ord, en, fr)"));
  const rows = [...block.matchAll(/\('(alias|taxonomy)', (\d+), '((?:[^']|'')*)', '((?:[^']|'')*)'\)/g)]
    .map((m) => [m[1], Number(m[2]), m[3].replace(/''/g, "'"), m[4].replace(/''/g, "'")]);
  const expected = [
    ...GENRE_ALIASES_FR.map(([en, fr], i) => ["alias", i + 1, en, fr]),
    ...COMMON_GENRES.map((en, i) => ["taxonomy", i + 1, en, COMMON_GENRES_FR[i]]),
  ];
  assert.deepEqual(rows, expected);
});

const SAMPLES = [
  "Children's Fiction§", "Children’s Fiction", "  children‘s   fiction ", "§Fantasy", "* Mystery.", "“Classics”", "'Poetry'",
  "Science-Fiction", "Health & Wellbeing", "Crime (Classic)", "C++", "[Rare] Books", "Économie et gestion", "Santé & Bien-être",
  "Œuvres§", "Été±", "Fiction jeunesse", "Kids~", "§", "", "Drama;", "Humor:", "Travel`", "Art´", "×Art÷", "WW2…", "Æsop–",
];

test("the SQL clean-up function gives exactly what cleanGenreName gives", async () => {
  const fn = SQL.slice(SQL.indexOf("CREATE OR REPLACE FUNCTION pg_temp.genre_clean_107"), SQL.indexOf("$fn$;") + 5);
  const c = await h.pool.connect();
  try {
    await c.query(fn);
    for (const s of SAMPLES) {
      const { rows } = await c.query("SELECT pg_temp.genre_clean_107($1) AS v", [s]);
      assert.equal(rows[0].v, cleanGenreName(s), JSON.stringify(s));
    }
  } finally {
    await c.query("DROP FUNCTION IF EXISTS pg_temp.genre_clean_107(text)").catch(() => {});
    c.release();
  }
});

const SEED = [
  // [categories, categories_fr] -> bad rows
  ["Children's Fiction§", "Children's Fiction§"],
  ["Children’s Fiction", "Children’s Fiction"],
  ["Children's Fiction", "Children's Fiction"],
  ["Children's Fiction", null],
  ["children’s fiction, Mystery§", "Fiction jeunesse, Policier"],
  ["Fantasy, Fiction", "Fantasy, Fiction§"],
  ["Health & Wellness", "Health & Wellness"],
  ["Gothic§", "Roman gothique"],
  ["Children's Fiction§, Children's Fiction", "Fiction jeunesse"],
  // good rows and unknown genres: untouched
  ["Children's Fiction", "Fiction jeunesse"],
  ["Fiction,Mystery", "Fiction,Policier"],
  ["Gothic", null],
  ["Gothic", "Gothic"],
  ["Crime (Classic), Science-Fiction", "Polar (classique), Science-fiction"],
  ["Santé & Bien-être", null],
  ["§", "§"],
  [null, null],
  ["Économie et gestion", "Économie et gestion"],
];

test("bad rows are corrected exactly as the JS would, good rows and unknown genres are untouched, the run is recorded", async () => {
  const auditBefore = await q("SELECT * FROM admin_audit_log WHERE action = 'genre.cleanup' ORDER BY id");
  assert.equal(auditBefore.length, 1, "the deploy's own run of 107 (empty database) left one line");
  assert.match(auditBefore[0].detail, /^Genre clean-up: 0 books corrected/);

  const ids = [];
  for (const [en, fr] of SEED) {
    const { rows } = await h.pool.query("INSERT INTO books (title, categories, categories_fr, updated_at) VALUES ($1, $2, $3, now() - interval '1 day') RETURNING id", [`Seed ${ids.length}`, en, fr]);
    ids.push(rows[0].id);
  }
  const known = buildKnown({ aliases: GENRE_ALIASES_FR, common: COMMON_GENRES, commonFr: COMMON_GENRES_FR, managed: await q("SELECT name_en, name_fr FROM managed_genres ORDER BY sort_order, id") });
  const expected = SEED.map(([en, fr]) => planGenreCleanup(en, fr, known));

  await runMigration();

  const after = await q("SELECT id, categories, categories_fr, updated_at > now() - interval '1 hour' AS touched FROM books WHERE id = ANY($1) ORDER BY id", [ids]);
  after.forEach((b, i) => assert.deepEqual({ en: b.categories, fr: b.categories_fr }, expected[i], `row ${i}: ${JSON.stringify(SEED[i])}`));

  // The ones that matter, spelled out.
  const at = (i) => ({ en: after[i].categories, fr: after[i].categories_fr });
  for (const i of [0, 1, 2, 3]) assert.deepEqual(at(i), { en: "Children's Fiction", fr: "Fiction jeunesse" }, `row ${i}`);
  assert.deepEqual(at(4), { en: "Children's Fiction, Mystery", fr: "Fiction jeunesse, Policier" });
  assert.deepEqual(at(5), { en: "Fantasy, Fiction", fr: "Fantasy, Fiction" });
  assert.deepEqual(at(6), { en: "Health & Wellness", fr: "Santé & Bien-être" });
  assert.deepEqual(at(7), { en: "Gothic", fr: "Roman gothique" });
  assert.deepEqual(at(8), { en: "Children's Fiction", fr: "Fiction jeunesse" });
  const changed = [0, 1, 2, 3, 4, 5, 6, 7, 8];
  after.forEach((b, i) => {
    const untouched = { en: SEED[i][0], fr: SEED[i][1] };
    if (changed.includes(i)) assert.notDeepEqual(at(i), untouched, `row ${i} changed`);
    else assert.deepEqual(at(i), untouched, `row ${i} untouched`);
    assert.equal(b.touched, changed.includes(i), `row ${i}: only changed rows are written`);
  });

  const audit = await q("SELECT * FROM admin_audit_log WHERE action = 'genre.cleanup' ORDER BY id");
  assert.equal(audit.length, 2);
  const line = audit[1];
  const changedIds = changed.map((i) => ids[i]);
  const [run] = await q("SELECT * FROM genre_runs ORDER BY id DESC LIMIT 1");
  assert.equal(run.books_changed, changed.length);
  assert.equal(run.status, "done");
  assert.equal(line.target_type, "genre_run");
  assert.equal(line.target_id, run.id);
  assert.equal(line.detail, `Genre clean-up: ${changed.length} books corrected. Before and after of each book (and Undo): Admin > Genres, run ${run.id}. Book ids: ${changedIds.join(", ")}.`);
  const recorded = await q("SELECT book_id, old_categories, old_categories_fr, new_categories, new_categories_fr FROM genre_run_changes WHERE run_id = $1 ORDER BY book_id", [run.id]);
  assert.deepEqual(recorded.map((r) => r.book_id), changedIds);
  assert.deepEqual(recorded.map((r) => [r.old_categories, r.old_categories_fr]), changed.map((i) => SEED[i]));

  // Sharon sees it: Admin activity and the run page of Admin > Genres.
  const page = await h.get("/admin/audit");
  assert.equal(page.res.status, 200);
  assert.ok(page.text.includes(`Genre clean-up: ${changed.length} books corrected`));
  const runPage = await h.get(`/admin/genres/runs/${run.id}`);
  assert.equal(runPage.res.status, 200);
  assert.ok(runPage.text.includes("migration 107"), "the run page says what made it");
  assert.ok(runPage.text.includes("Fiction jeunesse"), "the examples show the French-only changes too");
  assert.ok(runPage.text.includes("Undo this run"));
});

test("running it a second time changes nothing and records nothing", async () => {
  const before = await q("SELECT id, categories, categories_fr, updated_at FROM books ORDER BY id");
  const runs = await q("SELECT count(*)::int AS n FROM genre_runs");
  const audit = await q("SELECT count(*)::int AS n FROM admin_audit_log WHERE action = 'genre.cleanup'");
  await runMigration();
  assert.deepEqual(await q("SELECT id, categories, categories_fr, updated_at FROM books ORDER BY id"), before);
  assert.deepEqual(await q("SELECT count(*)::int AS n FROM genre_runs"), runs);
  assert.deepEqual(await q("SELECT count(*)::int AS n FROM admin_audit_log WHERE action = 'genre.cleanup'"), audit);
});

test("Update all books afterwards finds nothing left to change in what the clean-up did", async () => {
  const { planRun } = require("../../src/lib/genreRun");
  const plan = await planRun(h.pool);
  assert.equal(plan.count, 0, JSON.stringify(plan.examples));
});
