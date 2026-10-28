// Admin > Genres (/admin/genres), end to end in-process on a database of this file's own:
// the found-genres aggregate, managed genres and rule CRUD (with audit), the preview that equals the apply, an apply that
// changes exactly the expected books (200 noisy ones), never a French genre (books have none since 2026-10-28), unmapped genres untouched, idempotency, Undo
// (and Undo skipping books edited since), the lock that blocks two runs, the save paths applying the rules, the AI
// suggestion flow with a mocked AI, and the Genre filter of the admin Inventory.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const { adminHarness } = require("../helpers/adminHarness");
const h = adminHarness("genres_admin", ["genres", "inventory"], { isolated: true });
const admin = require("../../src/lib/genreAdmin");
const run = require("../../src/lib/genreRun");
const { suggestSlots } = require("../../src/lib/genreSuggest");
const { applyRulesToBook, loadRules } = require("../../src/lib/genreRules");
const intake = require("../../src/lib/inventoryIntake");
const { isbn13From } = require("../helpers/isbn");
const { settled } = require("../../src/lib/afterResponse");

const realFetch = global.fetch;
before(async () => {
  global.fetch = async (url, opts) => {
    if (String(url).startsWith("http://127.0.0.1")) return realFetch(url, opts);
    throw new Error("no outbound requests in this test");
  };
  await h.start();
});
after(async () => { global.fetch = realFetch; await settled(); await h.stop(); });

const q = h.q;
const audits = (action) => q("SELECT * FROM admin_audit_log WHERE action = $1 ORDER BY id", [action]);
const cats = async (id) => (await q("SELECT categories, categories_fr, updated_at FROM books WHERE id = $1", [id]))[0];

const NOISY = [
  "Children's Books, Fiction", "Children's Fiction", "Juvenile Fiction", "Fiction, General", "Childrens", "Children’s Books",
  "Mystery", "Zoology", "Childhood", null, "fiction", "Non-fiction, History", "Children, Children's Books",
];

let childrenId;
async function reset() {
  await q("DELETE FROM genre_run_changes");
  await q("DELETE FROM genre_runs");
  await q("DELETE FROM genre_rules");
  await q("DELETE FROM managed_genres WHERE lower(name_en) = 'children'");
  await q("DELETE FROM admin_audit_log");
  await q("DELETE FROM book_copies");
  await q("DELETE FROM books");
  admin.clearAll(h.pool);
}
beforeEach(reset);

async function seedBooks(n = 200) {
  const ids = [];
  for (let i = 0; i < n; i++) {
    const c = NOISY[i % NOISY.length];
    const [b] = await q("INSERT INTO books (title, categories, categories_fr) VALUES ($1, $2, $3) RETURNING id", [`Noisy ${i}`, c, c ? "x" : null]);
    ids.push(b.id);
  }
  return ids;
}

// The managed genre "Children" and the three rules the maintainer asked for.
async function childrenRules() {
  const added = await admin.addManaged(h.pool, { nameEn: "Children", nameFr: "Jeunesse" });
  assert.equal(added.ok, true);
  childrenId = added.id;
  assert.equal((await admin.saveRule(h.pool, { kind: "contains-word", pattern: "Children", target: `m:${childrenId}` })).ok, true);
  assert.equal((await admin.saveRule(h.pool, { kind: "exact", pattern: "Juvenile Fiction", target: `m:${childrenId}` })).ok, true);
  assert.equal((await admin.saveRule(h.pool, { kind: "contains-word", pattern: "General", target: "remove" })).ok, true);
}

// ---------------------------------------------------------------- migration seed

test("the seed is the current canonical lists (same order), and nothing is mapped yet", async () => {
  const { COMMON_GENRES } = require("../../src/lib/bookLookup");
  const rows = await q("SELECT name_en FROM managed_genres ORDER BY sort_order, id");
  assert.deepEqual(rows.slice(0, COMMON_GENRES.length).map((r) => r.name_en), COMMON_GENRES);
  assert.deepEqual(rows.slice(COMMON_GENRES.length).map((r) => r.name_en), ["Health & Wellness", "Home & Garden"], "the two extra Browse genres");
  assert.equal((await q("SELECT count(*)::int AS n FROM genre_rules"))[0].n, 0);
});

test("the 13 Browse buttons that existed are seeded with their slug, topic, colour and icon", async () => {
  const { loadBrowseGenres, ALL_BUTTON } = require("../../src/lib/browseGenres");
  const list = await loadBrowseGenres(h.pool);
  assert.deepEqual(list.map((g) => g.slug), ["fiction", "children", "ya", "nonfiction", "classics", "mystery", "romance", "biography", "health", "arts", "travel", "food", "home", "all"]);
  assert.equal(list[list.length - 1], ALL_BUTTON);
});

// ---------------------------------------------------------------- found genres

test("found genres: one row per genre whatever its capitals and apostrophes, counting BOOKS, most common spelling kept", async () => {
  await q("INSERT INTO books (title, categories) VALUES ('a', 'Children''s Books, children’s books'), ('b', 'CHILDREN''S BOOKS'), ('c', 'Children''s Books'), ('d', 'Zoology,  Zoology ,'), ('e', NULL), ('f', '')");
  const found = await admin.foundGenres(h.pool);
  const kids = found.find((f) => f.key === "children's books");
  assert.equal(kids.books, 3, "three books, not four mentions");
  assert.equal(kids.name, "Children's Books", "the most common spelling");
  assert.equal(found.find((f) => f.key === "zoology").books, 1);
  assert.equal(found.length, 2, "empty and null categories add nothing");
});

test("the found table: Unmapped only / Mapped only / search / sort / paging, and each row's matching rule", async () => {
  await seedBooks(26);
  await childrenRules();
  const found = await admin.foundGenres(h.pool);
  const { rules } = await loadRules(h.pool);
  const all = admin.queryFound(found, rules, {});
  assert.equal(all.counts.all, all.counts.unmapped + all.counts.mapped);
  const unmapped = admin.queryFound(found, rules, { filter: "unmapped" });
  assert.ok(unmapped.rows.every((r) => r.status === "unmapped"));
  assert.ok(unmapped.rows.some((r) => r.name === "Zoology"));
  const mapped = admin.queryFound(found, rules, { filter: "mapped" });
  const kids = mapped.rows.find((r) => r.name === "Childrens");
  assert.equal(kids.targetLabel, "Children");
  assert.match(kids.via, /word "Children"/);
  assert.equal(mapped.rows.find((r) => r.name === "Juvenile Fiction").via, "exact rule");
  assert.equal(mapped.rows.find((r) => r.name === "Fiction").targetLabel, "Fiction", "a managed name is its own slot");
  assert.equal(all.rows.find((r) => r.name === "Childhood").status, "unmapped", "Childhood is not Children");
  assert.deepEqual(admin.queryFound(found, rules, { q: "zool" }).rows.map((r) => r.name), ["Zoology"]);
  const paged = admin.queryFound(found, rules, { pageSize: 3, page: 2, sort: "name" });
  assert.equal(paged.rows.length, 3);
  assert.ok(paged.pages > 1);
  assert.deepEqual(paged.rows.map((r) => r.name), [...paged.rows.map((r) => r.name)].sort((a, b) => a.localeCompare(b, "en", { sensitivity: "base" })));
});

test("the page renders (managed list, found table, add-rule form) for an admin", async () => {
  await seedBooks(13);
  const { res, text } = await h.get("/admin/genres");
  assert.equal(res.status, 200);
  for (const s of ["Managed genres", "Found genres", "Add a rule: any genre containing the word", "Suggest slots with AI", "Preview: update all books", "Slot into..."]) assert.ok(text.includes(s), s);
  const unmapped = await h.get("/admin/genres?filter=unmapped&q=zoo&sort=name");
  assert.ok(unmapped.text.includes('class="gn-name">Zoology<'), "the searched genre is listed");
  assert.ok(!unmapped.text.includes('class="gn-name">Childhood<'), "a genre that does not match the search is not listed");
  assert.equal((await h.get("/admin/genres?page=999999999999&sort=%27&filter=x")).res.status, 200, "junk parameters are clamped");
});

test("the found-genres page answers fast at 30,000 books", { timeout: 60000 }, async () => {
  await q(`INSERT INTO books (title, categories)
           SELECT 'Perf ' || g, (ARRAY['Children''s Books, Fiction','Juvenile Fiction','Mystery, Thriller','Zoology','Fiction, General','Cooking','History, Non-fiction','Children’s Fiction'])[1 + g % 8] || CASE WHEN g % 50 = 0 THEN ', Extra ' || (g % 400) ELSE '' END
           FROM generate_series(1, 30000) g`);
  admin.clearAll(h.pool);
  const t0 = Date.now();
  const { res } = await h.get("/admin/genres");
  const ms = Date.now() - t0;
  assert.equal(res.status, 200);
  assert.ok(ms < 1000, `found-genres page took ${ms} ms`);
});

// ---------------------------------------------------------------- managed genres and rules (CRUD, audit)

test("managed genres: add, rename (leaves an exact rule for the old name), listed A to Z, delete", async () => {
  const add = await h.post("/admin/genres/managed", { nameEn: "Kids", nameFr: "Enfants" });
  assert.equal(add.res.status, 200);
  const [kids] = await q("SELECT * FROM managed_genres WHERE name_en = 'Kids'");
  assert.equal(kids.name_fr, "", "a posted French name is ignored: managed genres have an English name only");
  assert.equal(kids.browse_slug, "kids");
  assert.equal(kids.show_on_browse, true);
  assert.equal(kids.icon, "book");
  assert.equal((await admin.addManaged(h.pool, { nameEn: "KIDS" })).ok, false, "unique, case-insensitive");
  assert.equal((await admin.addManaged(h.pool, { nameEn: "A, B" })).ok, false, "no comma in a genre name");
  assert.equal((await admin.addManaged(h.pool, { nameEn: "  " })).ok, false);

  await h.post(`/admin/genres/managed/${kids.id}`, { nameEn: "Little ones", nameFr: "Petits", showOnBrowse: "1", colour: "sky", icon: "heart", browseOrder: "3" });
  const [renamed] = await q("SELECT * FROM managed_genres WHERE id = $1", [kids.id]);
  assert.deepEqual([renamed.name_en, renamed.name_fr, renamed.colour, renamed.icon, renamed.browse_slug, renamed.browse_order], ["Little ones", "", "sky", "heart", "kids", 3], "the Browse link code never changes; no French name is written");
  const rule = (await q("SELECT * FROM genre_rules WHERE kind = 'exact'"))[0];
  assert.equal(rule.pattern, "Kids");
  assert.equal(rule.target_managed_genre_id, kids.id, "books named Kids can be carried over by Update all books");
  assert.equal((await audits("genre.managed_update")).length, 1);

  // The admin list is A to Z (no up/down arrows any more): the old move address is gone and changes nothing.
  const before = (await q("SELECT id, sort_order FROM managed_genres ORDER BY id"));
  const moved = await h.post(`/admin/genres/managed/${kids.id}/move`, { dir: "up" });
  assert.equal(moved.res.status, 404);
  assert.deepEqual(await q("SELECT id, sort_order FROM managed_genres ORDER BY id"), before);
  const names = (await admin.listManaged(h.pool)).map((g) => g.name_en);
  assert.deepEqual(names, names.slice().sort(admin.compareNames), "listManaged is A to Z");

  const confirmPage = await h.get(`/admin/genres/managed/${kids.id}/delete`);
  assert.match(confirmPage.text, /1<\/strong> rule slotting genres into it is deleted with it/);
  await h.post(`/admin/genres/managed/${kids.id}/delete`, {});
  assert.equal((await q("SELECT 1 FROM managed_genres WHERE id = $1", [kids.id])).length, 0);
  assert.equal((await q("SELECT 1 FROM genre_rules")).length, 0, "its rules went with it: those genres are Unmapped again");
  assert.equal((await audits("genre.managed_delete")).length, 1);
});

test("rules: add a word rule, slot a genre (exact), edit, reorder, delete; audited and validated", async () => {
  await seedBooks(13);
  const [fiction] = await q("SELECT id FROM managed_genres WHERE name_en = 'Fiction'");
  await h.post("/admin/genres/rules", { kind: "contains-word", pattern: "Children", target: `m:${fiction.id}` });
  await h.post("/admin/genres/rules", { kind: "contains-word", pattern: "", target: "remove" });
  await h.post("/admin/genres/rules", { kind: "contains-word", pattern: "x", target: "m:99999999" });
  await h.post("/admin/genres/rules", { kind: "contains-word", pattern: "x", target: "garbage" });
  await h.post("/admin/genres/rules", { kind: "contains-word", pattern: "x", target: "" });
  let rules = await q("SELECT * FROM genre_rules ORDER BY id");
  assert.equal(rules.length, 1, "refused forms save nothing");
  assert.equal((await audits("genre.rule_add")).length, 1);

  // "Slot into..." answers JSON for the script, and the same POST redirects without it
  const slot = await fetch(`${h.base}/admin/genres/slot`, {
    method: "POST", redirect: "manual",
    headers: { "x-test-user": JSON.stringify(h.admin), "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ genre: "Zoology", target: `m:${fiction.id}` }).toString(),
  });
  assert.deepEqual(await slot.json(), { ok: true, label: "Fiction" });
  const exact = (await q("SELECT * FROM genre_rules WHERE kind = 'exact'"))[0];
  assert.equal(exact.pattern, "Zoology");
  assert.equal((await h.post("/admin/genres/slot", { genre: "Zoology", target: "" })).res.status, 200);
  assert.equal((await q("SELECT 1 FROM genre_rules WHERE kind = 'exact'")).length, 1, "the blank 'Slot into...' placeholder changes nothing");
  await h.post("/admin/genres/slot", { genre: "Zoology", target: "keep" });
  assert.equal((await q("SELECT action FROM genre_rules WHERE kind = 'exact'"))[0].action, "keep");
  await h.post("/admin/genres/slot", { genre: "Zoology", target: "none" });
  assert.equal((await q("SELECT 1 FROM genre_rules WHERE kind = 'exact'")).length, 0, "'Clear' removes the exact rule");

  const wordRule = (await q("SELECT id FROM genre_rules WHERE kind = 'contains-word'"))[0];
  await h.post(`/admin/genres/rules/${wordRule.id}`, { pattern: "Juvenile", target: "remove" });
  rules = await q("SELECT * FROM genre_rules");
  assert.deepEqual([rules[0].pattern, rules[0].action, rules[0].target_managed_genre_id], ["Juvenile", "remove", null]);
  await h.post("/admin/genres/rules", { kind: "contains-word", pattern: "Crime", target: `m:${fiction.id}` });
  const ids = (await q("SELECT id FROM genre_rules ORDER BY sort_order, id")).map((r) => r.id);
  await h.post(`/admin/genres/rules/${ids[1]}/move`, { dir: "up" });
  assert.deepEqual((await q("SELECT id FROM genre_rules ORDER BY sort_order, id")).map((r) => r.id), [ids[1], ids[0]]);
  await h.post(`/admin/genres/rules/${ids[0]}/delete`, {});
  assert.equal((await q("SELECT 1 FROM genre_rules")).length, 1);
  assert.ok((await audits("genre.rule_delete")).length >= 2);
  assert.equal((await h.post("/admin/genres/rules/abc/delete", {})).res.status, 404, "a bad id is a 404");
});

test("the rule preview ('Show matches') lists what a new rule takes, and what another rule already handles", async () => {
  await seedBooks(26);
  await childrenRules();
  const { res } = await h.get("/admin/genres/rules/preview?kind=contains-word&pattern=Fiction");
  const body = JSON.parse((await h.get("/admin/genres/rules/preview?kind=contains-word&pattern=Fiction")).text);
  assert.equal(res.status, 200);
  const names = body.takes.map((t) => t.name);
  assert.ok(names.includes("Fiction") && names.includes("Non-fiction"), "a managed name is the last resort of the matching, so a word rule takes it: the preview shows it");
  assert.equal(body.takes.find((t) => t.name === "Non-fiction").was, "its own name");
  assert.ok(body.handled.some((t) => t.name === "Children's Fiction"), "a word rule for Children already handles it");
  const none = JSON.parse((await h.get("/admin/genres/rules/preview?kind=contains-word&pattern=")).text);
  assert.equal(none.genres, 0);
});

// ---------------------------------------------------------------- Update all books

test("preview numbers equal apply numbers; apply changes exactly the expected books (200 noisy books)", async () => {
  const ids = await seedBooks(200);
  await childrenRules();
  const before = new Map();
  for (const id of ids) before.set(id, await cats(id));
  const plan = await run.planRun(h.pool);
  assert.ok(plan.count > 0);
  assert.equal(plan.examples.length, 10);
  const result = await run.applyRun(h.pool, { id: h.admin.id }, { count: plan.count, hash: plan.hash });
  assert.equal(result.changed, plan.count, "preview == apply");
  assert.equal(result.skipped, 0);

  // exactly the books the rules say, nothing else
  const expectedEn = {
    "Children's Books, Fiction": "Children, Fiction", "Children's Fiction": "Children", "Juvenile Fiction": "Children", "Fiction, General": "Fiction",
    Childrens: "Children", "Children’s Books": "Children", Mystery: "Mystery", Zoology: "Zoology", Childhood: "Childhood",
    fiction: "Fiction", "Non-fiction, History": "Non-fiction, History", "Children, Children's Books": "Children",
  };
  let changed = 0;
  for (const id of ids) {
    const b = before.get(id);
    const now = await cats(id);
    if (b.categories == null) { assert.equal(now.categories, null); assert.equal(now.categories_fr, null); continue; }
    assert.equal(now.categories, expectedEn[b.categories], `book ${id}: ${b.categories}`);
    assert.equal(now.categories_fr, b.categories_fr, `book ${id}: the run never writes a French genre`);
    if (now.categories !== b.categories) changed += 1;
    else assert.equal(now.updated_at.getTime(), b.updated_at.getTime(), "an unchanged book is not touched");
  }
  assert.equal(changed, plan.count);
  // No French genre is made: the run records NULL for the French before/after of every change
  assert.equal((await q("SELECT count(*)::int AS n FROM genre_run_changes WHERE old_categories_fr IS NOT NULL OR new_categories_fr IS NOT NULL"))[0].n, 0);
  const childhood = await q("SELECT categories FROM books WHERE categories = 'Childhood' LIMIT 1");
  assert.equal(childhood.length, 1, "Childhood is not Children");

  // the run is recorded: who, the rules, and the old and new value of every changed book
  const [r] = await q("SELECT * FROM genre_runs WHERE id = $1", [result.runId]);
  assert.equal(r.status, "done");
  assert.equal(r.books_changed, plan.count);
  assert.equal(r.actor_user_id, h.admin.id);
  assert.ok(r.rules_snapshot.some((x) => x.pattern === "Children"));
  assert.equal((await q("SELECT count(*)::int AS n FROM genre_run_changes WHERE run_id = $1", [result.runId]))[0].n, plan.count);
});

test("idempotent: a second apply finds nothing to change", async () => {
  await seedBooks(60);
  await childrenRules();
  const first = await run.planRun(h.pool);
  await run.applyRun(h.pool, {}, { count: first.count, hash: first.hash });
  const second = await run.planRun(h.pool);
  assert.equal(second.count, 0);
  const again = await run.applyRun(h.pool, {}, null);
  assert.equal(again.runId, null);
  assert.equal(again.changed, 0);
});

test("a stale confirm changes nothing (the books or rules moved since the preview)", async () => {
  const ids = await seedBooks(40);
  await childrenRules();
  const plan = await run.planRun(h.pool);
  await q("UPDATE books SET categories = 'Children''s Zoology' WHERE id = $1", [ids[9]]); // another book now fits a rule
  const r = await run.applyRun(h.pool, {}, { count: plan.count, hash: plan.hash });
  assert.equal(r.mismatch, true);
  assert.equal((await q("SELECT 1 FROM genre_runs")).length, 0);
  assert.equal((await cats(ids[0])).categories, "Children's Books, Fiction", "nothing was written");
});

test("the routes: preview (POST) -> confirm (POST) -> result page with Undo; audit entries; a form without the fingerprint is refused", async () => {
  await seedBooks(40);
  await childrenRules();
  const preview = await h.post("/admin/genres/apply/preview", {});
  assert.equal(preview.res.status, 200);
  assert.match(preview.text, /books? would change/);
  assert.match(preview.text, /Children&#39;s Books, Fiction/);
  const count = preview.text.match(/name="expectedCount" value="(\d+)"/)[1];
  const hash = preview.text.match(/name="expectedHash" value="([0-9a-f]{64})"/)[1];
  const bare = await h.post("/admin/genres/apply", {});
  assert.match(bare.text, /preview the update first/);
  assert.equal((await q("SELECT 1 FROM genre_runs")).length, 0);
  const done = await h.post("/admin/genres/apply", { expectedCount: count, expectedHash: hash });
  assert.match(done.text, /Run \d+: \d+ books? changed/);
  assert.match(done.text, /Undo this run/);
  assert.equal((await audits("genre.apply")).length, 1);
  const runId = (await q("SELECT id FROM genre_runs"))[0].id;
  const m = done.text.match(/name="expectedCount" value="(\d+)"/)[1];
  const mh = done.text.match(/name="expectedHash" value="([0-9a-f]{64})"/)[1];
  const undone = await h.post(`/admin/genres/runs/${runId}/undo`, { expectedCount: m, expectedHash: mh });
  assert.match(undone.text, /Undone: \d+ books?/);
  assert.equal((await audits("genre.undo")).length, 1);
  assert.equal((await run.planRun(h.pool)).count > 0, true, "after the undo the rules would change the books again");
});

test("undo restores exactly the changed books (English genres; the French column is never touched), and skips books edited since", async () => {
  const ids = await seedBooks(60);
  await childrenRules();
  const original = new Map();
  for (const id of ids) original.set(id, await cats(id));
  const plan = await run.planRun(h.pool);
  const applied = await run.applyRun(h.pool, {}, { count: plan.count, hash: plan.hash });
  const touched = (await q("SELECT book_id FROM genre_run_changes WHERE run_id = $1 ORDER BY book_id", [applied.runId])).map((r) => r.book_id);
  // one changed book is edited by hand after the run
  await q("UPDATE books SET categories = 'Hand edited' WHERE id = $1", [touched[0]]);
  const preview = await run.previewUndo(h.pool, applied.runId);
  assert.equal(preview.total, plan.count);
  assert.equal(preview.count, plan.count - 1);
  assert.equal(preview.skipped, 1);
  const undone = await run.undoRun(h.pool, applied.runId, { count: preview.count, hash: preview.hash });
  assert.equal(undone.restored, plan.count - 1);
  assert.equal(undone.skipped, 1);
  for (const id of ids) {
    const o = original.get(id);
    const now = await cats(id);
    if (id === touched[0]) { assert.equal(now.categories, "Hand edited"); continue; }
    assert.equal(now.categories, o.categories, `book ${id}`);
    assert.equal(now.categories_fr, o.categories_fr, `French of book ${id} untouched`);
  }
  assert.ok((await run.getRun(h.pool, applied.runId)).undone_at);
  assert.equal((await run.undoRun(h.pool, applied.runId)).notLast, true, "an undone run cannot be undone again");
});

test("only the newest run that is not undone can be undone", async () => {
  await seedBooks(30);
  await childrenRules();
  const a = await run.applyRun(h.pool, {}, null);
  await admin.saveRule(h.pool, { kind: "exact", pattern: "Zoology", target: "remove" });
  const b = await run.applyRun(h.pool, {}, null);
  assert.ok(a.runId && b.runId);
  assert.equal((await run.undoRun(h.pool, a.runId)).notLast, true);
  assert.ok((await run.undoRun(h.pool, b.runId)).restored > 0);
  assert.ok((await run.undoRun(h.pool, a.runId)).restored > 0, "after the newer run is undone, the earlier one is the newest");
});

test("two runs cannot overlap: the second is told to wait", async () => {
  await seedBooks(30);
  await childrenRules();
  const r = await run.withRunLock(h.pool, async () => {
    const second = await run.applyRun(h.pool, {}, null);
    const undo = await run.undoRun(h.pool, 1);
    return { second, undo };
  });
  assert.equal(r.second.busy, true);
  assert.equal(r.undo.busy, true);
  assert.equal((await q("SELECT 1 FROM genre_runs")).length, 0);
  const free = await run.applyRun(h.pool, {}, null);
  assert.ok(free.runId, "the lock was released");
});

test("a book saved while the run reads is skipped, never overwritten", async () => {
  const ids = await seedBooks(20);
  await childrenRules();
  const plan = await run.planRun(h.pool);
  const target = plan.changes[0].id;
  // the run re-checks the stored value in its UPDATE: change the book after the plan was read
  const real = h.pool;
  let hooked = false;
  const result = await run.applyRun({
    connect: async () => {
      const client = await real.connect();
      const query = client.query.bind(client);
      client.query = async (...args) => {
        if (!hooked && typeof args[0] === "string" && args[0].startsWith("INSERT INTO genre_runs")) {
          hooked = true;
          await real.query("UPDATE books SET categories = 'Edited meanwhile' WHERE id = $1", [target]);
        }
        return query(...args);
      };
      const release = client.release.bind(client);
      client.release = (err) => { client.query = query; client.release = release; release(err); }; // the pooled client is plain again
      return client;
    },
  }, {}, null);
  assert.equal(result.changed, plan.count - 1);
  assert.equal(result.skipped, 1);
  assert.equal((await cats(target)).categories, "Edited meanwhile");
  assert.ok(ids.includes(target));
});

test("a batch size of 500: 30,000 books apply in under 30 s", { timeout: 120000 }, async () => {
  await q(`INSERT INTO books (title, categories)
           SELECT 'Big ' || g, (ARRAY['Children''s Books, Fiction','Juvenile Fiction','Mystery, Thriller','Zoology','Fiction, General','Cooking','History, Non-fiction','Children’s Fiction'])[1 + g % 8]
           FROM generate_series(1, 30000) g`);
  await childrenRules();
  const t0 = Date.now();
  const r = await run.applyRun(h.pool, {}, null);
  const ms = Date.now() - t0;
  // 4 of the 8 spellings change in English (no French-only changes any more since books have no French genre)
  assert.equal(r.changed, 15000, `changed ${r.changed}`);
  assert.ok(ms < 30000, `apply took ${ms} ms`);
  const again = await run.planRun(h.pool);
  assert.equal(again.count, 0, "idempotent at scale");
});

// ---------------------------------------------------------------- the save paths

test("save paths: a new book (scan intake) and an edited book go through the same rules; no rule saved = unchanged", async () => {
  const stored = `/img/${"f".repeat(64)}.jpg`;
  let n = 0;
  const save = async (genre) => {
    const body = { isbn: isbn13From(`978${String(9100000 + (++n)).padStart(9, "0")}`), title: `Saved ${n}`, author: "A", description: "d", descriptionFr: "d", coverUrl: stored, binding: "trade", condition: "very_good", price: "5", location: "Store", source: "donation", genre, intakeToken: `genre-save-token-${String(n).padStart(4, "0")}-abcdef` };
    const parsed = intake.parseIntakeInput(body);
    const p = await intake.prepareIntake(h.pool, parsed.value);
    assert.equal(p.ok, true, JSON.stringify(p));
    const saved = await intake.saveBookAndCopy(h.pool, p.value, { userId: h.admin.id, audit: async () => {} });
    return cats(saved.bookId);
  };
  // no rule saved: the genres stay exactly as typed
  assert.equal((await save("Children's Books, Fiction")).categories, "Children's Books, Fiction");
  await childrenRules();
  const created = await save("Children's Books, Fiction, Fiction");
  assert.equal(created.categories, "Children, Fiction");
  assert.equal(created.categories_fr, null, "no French genre is stored");
  assert.equal((await save("Zoology")).categories, "Zoology", "an unmapped genre is left alone");

  // the edit route
  const [b] = await q("INSERT INTO books (title, categories) VALUES ('Edit me', 'Zoology') RETURNING id");
  await h.post(`/admin/inventory/${b.id}`, { title: "Edit me", genre: "Childrens, Mystery", genreFr: "Enfants", description: "d", descriptionFr: "d", coverUrl: stored });
  const edited = await cats(b.id);
  assert.equal(edited.categories, "Children, Mystery");
  assert.equal(edited.categories_fr, null, "a posted genreFr is ignored and none is made");
  await settled();
});

test("applyRulesToBook: English genres only (no French genre in the answer)", async () => {
  await childrenRules();
  assert.deepEqual(await applyRulesToBook(h.pool, "Children"), { genre: "Children" });
  assert.deepEqual(await applyRulesToBook(h.pool, "Childrens"), { genre: "Children" });
  assert.deepEqual(await applyRulesToBook(h.pool, null), { genre: null });
});

// ---------------------------------------------------------------- AI help

test("AI suggestions (mocked): proposals are validated, an invented genre is rejected, nothing is saved", async () => {
  await childrenRules();
  const managed = await q("SELECT id, name_en FROM managed_genres");
  const asked = [];
  const ask = async (prompt) => {
    asked.push(prompt);
    return { text: 'Here you go:\n```json\n{"1": "Mystery", "2": "Space Opera", "3": "none", "4": "fiction", "9": "Mystery"}\n```', reason: null };
  };
  const out = await suggestSlots([{ name: "Whodunits", books: 5 }, { name: "Spaceships", books: 4 }, { name: "Misc", books: 3 }, { name: "Novels", books: 2 }], managed, { ask });
  assert.equal(out.ok, true);
  assert.deepEqual(out.proposals.map((p) => [p.name, p.targetName]), [["Whodunits", "Mystery"], ["Novels", "Fiction"]]);
  assert.equal(out.rejected, 1, "'Space Opera' is not a managed genre");
  assert.match(asked[0], /Managed genres/);
  assert.ok(asked[0].includes("1. Whodunits"));
  assert.equal((await q("SELECT 1 FROM genre_rules WHERE pattern IN ('Whodunits', 'Novels')")).length, 0, "nothing saved by asking");
});

test("AI suggestions: batches of at most 100, and every failure is explained, never thrown", async () => {
  const managed = await q("SELECT id, name_en FROM managed_genres");
  const many = Array.from({ length: 230 }, (_, i) => ({ name: `Tag ${i}`, books: 230 - i }));
  const sizes = [];
  await suggestSlots(many, managed, { ask: async (prompt) => { sizes.push((prompt.match(/^\d+\. /gm) || []).length); return { text: "{}", reason: null }; } });
  assert.deepEqual(sizes, [100, 100, 30]);
  for (const reason of ["no_key", "cap", "credit", "rate", "timeout", "error"]) {
    const r = await suggestSlots(many.slice(0, 3), managed, { ask: async () => ({ text: null, reason, message: "Daily limit used." }) });
    assert.equal(r.ok, false, reason);
    assert.ok(r.error.length > 20);
  }
  const junk = await suggestSlots(many.slice(0, 3), managed, { ask: async () => ({ text: "I cannot do that", reason: null }) });
  assert.equal(junk.ok, false);
});

test("the AI route fails gracefully with no key, and saving ticked proposals writes exact rules", async () => {
  await seedBooks(13);
  const noKey = await h.post("/admin/genres/suggest", {});
  assert.equal(noKey.res.status, 200);
  assert.match(noKey.text, /not set up on this site|no Anthropic API key/);
  const [mystery] = await q("SELECT id FROM managed_genres WHERE name_en = 'Mystery'");
  const saved = await h.post("/admin/genres/suggest/save", { accept: [`${mystery.id}|Whodunits`, `${mystery.id}|Page-turners`, "garbage", "99999999|Nope"] });
  assert.match(saved.text, /Saved 2 rules/);
  assert.deepEqual((await q("SELECT pattern FROM genre_rules ORDER BY pattern")).map((r) => r.pattern), ["Page-turners", "Whodunits"]);
  const none = await h.post("/admin/genres/suggest/save", {});
  assert.match(none.text, /Nothing was ticked/);
});

// ---------------------------------------------------------------- Inventory genre filter

test("the admin Inventory Genre filter lists the managed genres first, then the other genres in use under 'Other'", async () => {
  await q("INSERT INTO books (title, categories) VALUES ('t1', 'Zoology, Fiction'), ('t2', 'Zoology'), ('t3', 'Basketweaving')");
  admin.clearAll(h.pool);
  const { text } = await h.get("/admin/inventory");
  const select = text.match(/<select[^>]*name="genre"[\s\S]*?<\/select>/)[0];
  const iFiction = select.indexOf(">Fiction<");
  const iOther = select.indexOf('<optgroup label="Other (not managed)">');
  assert.ok(iFiction > 0 && iOther > iFiction, "managed first");
  assert.ok(select.indexOf(">Basketweaving<") > iOther && select.indexOf(">Zoology<") > iOther, "raw genres in use under Other");
  assert.equal((select.match(/>Fiction</g) || []).length, 1, "a managed genre is not repeated under Other");
});

// ---------- a run the server never finished (crash, SIGTERM mid-run) ----------

// What a crash after one batch leaves behind: a 'running' row, and the books that batch already rewrote.
async function crashedRun(minutesAgo) {
  const [b1] = await q("INSERT INTO books (title, categories, categories_fr) VALUES ('Crash 1', 'Children', 'Enfants') RETURNING id");
  const [b2] = await q("INSERT INTO books (title, categories, categories_fr) VALUES ('Crash 2', 'Children', 'Enfants') RETURNING id");
  const [r] = await q("INSERT INTO genre_runs (started_at, status) VALUES (now() - make_interval(mins => $1::int), 'running') RETURNING id", [minutesAgo]);
  for (const b of [b1, b2]) {
    await q("INSERT INTO genre_run_changes (run_id, book_id, old_categories, old_categories_fr, new_categories, new_categories_fr) VALUES ($1, $2, 'Children''s Books', 'Livres', 'Children', 'Enfants')", [r.id, b.id]);
  }
  return { runId: r.id, bookIds: [b1.id, b2.id] };
}
const runRow = async (id) => (await q("SELECT * FROM genre_runs WHERE id = $1", [id]))[0];

test("a stale 'running' run becomes failed (interrupted) with the books it did change, and Undo restores them", async () => {
  const { runId, bookIds } = await crashedRun(20);
  assert.equal(await run.reapStaleRuns(h.pool), 1);
  const row = await runRow(runId);
  assert.equal(row.status, "failed");
  assert.equal(row.note, run.INTERRUPTED_NOTE);
  assert.equal(row.books_changed, 2);
  assert.ok(row.finished_at);
  const page = await h.get("/admin/genres");
  assert.match(page.text, /failed \(interrupted\)/);
  const detail = await h.get(`/admin/genres/runs/${runId}`);
  assert.match(detail.text, /failed: interrupted/);
  assert.match(detail.text, /Undo this run/, "Undo stays available for the partial changes");
  const undone = await run.undoRun(h.pool, runId);
  assert.equal(undone.restored, 2);
  for (const id of bookIds) {
    const now = await cats(id);
    assert.equal(now.categories, "Children's Books");
    assert.equal(now.categories_fr, "Enfants", "Undo puts back the English only: an old run's French before-value is never written");
  }
});

test("a recent 'running' run is left alone, and so is a stale one while its lock is held", async () => {
  const fresh = await crashedRun(2);
  assert.equal(await run.reapStaleRuns(h.pool), 0);
  assert.equal((await runRow(fresh.runId)).status, "running");
  await q("UPDATE genre_runs SET started_at = now() - interval '30 minutes' WHERE id = $1", [fresh.runId]);
  const during = await run.withRunLock(h.pool, async () => run.reapStaleRuns(h.pool));
  assert.equal(during, 0, "the lock is held: a live run");
  assert.equal((await runRow(fresh.runId)).status, "running");
  assert.equal(await run.reapStaleRuns(h.pool), 1, "lock free: the run is dead");
});

test("starting an apply tidies up a stale run first", async () => {
  await seedBooks(30);
  await childrenRules();
  const { runId } = await crashedRun(45);
  const applied = await run.applyRun(h.pool, {}, null);
  assert.ok(applied.runId > runId);
  const row = await runRow(runId);
  assert.equal(row.status, "failed");
  assert.equal(row.note, run.INTERRUPTED_NOTE);
});
