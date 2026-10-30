// Scan a book, fast: the lookup and the save of the one-screen "Add a book" page
// (src/routes/admin/inventoryLookup.js, POST /admin/inventory) must answer without
// waiting on the slow outside sources. Everything outside is stubbed at global.fetch
// with controllable delays: Open Library (catalog), the cover host, the AI.
//
//   lookup  - a catalog that hangs gives "not found / slow" at the deadline; a cover or a price
//             check that is slower than its budget never holds the answer back;
//             the second lookup of one ISBN does not call Open Library again; Server-Timing is sent.
//   save    - answers as soon as the copy is saved: the cover download, the AI description and its
//             translation finish afterwards (lib/bookFill.js) and fill only what is still empty.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");

const db = prepareDatabase("scan_speed", { isolated: true });
const { pool } = require("../../src/db");
const { requireAdmin } = require("../../src/middleware/auth");
const coverStore = require("../../src/lib/coverStore");
const { lookupCache } = require("../../src/lib/bookLookup");
const { settled } = require("../../src/lib/afterResponse");
coverStore.setLookupForTests(async () => [{ address: "93.184.216.34", family: 4 }]);

const realFetch = global.fetch;
const delays = { catalog: 0, cover: 0, ai: 0, market: 0 };
const calls = { catalog: 0, cover: 0, ai: 0 };
const books = new Map();
let png;
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  const t = setTimeout(resolve, ms);
  if (signal) signal.addEventListener("abort", () => { clearTimeout(t); reject(new Error("aborted")); });
});
global.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1:")) return realFetch(url, init);
  if (u.startsWith("https://openlibrary.org/api/volumes/brief/isbn/")) {
    calls.catalog += 1;
    await sleep(delays.catalog, init.signal);
    const isbn = u.match(/isbn\/([0-9X]+)\.json$/)[1];
    const data = books.get(isbn);
    return new Response(JSON.stringify(data ? { records: { r: { isbns: [isbn], data } } } : {}), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (u.startsWith("https://openlibrary.org/")) return new Response(JSON.stringify({ docs: [] }), { status: 200 });
  if (u.startsWith("https://covers.openlibrary.org/")) {
    if (init.method === "HEAD") return new Response(null, { status: 404 }); // the exact-ISBN cover check is not a cover download
    calls.cover += 1;
    await sleep(delays.cover, init.signal);
    return new Response(png, { status: 200, headers: { "content-type": "image/png" } });
  }
  if (u.startsWith("https://api.anthropic.com/")) {
    const prompt = JSON.parse(init.body).messages[0].content;
    if (init.body.includes("web_search")) {
      await sleep(delays.market, init.signal).catch(() => {});
      return new Response("{}", { status: 500 });
    }
    calls.ai += 1;
    await sleep(delays.ai, init.signal);
    return new Response(JSON.stringify({ content: [{ text: prompt.startsWith("Translate") ? "Une description." : "A description." }] }), { status: 200 });
  }
  throw new Error(`test refused a real outbound request to ${u}`);
};

let server;
let adminId;
before(async () => {
  png = await sharp({ create: { width: 200, height: 300, channels: 3, background: "#369" } }).png().toBuffer();
  db.create();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
  const gate = express.Router();
  gate.use("/admin/inventory", requireAdmin, upload.fields([{ name: "photo", maxCount: 1 }, { name: "coverPhoto", maxCount: 1 }]));
  server = await listen(buildApp([gate, require("../../src/routes/admin/inventoryLookup"), require("../../src/routes/admin/inventory")]));
  const { rows } = await pool.query("INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ($1, 'x', 'Speed Admin', true) RETURNING id", [`speed-admin-${Date.now()}@example.test`]);
  adminId = rows[0].id;
});
after(async () => {
  await settled();
  global.fetch = realFetch;
  await server.close();
  await pool.end();
  db.drop();
});
beforeEach(() => {
  Object.assign(delays, { catalog: 0, cover: 0, ai: 0, market: 0 });
  Object.assign(calls, { catalog: 0, cover: 0, ai: 0 });
  books.clear();
  lookupCache.clear();
  coverStore.clearCoverMemo();
  for (const k of ["SCAN_LOOKUP_TIMEOUT_MS", "SCAN_COVER_WAIT_MS", "SCAN_PRICE_WAIT_MS", "PRICING_AI", "ANTHROPIC_API_KEY"]) delete process.env[k];
});

let seq = 0;
const { isbn13From } = require("../helpers/isbn");
const isbn13 = () => isbn13From(`979${String(Date.now()).slice(-5)}${String(++seq).padStart(4, "0")}`); // 13 digits, unique, a real check digit (the lookup refuses a wrong one)
const adminHeader = () => ({ "x-test-user": JSON.stringify({ id: adminId, email: "a@example.test", displayName: "Admin", isAdmin: true }), accept: "application/json" });
const COVER = "https://covers.openlibrary.org/b/id/1-L.jpg";
const catalogEntry = (title, extra = {}) => ({ title, authors: [{ name: "Ann Author" }], publishers: [{ name: "Pub" }], publish_date: "1999", cover: { large: COVER }, ...extra });

async function lookup(isbn, qs = "") {
  const t0 = performance.now();
  const res = await realFetch(`${server.base}/admin/inventory/lookup?isbn=${isbn}${qs}`, { headers: adminHeader(), signal: AbortSignal.timeout(20000) });
  return { res, body: await res.json(), ms: performance.now() - t0 };
}
async function save(fields) {
  const t0 = performance.now();
  const res = await realFetch(`${server.base}/admin/inventory`, {
    method: "POST", redirect: "manual", headers: { ...adminHeader(), "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ condition: "very_good", price: "5", status: "in_stock", fast: "1", location: "Store", source: "donation", ...fields }).toString(),
    signal: AbortSignal.timeout(20000),
  });
  return { res, body: await res.json(), ms: performance.now() - t0 };
}
const bookRow = async (isbn) => (await pool.query("SELECT * FROM books WHERE isbn = $1", [isbn])).rows[0];

// ------------------------------------------------------------------ lookup

test("lookup: a catalog that hangs answers 'slow, fill in by hand' at the deadline, and the price still comes", async () => {
  process.env.SCAN_LOOKUP_TIMEOUT_MS = "200";
  delays.catalog = 5000;
  const isbn = isbn13();
  const { body, ms } = await lookup(isbn);
  assert.ok(ms < 2500, `answered in ${ms.toFixed(0)} ms, not after the 5 s the catalog needed`);
  assert.equal(body.ok, true);
  assert.equal(body.found, false);
  assert.equal(body.catalog, "slow");
  assert.equal(typeof body.suggestion.price, "number");
});

test("lookup: a price check slower than its budget does not hold the answer back (rules price, catalog result intact)", async () => {
  process.env.PRICING_AI = "1";
  process.env.ANTHROPIC_API_KEY = "test-key";
  process.env.SCAN_PRICE_WAIT_MS = "150";
  delays.market = 1500;
  const isbn = isbn13();
  books.set(isbn, catalogEntry("Primary Result", { cover: undefined }));
  const { body, ms } = await lookup(isbn);
  assert.ok(ms < 1200, `answered in ${ms.toFixed(0)} ms while the market check needed 1.5 s`);
  assert.equal(body.found, true);
  assert.equal(body.book.title, "Primary Result");
  assert.equal(typeof body.suggestion.price, "number");
  await new Promise((r) => setTimeout(r, 1500)); // let the stubbed market call finish before the next test
});

test("lookup: a cover slower than its budget is left out of the preview, the book is still found", async () => {
  process.env.SCAN_COVER_WAIT_MS = "100";
  delays.cover = 1200;
  const isbn = isbn13();
  books.set(isbn, catalogEntry("Slow Cover"));
  const { body, ms } = await lookup(isbn);
  assert.ok(ms < 1000, `answered in ${ms.toFixed(0)} ms`);
  assert.equal(body.found, true);
  assert.equal(body.book.title, "Slow Cover");
  assert.equal(body.book.coverUrl, null);
  await settled();
  await new Promise((r) => setTimeout(r, 1300)); // the download goes on in the background
});

test("lookup: a quick cover is shown as our own copy (/img/...)", async () => {
  const isbn = isbn13();
  books.set(isbn, catalogEntry("Quick Cover"));
  const { body } = await lookup(isbn);
  assert.match(body.book.coverUrl, /^\/img\/[0-9a-f]+\.jpg$/);
});

test("lookup: the second lookup of the same ISBN does not call Open Library or the cover host again", async () => {
  const isbn = isbn13();
  books.set(isbn, catalogEntry("Twice"));
  const first = await lookup(isbn);
  assert.equal(calls.catalog, 1);
  assert.equal(calls.cover, 1);
  const second = await lookup(isbn);
  assert.equal(calls.catalog, 1, "catalog answered from memory");
  assert.equal(calls.cover, 1, "cover copy remembered");
  assert.equal(second.body.book.title, "Twice");
  assert.equal(second.body.book.coverUrl, first.body.book.coverUrl);
  assert.ok(second.ms < 150, `the repeat took ${second.ms.toFixed(0)} ms`);
});

test("lookup: answers carry a Server-Timing header with the steps", async () => {
  const isbn = isbn13();
  books.set(isbn, catalogEntry("Timed", { cover: undefined }));
  const { res } = await lookup(isbn);
  const h = res.headers.get("server-timing");
  for (const step of ["db", "catalog", "price", "total"]) assert.match(h, new RegExp(`${step};dur=\\d`));
});

// -------------------------------------------------------------------- save

test("save: answers before the cover has been downloaded; the cover then fills in by itself", async () => {
  delays.cover = 1500;
  const isbn = isbn13();
  const r = await save({ isbn, title: "Cover Later", description: "d", coverUrl: COVER });
  assert.equal(r.res.status, 200);
  assert.equal(r.body.ok, true);
  assert.ok(r.ms < 1000, `the save answered in ${r.ms.toFixed(0)} ms while the cover needs 1.5 s`);
  assert.match(r.res.headers.get("server-timing"), /db;dur=\d/);
  let row = await bookRow(isbn);
  assert.equal(row.cover_url, null, "no cover yet");
  assert.equal(row.cover_source_url, COVER, "the source is kept for the cover job");
  const copies = await pool.query("SELECT count(*)::int AS n FROM book_copies WHERE book_id = $1", [row.id]);
  assert.equal(copies.rows[0].n, 1, "the copy is saved");
  await settled();
  row = await bookRow(isbn);
  assert.match(row.cover_url, /^\/img\/[0-9a-f]+\.jpg$/);
});

test("save: a slow AI description does not delay the save; it is filled in afterwards (English only), never over typed text", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  delays.ai = 1200;
  const noCover = { cover: undefined };
  const isbn = isbn13();
  const r = await save({ isbn, title: "Words Later" });
  assert.ok(r.ms < 900, `the save answered in ${r.ms.toFixed(0)} ms while each AI call needs 1.2 s`);
  assert.equal((await bookRow(isbn)).description, null);
  await settled();
  const row = await bookRow(isbn);
  assert.equal(row.description, "A description.");

  // Typed text is stored at once and the AI is not asked for it.
  calls.ai = 0;
  const isbn2 = isbn13();
  await save({ isbn: isbn2, title: "Typed", description: "Typed words", coverUrl: "" });
  await settled();
  const row2 = await bookRow(isbn2);
  assert.equal(row2.description, "Typed words");
  assert.equal(calls.ai, 0);
  void noCover;
});

test("save: a book saved without a cover gets one found afterwards (from the catalog, remembered from the lookup)", async () => {
  const isbn = isbn13();
  books.set(isbn, catalogEntry("Find My Cover"));
  await lookup(isbn); // the catalog answer is now remembered
  const catalogCalls = calls.catalog;
  const r = await save({ isbn, title: "Find My Cover", description: "d" });
  assert.ok(r.ms < 800);
  await settled();
  assert.match((await bookRow(isbn)).cover_url, /^\/img\//);
  assert.equal(calls.catalog, catalogCalls, "no second catalog call: it was remembered");
});

test("save: a second copy of a book that lacks its texts fills them afterwards without delaying the answer", async () => {
  process.env.ANTHROPIC_API_KEY = "test-key";
  const isbn = isbn13();
  await save({ isbn, title: "Two Copies", description: "d", coverUrl: "" });
  await settled();
  await pool.query("UPDATE books SET description = NULL WHERE isbn = $1", [isbn]);
  delays.ai = 1000;
  const r = await save({ isbn, title: "Two Copies" });
  assert.ok(r.ms < 800, `answered in ${r.ms.toFixed(0)} ms`);
  await settled();
  const row = await bookRow(isbn);
  assert.equal(row.description, "A description.");
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM book_copies WHERE book_id = $1", [row.id])).rows[0].n, 2);
});

test("diagnostics: /admin/diagnostics/lookup lists the sources, says ISBNdb is off without a key, and never shows a key", async () => {
  const diag = express.Router();
  const alone = await listen(buildApp([diag.use(require("../../src/routes/admin/diagnostics"))]));
  try {
    const get = () => realFetch(`${alone.base}/admin/diagnostics/lookup`, { headers: adminHeader() }).then((r) => r.text());
    const off = await get();
    assert.match(off, /Open Library/);
    assert.match(off, /no <code>ISBNDB_API_KEY<\/code> is set/);
    process.env.ISBNDB_API_KEY = "super-secret-value";
    try {
      const on = await get();
      assert.doesNotMatch(on, /super-secret-value/);
      assert.doesNotMatch(on, /is set\./);
      assert.match(on, /Key set/);
      assert.match(on, /Paid calls today \(Paris time\): 0 of 500 allowed/);
      await pool.query("INSERT INTO ai_daily_cap (day, scope, calls) VALUES ((now() AT TIME ZONE 'Europe/Paris')::date, 'isbndb', 500) ON CONFLICT (day, scope) DO UPDATE SET calls = 500");
      assert.match(await get(), /Paid calls today \(Paris time\): 500 of 500 allowed[\s\S]*Daily limit reached/);
      await pool.query("DELETE FROM ai_daily_cap WHERE scope = 'isbndb'");
    } finally {
      delete process.env.ISBNDB_API_KEY;
    }
    const anon = await realFetch(`${alone.base}/admin/diagnostics/lookup`, { redirect: "manual" });
    assert.equal(anon.status, 302);
  } finally {
    await alone.close();
  }
});
