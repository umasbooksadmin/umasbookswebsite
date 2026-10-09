// The lookup statistics recorder (lib/lookupStats.js) and the instrumentation of the lookup (lib/bookLookup.js).
// Counts only; the database is a fake, fetch is injected, nothing touches the network.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { createLookupStats, COUNTERS } = require("../../src/lib/lookupStats");
const { lookupByIsbnDetailed, createTtlCache, attributeSources } = require("../../src/lib/bookLookup");
const sources = require("../../src/lib/bookSources");
const { parsePeriod } = require("../../src/lib/lookupSourcesReport");

const fakePool = () => {
  const calls = [];
  return { calls, fail: false, async query(sql, params) { calls.push({ sql, params }); if (this.fail) throw new Error("db down"); return { rows: [] }; } };
};
const rowsOf = (pool) => {
  const out = [];
  for (const { params } of pool.calls) for (let i = 0; i < params[0].length; i++) out.push(Object.fromEntries([["day", params[0][i]], ["source", params[1][i]], ...COUNTERS.map((c, k) => [c, params[k + 2][i]])]));
  return out;
};

test("record() adds up per day and source, with response times", () => {
  const s = createLookupStats({ getPool: () => null, now: () => Date.parse("2026-10-09T10:00:00Z") });
  s.record("google", { asked: 1, ms: 100 });
  s.record("google", { asked: 1, won: 1, ms: 300 });
  s.record("bnf", { asked: 1, errors: 1 });
  const snap = Object.fromEntries(s.snapshot().map((r) => [r.source, r]));
  assert.equal(snap.google.asked, 2);
  assert.equal(snap.google.won, 1);
  assert.equal(snap.google.ms_sum, 400);
  assert.equal(snap.google.ms_n, 2);
  assert.equal(snap.bnf.errors, 1);
  assert.equal(snap.google.day, "2026-10-09");
  assert.equal(s.pending(), 2);
});

test("an unknown source or odd input is ignored and record() never throws", () => {
  const s = createLookupStats({ getPool: () => null });
  s.record("evil", { asked: 1 });
  s.record("google", null);
  s.record(undefined, undefined);
  s.record("google", { ms: "abc", asked: 1 });
  assert.equal(s.snapshot().length, 1);
  assert.equal(s.snapshot()[0].ms_n, 0);
});

test("flush() writes everything in ONE upsert with increments and empties the memory", async () => {
  const pool = fakePool();
  const s = createLookupStats({ getPool: () => pool });
  s.record("openlibrary", { asked: 1, won: 1, ms: 50 });
  s.record("openlibrary", { asked: 1, empty: 1, ms: 70 });
  s.record("cache", { asked: 1, won: 1 });
  const r = await s.flush();
  assert.equal(r.rows, 2);
  assert.equal(pool.calls.length, 1);
  assert.match(pool.calls[0].sql, /ON CONFLICT \(day, source\) DO UPDATE SET asked = lookup_source_stats\.asked \+ EXCLUDED\.asked/);
  const ol = rowsOf(pool).find((x) => x.source === "openlibrary");
  assert.deepEqual([ol.asked, ol.won, ol.empty, ol.ms_sum, ol.ms_n], [2, 1, 1, 120, 2]);
  assert.equal(s.pending(), 0);
  assert.deepEqual(await s.flush(), { rows: 0 }, "nothing to write: no query");
  assert.equal(pool.calls.length, 1);
});

test("a failing flush is swallowed, logged once, and the counts are kept for the next try", async () => {
  const pool = fakePool();
  const logs = [];
  const s = createLookupStats({ getPool: () => pool, log: (m) => logs.push(m) });
  pool.fail = true;
  s.record("google", { asked: 1 });
  assert.equal((await s.flush()).failed, true);
  s.record("google", { asked: 1 });
  assert.equal((await s.flush()).failed, true);
  assert.equal(logs.length, 1, "logged once, not on every try");
  assert.equal(s.snapshot()[0].asked, 2, "kept");
  pool.fail = false;
  assert.equal((await s.flush()).rows, 1);
  assert.equal(rowsOf(pool).at(-1).asked, 2);
  // a later failure is logged again
  pool.fail = true;
  s.record("bnf", { asked: 1 });
  await s.flush();
  assert.equal(logs.length, 2);
});

test("a missing pool (getPool throws) is swallowed too", async () => {
  const s = createLookupStats({ getPool: () => { throw new Error("no db"); }, log: () => {} });
  s.record("google", { asked: 1 });
  assert.equal((await s.flush()).failed, true);
});

test("start() flushes on a timer and stop() flushes what is left", async () => {
  const pool = fakePool();
  const s = createLookupStats({ getPool: () => pool, flushMs: 20 });
  s.start();
  s.record("bnf", { asked: 1 });
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(rowsOf(pool).length, 1);
  s.record("bnf", { asked: 1 });
  await s.stop();
  assert.equal(rowsOf(pool).length, 2);
  assert.equal(s.pending(), 0);
});

test("record() is synchronous and does not wait for a slow database", async () => {
  const pool = { query: () => new Promise(() => {}) };
  const s = createLookupStats({ getPool: () => pool });
  s.record("google", { asked: 1 });
  s.flush(); // never resolves
  const t0 = performance.now();
  s.record("google", { asked: 1 });
  assert.ok(performance.now() - t0 < 20);
});

test("attributeSources: the first titled source wins, others fill or are redundant", () => {
  const full = { title: "T", author: "A", publisher: "P", publishedYear: 2000, description: "D" };
  const m = attributeSources([
    ["openlibrary", { title: "T", author: "A", publisher: "P", publishedYear: 2000 }],
    ["bnf", null],
    ["google", { ...full }],
    ["isbndb", { title: "T" }],
  ]);
  assert.equal(m.get("openlibrary"), "won");
  assert.equal(m.get("google"), "filled", "gave the description");
  assert.equal(m.get("isbndb"), "redundant");
  assert.equal(m.has("bnf"), false);
});

// ---- the instrumentation of the lookup ----

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const hang = (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
const brief = (isbn, data) => ({ records: { r: { isbns: [isbn], data } } });
const GOOGLE = (isbn13) => ({ totalItems: 1, items: [{ volumeInfo: { title: "G", authors: ["G A"], publisher: "G Pub", publishedDate: "2010", description: "From Google.", industryIdentifiers: [{ type: "ISBN_13", identifier: isbn13 }] } }] });
function internet(h = {}) {
  return async (url, init = {}) => {
    const u = String(url);
    if (u.includes("openlibrary.org/api/volumes/brief")) return (h.brief || (() => json({})))(u, init);
    if (u.includes("openlibrary.org/api/books")) return (h.data || (() => json({})))(u, init);
    if (u.includes("googleapis.com")) return (h.google || (() => json({ totalItems: 0 })))(u, init);
    if (u.includes("catalogue.bnf.fr")) return (h.bnf || (() => new Response("<x/>", { status: 200 })))(u, init);
    if (u.includes("isbndb.com")) return (h.isbndb || (() => json({}, 404)))(u, init);
    throw new Error(`unexpected request ${u}`);
  };
}
function fakeStats() {
  const events = [];
  const total = {};
  return { events, total, record(source, d) { events.push([source, d]); const t = (total[source] ||= {}); for (const [k, v] of Object.entries(d)) if (k !== "ms") t[k] = (t[k] || 0) + v; else t.ms_n = (t.ms_n || 0) + 1; } };
}
const run = (isbn, fetchImpl, o = {}) => lookupByIsbnDetailed(isbn, { fetchImpl, cache: createTtlCache(), hedgeMs: 0, timeoutMs: 1500, graceMs: 40, lateMs: 60, ...o });

const saved = {};
beforeEach(() => { for (const k of ["ISBNDB_API_KEY", "ISBNDB_API_BASE", "ISBNDB_MIN_INTERVAL_MS", "SCAN_LOOKUP_SOURCES"]) { saved[k] = process.env[k]; delete process.env[k]; } sources.resetSourcePauses(); });
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

test("lookup: Open Library gives the title, Google only fills; BnF is not asked for a non-French ISBN", async () => {
  const isbn = "9780143127550";
  const stats = fakeStats();
  const f = internet({ brief: () => json(brief(isbn, { title: "OL Title" })), google: () => json(GOOGLE(isbn)) });
  const r = await run(isbn, f, { stats });
  assert.equal(r.state, "found");
  assert.equal(stats.total.openlibrary.won, 1);
  assert.equal(stats.total.google.filled, 1);
  assert.equal(stats.total.bnf, undefined, "not asked: not counted");
  assert.equal(stats.total.lookup.asked, 1);
  assert.equal(stats.total.lookup.won, 1);
  assert.equal(stats.total.none, undefined);
  assert.equal(stats.total.openlibrary.ms_n, 1, "a response time was recorded");
});

test("lookup: nothing anywhere counts 'found nothing' and 'not found'", async () => {
  const stats = fakeStats();
  const r = await run("9780143127550", internet(), { stats });
  assert.equal(r.state, "missing");
  assert.equal(stats.total.openlibrary.empty, 1);
  assert.equal(stats.total.google.empty, 1);
  assert.equal(stats.total.none.asked, 1);
  assert.equal(stats.total.lookup.won, 0);
});

test("lookup: 429 is 'refused', a 500 an error, a hang that is cut short is 'cut short'", async () => {
  const stats = fakeStats();
  const f = internet({ brief: () => json({}, 500), google: () => json({}, 429), data: (u, init) => hang(init) });
  await run("9780143127550", f, { stats, timeoutMs: 250, lateMs: 30 });
  assert.equal(stats.total.google.limited, 1);
  assert.equal(stats.total.openlibrary.errors, 1);
  assert.equal(stats.total["openlibrary-data"].cancelled, 1);
  assert.equal(stats.total["openlibrary-data"].ms_n, undefined, "no response time for a cut-short call");
});

test("lookup: a repeat is a cache hit; a cached miss counts as not found too", async () => {
  const isbn = "9780143127550";
  const stats = fakeStats();
  const cache = createTtlCache();
  const f = internet({ brief: () => json(brief(isbn, { title: "T" })) });
  await run(isbn, f, { stats, cache });
  await run(isbn, f, { stats, cache });
  assert.equal(stats.total.cache.asked, 1);
  assert.equal(stats.total.cache.won, 1);
  assert.equal(stats.total.lookup.asked, 1);
  const miss = fakeStats();
  await run("9780306406157", internet(), { stats: miss, cache });
  await run("9780306406157", internet(), { stats: miss, cache });
  assert.equal(miss.total.cache.asked, 1);
  assert.equal(miss.total.none.asked, 2);
});

test("lookup: ISBNdb counts its paid call, and a 401 as refused", async () => {
  process.env.ISBNDB_API_KEY = "test-key";
  process.env.ISBNDB_MIN_INTERVAL_MS = "0";
  const stats = fakeStats();
  await run("9780143127550", internet({ isbndb: () => json({}, 401) }), { stats });
  assert.equal(stats.total.isbndb.paid_calls, 1);
  assert.equal(stats.total.isbndb.asked, 1);
  assert.equal(stats.total.isbndb.limited, 1);
});

test("zero behaviour change: the answer is the same with a recorder that throws", async () => {
  const isbn = "9780143127550";
  const f = () => internet({ brief: () => json(brief(isbn, { title: "OL Title", authors: [{ name: "A" }] })), google: () => json(GOOGLE(isbn)) });
  const a = await run(isbn, f());
  const b = await run(isbn, f(), { stats: { record() { throw new Error("boom"); } } });
  assert.deepEqual(b.book, a.book);
  assert.deepEqual(b.via, a.via);
  assert.equal(b.state, a.state);
});

test("parsePeriod: today, 7 days, 30 days (default), this month, all time", () => {
  const today = "2026-10-09";
  assert.deepEqual([parsePeriod("today", today).from, parsePeriod("today", today).to], ["2026-10-09", "2026-10-09"]);
  assert.equal(parsePeriod("7d", today).from, "2026-10-03");
  assert.equal(parsePeriod(undefined, today).key, "30d");
  assert.equal(parsePeriod("bogus", today).from, "2026-09-10");
  assert.equal(parsePeriod("month", today).from, "2026-10-01");
  assert.equal(parsePeriod("all", today).from, null);
});
