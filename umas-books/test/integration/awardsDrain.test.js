// The background job that fills in awards (drainAwards in lib/awards): which
// books it picks, in what order, and how many per tick. Runs in its own
// database (in CI too) because it looks at EVERY book, and other test files
// add books to the shared one. All lookups are stubbed.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");

const h = adminHarness("awards_drain", [], { isolated: true });
process.env.AWARDS_LOOKUPS = "on";
const awards = require("../../src/lib/awards");

before(() => h.start());
after(() => h.stop());
beforeEach(async () => {
  await h.pool.query("DELETE FROM books"); // each test starts from an empty shop
});

async function book(over = {}) {
  const { rows } = await h.pool.query(
    `INSERT INTO books (title, authors, isbn, awards_checked_at, awards_check_state)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [over.title || "T", over.authors === undefined ? "A" : over.authors, `979${String(Math.floor(Math.random() * 1e10)).padStart(10, "0")}`,
      over.checked || null, over.state || null]
  );
  return rows[0].id;
}
const daysAgo = (n) => new Date(Date.now() - n * 86400000);
function recorder() {
  const ids = [];
  const fake = async (b) => { ids.push(b.id); return { items: [], error: false }; };
  return { ids, deps: { gapMs: 0, wikidata: fake } };
}

test("picks never-checked books newest first and respects the batch size", async () => {
  const made = [];
  for (let i = 0; i < 8; i++) made.push(await book());
  const rec = recorder();
  const first = await awards.drainAwards(h.pool, rec.deps, { batch: 5 });
  assert.equal(first.processed, 5);
  assert.deepEqual(rec.ids, [...made].reverse().slice(0, 5));
  const second = await awards.drainAwards(h.pool, rec.deps, { batch: 5 });
  assert.equal(second.processed, 3);
  assert.deepEqual(rec.ids.slice(5), [...made].reverse().slice(5));
  assert.equal((await awards.drainAwards(h.pool, rec.deps)).processed, 0, "nothing left to do");
  const states = await h.q("SELECT DISTINCT awards_check_state FROM books");
  assert.deepEqual(states.map((r) => r.awards_check_state), ["none"]);
});

test("also retries errors older than a day and refreshes yearly, in that priority order", async () => {
  const fresh = await book({ checked: daysAgo(1), state: "none" });
  const errYoung = await book({ checked: daysAgo(0.2), state: "error" });
  const errOld = await book({ checked: daysAgo(2), state: "error" });
  const yearly = await book({ checked: daysAgo(400), state: "ok" });
  const unchecked = await book();
  const rec = recorder();
  await awards.drainAwards(h.pool, rec.deps, { batch: 10 });
  assert.deepEqual(rec.ids, [unchecked, errOld, yearly]);
  assert.ok(!rec.ids.includes(fresh) && !rec.ids.includes(errYoung));
});

test("a yearly refresh never takes the place of an unchecked book", async () => {
  const old = await book({ checked: daysAgo(500), state: "ok" });
  const unchecked = [await book(), await book()];
  const rec = recorder();
  await awards.drainAwards(h.pool, rec.deps, { batch: 2 });
  assert.deepEqual(rec.ids, [...unchecked].reverse());
  assert.ok(!rec.ids.includes(old));
});

test("the drain does nothing when the kill switch is off", async () => {
  await book();
  const res = await awards.drainAwards(h.pool, { env: { ...process.env, AWARDS_LOOKUPS: "off" }, wikidata: async () => assert.fail("off") });
  assert.equal(res.processed, 0);
});
