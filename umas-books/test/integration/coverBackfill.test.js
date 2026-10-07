// Covers on our own server (lib/coverStore.js) against a real database:
// migration 059, the background batch (rate, order, failure counters), reuse of
// identical bytes, and that nothing but our own /img URL ever leaves the
// database. fetch and DNS are injected: no network.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");
const { prepareDatabase } = require("../helpers/inProcessApp");

const db = prepareDatabase("covers", { isolated: true });
const { pool } = require("../../src/db");
const { backfillCovers, prepareCover, BATCH_SIZE, MAX_FAILURES } = require("../../src/lib/coverStore");

const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
let image;
let calls;
let mode; // "ok" | "404" | "html" | "500" | "network" | "placeholder"
const fetchImpl = async (url) => {
  calls.push(url);
  if (mode === "500") return new Response("down", { status: 503 });
  if (mode === "network") throw new TypeError("fetch failed", { cause: Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }) });
  if (mode === "placeholder") return new Response(await sharp({ create: { width: 1, height: 1, channels: 3, background: "#fff" } }).gif().toBuffer(), { status: 200, headers: { "content-type": "image/gif" } });
  if (mode === "404") return new Response("nope", { status: 404 });
  if (mode === "html") return new Response("<html/>", { status: 200, headers: { "content-type": "text/html" } });
  return new Response(image, { status: 200, headers: { "content-type": "image/jpeg" } });
};
const run = (opts = {}) => backfillCovers(pool, { fetchImpl, lookup, delayMs: 0, ...opts });

let seq = 0;
async function addBook({ source, cover = null, inStock = false, attemptedHoursAgo = null, failures = 0 } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO books (title, cover_url, cover_source_url, cover_fetch_failures, cover_fetch_attempted_at)
     VALUES ($1, $2, $3, $4, CASE WHEN $5::numeric IS NULL THEN NULL ELSE now() - make_interval(hours => $5::int) END) RETURNING id`,
    [`Cover test ${++seq}`, cover, source === undefined ? `https://covers.openlibrary.org/b/id/${seq}-L.jpg` : source, failures, attemptedHoursAgo]
  );
  if (inStock) await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 5)", [rows[0].id]);
  return rows[0].id;
}
const bookRow = async (id) => (await pool.query("SELECT cover_url, cover_source_url, cover_fetch_failures, cover_fetch_attempted_at FROM books WHERE id = $1", [id])).rows[0];
const imageCount = async () => Number((await pool.query("SELECT count(*) FROM images")).rows[0].count);

before(async () => {
  db.create();
  image = await sharp({ create: { width: 800, height: 1200, channels: 3, background: "#228855" } }).jpeg().toBuffer();
});
after(async () => { await pool.end(); db.drop(); });
beforeEach(async () => {
  calls = [];
  mode = "ok";
  await pool.query("DELETE FROM books WHERE title LIKE 'Cover test %'");
});

test("migration 059 moves external cover addresses to cover_source_url and keeps stored images", async () => {
  const sql = fs.readFileSync(path.join(__dirname, "../../migrations/059_covers_on_our_server.sql"), "utf8");
  const stored = `/img/${"b".repeat(64)}.jpg`;
  const ext = await addBook({ source: null });
  await pool.query("UPDATE books SET cover_url = 'https://covers.openlibrary.org/b/id/5-L.jpg' WHERE id = $1", [ext]);
  const keep = await addBook({ source: null, cover: stored });
  const none = await addBook({ source: null });
  await pool.query(sql); // re-runnable, and converts what matches
  assert.deepEqual([(await bookRow(ext)).cover_url, (await bookRow(ext)).cover_source_url], [null, "https://covers.openlibrary.org/b/id/5-L.jpg"]);
  assert.deepEqual([(await bookRow(keep)).cover_url, (await bookRow(keep)).cover_source_url], [stored, null]);
  assert.deepEqual([(await bookRow(none)).cover_url, (await bookRow(none)).cover_source_url], [null, null]);
  await pool.query(sql);
  assert.equal((await bookRow(ext)).cover_source_url, "https://covers.openlibrary.org/b/id/5-L.jpg", "second run changes nothing");
});

test("a batch stores the cover as a re-encoded /img JPEG and clears the failure state", async () => {
  const id = await addBook();
  const r = await run();
  assert.deepEqual(r, { processed: 1, stored: 1, failed: 0, transient: 0, stopped: false });
  const b = await bookRow(id);
  assert.match(b.cover_url, /^\/img\/[0-9a-f]{64}\.jpg$/);
  assert.equal(b.cover_fetch_failures, 0);
  const hash = b.cover_url.slice(5, 69);
  const { rows } = await pool.query("SELECT content_type, data FROM images WHERE id = $1", [hash]);
  assert.equal(rows[0].content_type, "image/jpeg");
  const meta = await sharp(rows[0].data).metadata();
  assert.equal(meta.width, 600, "capped at 600 px");
  assert.equal(calls.length, 1);
});

test("identical bytes are stored once: two books with the same cover share one /img URL", async () => {
  const saved = image;
  image = await sharp({ create: { width: 300, height: 450, channels: 3, background: "#aa5522" } }).jpeg().toBuffer(); // bytes no other test stores
  try {
    const before = await imageCount();
    const a = await addBook({ source: "https://covers.openlibrary.org/b/id/777-L.jpg" });
    const b = await addBook({ source: "https://covers.openlibrary.org/b/id/778-L.jpg" });
    await run();
    assert.equal((await bookRow(a)).cover_url, (await bookRow(b)).cover_url);
    assert.equal(await imageCount(), before + 1, "one image row for two books");
    // Running the same download again changes nothing either.
    await pool.query("UPDATE books SET cover_url = NULL WHERE id = $1", [a]);
    await run();
    assert.equal(await imageCount(), before + 1);
  } finally {
    image = saved;
  }
});

test("a book that already has a cover, or no source, is not fetched", async () => {
  await addBook({ cover: `/img/${"c".repeat(64)}.jpg` });
  await addBook({ source: null });
  assert.deepEqual(await run(), { processed: 0, stored: 0, failed: 0, transient: 0, stopped: false });
  assert.equal(calls.length, 0);
});

test("a batch is at most 20 books and books on the shelves go first", async () => {
  assert.equal(BATCH_SIZE, 20);
  const shelf = [];
  for (let i = 0; i < 3; i++) shelf.push(await addBook({ inStock: true }));
  const other = [];
  for (let i = 0; i < 22; i++) other.push(await addBook());
  const r = await run();
  assert.equal(r.processed, 20);
  for (const id of shelf) assert.ok((await bookRow(id)).cover_url, "in-stock book done in the first batch");
  const done = (await Promise.all(other.map(bookRow))).filter((b) => b.cover_url).length;
  assert.equal(done, 17);
  assert.equal(calls.length, 20);
  assert.equal((await run()).processed, 5, "the rest in the next run");
});

test("a failed download is counted, spaced out by an hour, and capped at 3 a week", async () => {
  mode = "404";
  const id = await addBook();
  assert.deepEqual(await run(), { processed: 1, stored: 0, failed: 1, transient: 0, stopped: false });
  let b = await bookRow(id);
  assert.equal(b.cover_url, null);
  assert.equal(b.cover_fetch_failures, 1);
  assert.ok(b.cover_fetch_attempted_at);

  assert.equal((await run()).processed, 0, "not again within the hour");
  assert.equal(calls.length, 1);

  const ago = (h) => pool.query("UPDATE books SET cover_fetch_attempted_at = now() - make_interval(hours => $2::int) WHERE id = $1", [id, h]);
  await ago(2);
  assert.equal((await run()).failed, 1);
  assert.equal((await bookRow(id)).cover_fetch_failures, 2);
  await ago(2);
  assert.equal((await run()).failed, 1);
  assert.equal((await bookRow(id)).cover_fetch_failures, MAX_FAILURES);

  await ago(2);
  assert.equal((await run()).processed, 0, "3 failures this week: left alone");
  await ago(24 * 6);
  assert.equal((await run()).processed, 0, "still inside the week");
  assert.equal(calls.length, 3, "exactly 3 attempts so far");

  await ago(24 * 8);
  assert.equal((await run()).failed, 1, "a week later it is tried again, with a fresh count");
  assert.equal((await bookRow(id)).cover_fetch_failures, 1);
  assert.equal(calls.length, 4);

  mode = "ok";
  await ago(2);
  assert.equal((await run()).stored, 1);
  b = await bookRow(id);
  assert.match(b.cover_url, /^\/img\//);
  assert.equal(b.cover_fetch_failures, 0);
});

test("a 5xx answer, a timeout or a network error is NOT a failed attempt (only 404, a placeholder or an invalid image is)", async () => {
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    for (const m of ["500", "network"]) {
      mode = m;
      const id = await addBook();
      const r = await run();
      assert.equal(r.failed, 0, `${m}: not a failure`);
      assert.equal(r.transient, 1);
      const b = await bookRow(id);
      assert.equal(b.cover_fetch_failures, 0, `${m}: failure counter untouched`);
      assert.ok(b.cover_fetch_attempted_at, `${m}: spaced out by the hour`);
      assert.equal((await run()).processed, 0, `${m}: not again within the hour`);
      await pool.query("DELETE FROM books WHERE id = $1", [id]);
    }
    // a timeout: the request never answers
    mode = "ok";
    const id = await addBook();
    const hang = (url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
    const r = await run({ fetchImpl: hang, timeoutMs: 30 });
    assert.deepEqual([r.failed, r.transient], [0, 1]);
    assert.equal((await bookRow(id)).cover_fetch_failures, 0);
    await pool.query("DELETE FROM books WHERE id = $1", [id]);
    // a placeholder image and a 404 DO count
    mode = "placeholder";
    const p = await addBook();
    assert.equal((await run()).failed, 1);
    assert.equal((await bookRow(p)).cover_fetch_failures, 1);
  } finally {
    console.warn = realWarn;
  }
});

test("three network errors in a row stop the batch; the books not tried keep their state", async () => {
  mode = "network";
  const ids = [];
  for (let i = 0; i < 6; i++) ids.push(await addBook());
  const realWarn = console.warn;
  console.warn = () => {};
  let r;
  try { r = await run(); } finally { console.warn = realWarn; }
  assert.equal(r.stopped, true);
  assert.equal(r.transient, 3);
  assert.equal(calls.length, 3, "stopped after the third");
  const untouched = (await Promise.all(ids.map(bookRow))).filter((b) => b.cover_fetch_attempted_at === null).length;
  assert.equal(untouched, 3);
  // a success in between resets the run
  mode = "ok";
  assert.equal((await run()).stopped, false);
});

test("the User-Agent names the site and a contact address (Open Library asks for it)", async () => {
  const seen = [];
  await addBook();
  await run({ fetchImpl: async (url, init) => { seen.push(init.headers["User-Agent"]); return fetchImpl(url); } });
  assert.match(seen[0], /https:\/\/umasbooks\.org/);
  assert.match(seen[0], /admin@umasbooks\.org/);
});

test("a non-image answer counts as a failure and stores nothing", async () => {
  mode = "html";
  const before = await imageCount();
  const id = await addBook();
  assert.equal((await run()).failed, 1);
  assert.equal((await bookRow(id)).cover_url, null);
  assert.equal(await imageCount(), before);
});

test("a source on a host we may not fetch from is dropped, never requested", async () => {
  const id = await addBook({ source: "https://evil.example/c.jpg" });
  assert.equal((await run()).stored, 0);
  assert.equal(calls.length, 0);
  assert.equal((await bookRow(id)).cover_source_url, null);
});

test("a cover set by an admin while the download ran is not overwritten", async () => {
  const id = await addBook();
  const mine = `/img/${"d".repeat(64)}.jpg`;
  const slowFetch = async (url) => {
    await pool.query("UPDATE books SET cover_url = $2 WHERE id = $1", [id, mine]);
    return fetchImpl(url);
  };
  await run({ fetchImpl: slowFetch });
  assert.equal((await bookRow(id)).cover_url, mine);
});

test("prepareCover: stored URL passes through, allowed URL is copied, a failure keeps the source for the job, others are dropped", async () => {
  const stored = `/img/${"e".repeat(64)}.jpg`;
  assert.deepEqual(await prepareCover(stored), { cover: stored, source: null });
  assert.deepEqual(await prepareCover("  "), { cover: null, source: null });
  assert.deepEqual(await prepareCover("https://evil.example/x.jpg", { fetchImpl, lookup }), { cover: null, source: null });
  assert.equal(calls.length, 0);

  const ok = await prepareCover("https://covers.openlibrary.org/b/id/31-L.jpg", { fetchImpl, lookup });
  assert.match(ok.cover, /^\/img\/[0-9a-f]{64}\.jpg$/);
  assert.equal(ok.source, "https://covers.openlibrary.org/b/id/31-L.jpg");

  mode = "404";
  const realWarn = console.warn;
  console.warn = () => {};
  let failed;
  try { failed = await prepareCover("https://covers.openlibrary.org/b/id/32-L.jpg", { fetchImpl, lookup }); } finally { console.warn = realWarn; }
  assert.deepEqual(failed, { cover: null, source: "https://covers.openlibrary.org/b/id/32-L.jpg" });
});
