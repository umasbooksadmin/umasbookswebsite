// Curated collections: publish, the approve ticks, removing a book and reordering are atomic and serialised
// per collection (src/lib/collections.js, Review A L6). Library level, real database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase } = require("../helpers/testDatabase");

const db = prepareDatabase("collections_atomic", { isolated: true });
const { pool } = require("../../src/db");
const collections = require("../../src/lib/collections");

before(() => db.create());
after(async () => { await pool.end(); db.drop(); });

let seq = 0;
const uniq = () => `${Date.now()}x${++seq}`;

async function newCollection({ approved = 1, extra = 0 } = {}) {
  const r = await collections.createCollection(pool, {
    title_en: `Atomic ${uniq()}`, description_en: "d", title_fr: "Titre", description_fr: "Description", curation_prompt: "p",
  });
  assert.ok(r.ok);
  const bookIds = [];
  for (let i = 0; i < approved + extra; i++) {
    const { rows } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'A') RETURNING id", [`Book ${uniq()}`]);
    await pool.query(
      "INSERT INTO curated_collection_books (collection_id, book_id, status, reason, position) VALUES ($1, $2, $3, 'r', $4)",
      [r.id, rows[0].id, i < approved ? "approved" : "suggested", i]
    );
    bookIds.push(rows[0].id);
  }
  return { id: r.id, bookIds };
}
const state = async (id) => {
  const { rows } = await pool.query(
    "SELECT published, (SELECT count(*)::int FROM curated_collection_books WHERE collection_id = $1 AND status = 'approved') AS approved FROM curated_collections WHERE id = $1", [id]);
  return rows[0];
};
const statuses = async (id) => (await pool.query("SELECT book_id, status FROM curated_collection_books WHERE collection_id = $1 ORDER BY book_id", [id])).rows;

test("publish waits for an un-approve in progress and then refuses: never published with zero approved books", async () => {
  const c = await newCollection({ approved: 1 });
  const other = await pool.connect();
  try {
    await other.query("BEGIN");
    await other.query("SELECT id FROM curated_collections WHERE id = $1 FOR UPDATE", [c.id]); // the un-approve holds the collection
    const publishing = collections.setPublished(pool, c.id, true);
    await new Promise((r) => setTimeout(r, 300));
    await other.query("UPDATE curated_collection_books SET status = 'suggested' WHERE collection_id = $1", [c.id]);
    await other.query("COMMIT");
    const result = await publishing;
    assert.equal(result.ok, false);
    assert.match(result.error, /at least one book is approved/);
  } finally {
    other.release();
  }
  assert.deepEqual(await state(c.id), { published: false, approved: 0 });
});

test("publish racing the real un-approve many times never leaves a published collection with no approved book", async () => {
  for (let i = 0; i < 12; i++) {
    const c = await newCollection({ approved: 1 });
    const rows = c.bookIds.map((bookId) => ({ bookId, approve: false, reject: false }));
    await Promise.all([collections.setPublished(pool, c.id, true), collections.saveDecisions(pool, c.id, rows)]);
    const s = await state(c.id);
    assert.ok(!(s.published && s.approved === 0), `round ${i}: ${JSON.stringify(s)}`);
  }
});

test("saveDecisions rolls back every tick when one write fails part-way", async () => {
  const c = await newCollection({ approved: 0, extra: 2 });
  const before = await statuses(c.id);
  // The second row has an id Postgres rejects (22P02), after the first row was already written.
  await assert.rejects(collections.saveDecisions(pool, c.id, [
    { bookId: c.bookIds[0], approve: true, reject: false },
    { bookId: "not-a-number", approve: true, reject: false },
  ]));
  assert.deepEqual(await statuses(c.id), before, "nothing was saved");
});

test("saveDecisions keeps its result: changed count, and unpublishes when the last approval goes", async () => {
  const c = await newCollection({ approved: 1, extra: 1 });
  assert.deepEqual(await collections.setPublished(pool, c.id, true), { ok: true });
  const r = await collections.saveDecisions(pool, c.id, [
    { bookId: c.bookIds[0], approve: false, reject: true },
    { bookId: c.bookIds[1], approve: false, reject: false },
  ]);
  assert.deepEqual(r, { ok: true, changed: 1, unpublished: true });
  const both = await collections.saveDecisions(pool, c.id, [{ bookId: c.bookIds[0], approve: true, reject: true }]);
  assert.equal(both.ok, false);
});

test("setPublished answers not-found for a missing collection", async () => {
  assert.equal((await collections.setPublished(pool, 999999, true)).notFound, true);
  assert.equal((await collections.setPublished(pool, 999999, false)).notFound, true);
});

test("moveCollection: concurrent moves keep a clean 10, 20, 30 ... order with no lost move", async () => {
  for (let i = 0; i < 4; i++) await newCollection({ approved: 0 });
  const order = async () => (await pool.query("SELECT id FROM curated_collections ORDER BY sort_order, id")).rows.map((r) => r.id);
  const start = await order();
  const a = start[start.length - 1];
  const b = start[start.length - 2];
  await Promise.all([collections.moveCollection(pool, a, "up"), collections.moveCollection(pool, b, "up")]);
  const after = await order();
  const orders = (await pool.query("SELECT sort_order FROM curated_collections ORDER BY sort_order")).rows.map((r) => r.sort_order);
  assert.deepEqual(orders, orders.map((_, i) => (i + 1) * 10), "renumbered cleanly");
  const up = (list, id) => { const l = [...list]; const i = l.indexOf(id); if (i > 0) [l[i - 1], l[i]] = [l[i], l[i - 1]]; return l; };
  const serial = [up(up(start, a), b), up(up(start, b), a)].map((l) => JSON.stringify(l));
  assert.ok(serial.includes(JSON.stringify(after)), "the same as the two moves done one after the other");
  assert.equal(await collections.moveCollection(pool, start[0], "up"), false, "the first cannot go up");
});

test("removeBook unpublishes a collection that loses its last approved book", async () => {
  const c = await newCollection({ approved: 1 });
  await collections.setPublished(pool, c.id, true);
  const r = await collections.removeBook(pool, c.id, c.bookIds[0]);
  assert.deepEqual(r, { removed: true, unpublished: true });
});
