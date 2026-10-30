// The exact-ISBN cover (Open Library often files a cover under the ISBN only) is found for BOTH the ISBN-13 and the ISBN-10 form,
// shows in the scan preview (lookupByIsbnDetailed returns it as coverUrl) and is what saving stores. Never a title search.
// No network: fetch is injected and every request is recorded.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { lookupByIsbnDetailed, createTtlCache, exactIsbnCover, isbnCoverUrls } = require("../../src/lib/bookLookup");
const { findCoverUrl, coverOriginOf } = require("../../src/lib/bookFill");

process.env.SCAN_LOOKUP_SOURCES = "openlibrary";
const ISBN13 = "9780330298117";
const ISBN10 = "0330298119";
const url13 = `https://covers.openlibrary.org/b/isbn/${ISBN13}-L.jpg?default=false`;
const url10 = `https://covers.openlibrary.org/b/isbn/${ISBN10}-L.jpg?default=false`;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const record = (cover) => ({ records: { r: { isbns: [ISBN13], data: { title: "T", authors: [{ name: "A" }], publishers: [{ name: "P" }], publish_date: "1987", ...(cover ? { cover: { large: cover } } : {}) } } } });

// A fake Open Library: the brief record, and which exact-ISBN cover addresses exist.
function fake({ cover, has = [], headStatus = {} } = {}) {
  const f = async (url, init = {}) => {
    f.log.push({ url: String(url), method: init.method || "GET" });
    if (init.method === "HEAD") return new Response(null, { status: headStatus[url] || (has.includes(url) ? 200 : 404) });
    return json(record(cover));
  };
  f.log = [];
  f.heads = () => f.log.filter((c) => c.method === "HEAD").map((c) => c.url);
  return f;
}

test("isbnCoverUrls: the ISBN-13 first, then the ISBN-10; nothing for an invalid ISBN or a 979 book's missing ISBN-10", () => {
  assert.deepEqual(isbnCoverUrls(ISBN10), [url13, url10]);
  assert.deepEqual(isbnCoverUrls("978-0-330-29811-7"), [url13, url10]);
  assert.deepEqual(isbnCoverUrls("9780330298118"), []);
  assert.deepEqual(isbnCoverUrls("9791090636071"), ["https://covers.openlibrary.org/b/isbn/9791090636071-L.jpg?default=false"]);
});

test("exactIsbnCover: finds a cover filed under the ISBN-10 only", async () => {
  const f = fake({ has: [url10] });
  assert.deepEqual(await exactIsbnCover(ISBN13, { fetchImpl: f }), { url: url10, state: "found" });
  assert.deepEqual(f.heads().sort(), [url10, url13].sort(), "both forms asked");
});

test("exactIsbnCover: both forms exist -> the ISBN-13 wins; none -> state none; a failing check -> state error", async () => {
  assert.equal((await exactIsbnCover(ISBN13, { fetchImpl: fake({ has: [url10, url13] }) })).url, url13);
  assert.deepEqual(await exactIsbnCover(ISBN13, { fetchImpl: fake() }), { url: null, state: "none" });
  const down = async () => { throw new Error("ECONNRESET"); };
  assert.deepEqual(await exactIsbnCover(ISBN13, { fetchImpl: down }), { url: null, state: "error" });
  const limited = fake({ headStatus: { [url13]: 429 } });
  assert.equal((await exactIsbnCover(ISBN13, { fetchImpl: limited })).state, "error");
});

test("exactIsbnCover: a hung request gives up after the short deadline", async () => {
  const hang = (_u, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const t0 = performance.now();
  const r = await exactIsbnCover(ISBN13, { fetchImpl: hang, timeoutMs: 60 });
  assert.equal(r.state, "error");
  assert.ok(performance.now() - t0 < 1000);
});

test("scan lookup: a record with no cover gets the exact-ISBN cover as coverUrl (ISBN-10 form too)", async () => {
  const r = await lookupByIsbnDetailed(ISBN13, { fetchImpl: fake({ has: [url10] }), cache: createTtlCache(), hedgeMs: 0, timeoutMs: 2000, stats: { record() {} } });
  assert.equal(r.state, "found");
  assert.equal(r.book.coverUrl, url10);
});

test("scan lookup: the record's own cover is kept and no cover check is made", async () => {
  const f = fake({ cover: "https://covers.openlibrary.org/b/id/777-L.jpg", has: [url13] });
  const r = await lookupByIsbnDetailed(ISBN13, { fetchImpl: f, cache: createTtlCache(), hedgeMs: 0, timeoutMs: 2000, stats: { record() {} } });
  assert.equal(r.book.coverUrl, "https://covers.openlibrary.org/b/id/777-L.jpg");
});

test("scan lookup: no cover anywhere -> coverUrl stays null; the answer is cached with its cover (one set of requests)", async () => {
  const f = fake();
  const cache = createTtlCache();
  const o = { fetchImpl: f, cache, hedgeMs: 0, timeoutMs: 2000, stats: { record() {} } };
  assert.equal((await lookupByIsbnDetailed(ISBN13, o)).book.coverUrl, null);
  const before = f.log.length;
  const again = await lookupByIsbnDetailed(ISBN13, o);
  assert.equal(again.cached, true);
  assert.equal(f.log.length, before, "second scan asks nothing");
  const f2 = fake({ has: [url13] });
  const c2 = createTtlCache();
  const hit = await lookupByIsbnDetailed(ISBN13, { ...o, fetchImpl: f2, cache: c2 });
  assert.equal(hit.book.coverUrl, url13);
  assert.equal((await lookupByIsbnDetailed(ISBN13, { ...o, fetchImpl: f2, cache: c2 })).book.coverUrl, url13, "the cached copy has the cover too");
});

test("scan lookup: a failing cover check does not fail the lookup, and is not remembered for the full time", async () => {
  const f = async (url, init = {}) => { if (init.method === "HEAD") throw new Error("ECONNRESET"); return json(record(null)); };
  const r = await lookupByIsbnDetailed(ISBN13, { fetchImpl: f, cache: false, hedgeMs: 0, timeoutMs: 2000, stats: { record() {} } });
  assert.equal(r.state, "found");
  assert.equal(r.book.coverUrl, null);
});

test("findCoverUrl: tries the ISBN-10 form too, never a title search", async () => {
  const seen = [];
  const real = global.fetch;
  global.fetch = async (url, init = {}) => {
    seen.push(String(url));
    if (init.method === "HEAD") return new Response(null, { status: String(url) === url10 ? 200 : 404 });
    return json(record(null));
  };
  try {
    assert.equal(await findCoverUrl({ isbn: ISBN13 }), url10);
    assert.deepEqual(seen.filter((u) => u.includes("search.json")), []);
  } finally { global.fetch = real; }
});

test("coverOriginOf: an Open Library ISBN cover address is origin 'isbn', anything else that came with the form is 'form'", () => {
  assert.equal(coverOriginOf(url10), "isbn");
  assert.equal(coverOriginOf(url13), "isbn");
  assert.equal(coverOriginOf("https://covers.openlibrary.org/b/id/5-L.jpg"), "form");
  assert.equal(coverOriginOf("/img/abc.jpg"), "form");
});
