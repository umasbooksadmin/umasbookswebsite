// A cover is taken only for the book's EXACT ISBN (either form). The French Lieutenant's Woman (9780330298117, Picador 1987)
// has no Open Library cover of its own; the old fill then searched by title and took another edition's (or book's) picture.
// Also: ISBNs starting with 987 (an ISBN-10 group prefix, or a scanner misread of 978). global.fetch is stubbed and every
// request is recorded, so "no title search" is checked on the wire.

const { test, beforeEach, afterEach, mock } = require("node:test");
const assert = require("node:assert/strict");

const { lookupCache, isValidIsbn, normalizeIsbn, isbnCoverUrl, searchByTitleAuthor } = require("../../src/lib/bookLookup");
const { isbnForms, isbn10to13, isbn13to10 } = require("../../src/lib/bookSources");
const { findCoverUrl, fillBookGaps } = require("../../src/lib/bookFill");
const { checkCover, pictureId } = require("../../src/lib/coverReview");

const realFetch = global.fetch;
const realSources = process.env.SCAN_LOOKUP_SOURCES;
const calls = [];
let handler;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  process.env.SCAN_LOOKUP_SOURCES = "openlibrary";
  process.env.SCAN_CACHE_TTL_MS = "0";
  lookupCache.clear();
  calls.length = 0;
  handler = () => json({}, 404);
  global.fetch = async (url, init = {}) => { calls.push(String(url)); return handler(String(url), init); };
  mock.method(console, "warn", () => {});
});
afterEach(() => {
  global.fetch = realFetch;
  delete process.env.SCAN_CACHE_TTL_MS;
  if (realSources === undefined) delete process.env.SCAN_LOOKUP_SOURCES; else process.env.SCAN_LOOKUP_SOURCES = realSources;
  mock.restoreAll();
});

const FLW = "9780330298117"; // The French Lieutenant's Woman, Picador 1987 (scanned as 0-330-29811-9)
const searchCalls = () => calls.filter((u) => u.includes("search.json"));

test("findCoverUrl: no catalog cover -> Open Library's cover for the exact ISBN-13, and NO title search", async () => {
  handler = (u) => (u.includes("/api/volumes/brief/") ? json({ records: { "/books/OL1M": { isbns: [FLW], data: { title: "The French Lieutenant's Woman" } } } }) : json({}, 404));
  const url = await findCoverUrl({ isbn: "0-330-29811-9", title: "The French Lieutenant's Woman", author: "John Fowles" });
  assert.equal(url, `https://covers.openlibrary.org/b/isbn/${FLW}-L.jpg?default=false`);
  assert.deepEqual(searchCalls(), [], "no title/author search is made for a cover");
});

test("findCoverUrl: the catalog record's own cover wins", async () => {
  handler = () => json({ records: { "/books/OL1M": { isbns: [FLW], data: { title: "X", cover: { large: "https://covers.openlibrary.org/b/id/777-L.jpg" } } } } });
  assert.equal(await findCoverUrl({ isbn: FLW }), "https://covers.openlibrary.org/b/id/777-L.jpg");
  assert.deepEqual(searchCalls(), []);
});

test("findCoverUrl: a book with no ISBN, or an invalid one, gets no cover and no request at all", async () => {
  assert.equal(await findCoverUrl({ isbn: null, title: "Dune", author: "Frank Herbert" }), null);
  assert.equal(await findCoverUrl({ isbn: "9780330298118", title: "Dune" }), null, "wrong check digit");
  assert.equal(await findCoverUrl({ isbn: "9871234567897", title: "Dune" }), null, "987... is not a 13-digit ISBN");
  assert.deepEqual(calls, []);
});

test("searchByTitleAuthor never returns a cover, even when Open Library sends cover_i", async () => {
  handler = () => json({ docs: [{ title: "Other", isbn: ["111"], cover_i: 42 }] });
  const [r] = await searchByTitleAuthor("The French Lieutenant's Woman", "Fowles");
  assert.equal(r.coverUrl, null);
});

test("fillBookGaps: with no exact-ISBN cover the book is saved with no cover (and records no origin)", async () => {
  const queries = [];
  const pool = { query: async (sql, params) => { queries.push({ sql, params }); return sql.startsWith("SELECT") ? { rows: [{ description: "d", cover_url: null, cover_removed_at: null }] } : { rows: [] }; } };
  const out = await fillBookGaps(pool, 1, { isbn: FLW, title: "T" }, { findCoverUrl: async () => null, prepareCover: async () => ({ cover: null, source: null }), generateBookDescription: async () => null });
  assert.equal(out.filled, false);
  assert.equal(queries.length, 1, "nothing written");
});

test("fillBookGaps: a cover found by ISBN is recorded as origin 'isbn'; one that came with the form as 'form'", async () => {
  const writes = [];
  const pool = { query: async (sql, params) => { if (sql.startsWith("SELECT")) return { rows: [{ description: "d", cover_url: null, cover_removed_at: null }] }; writes.push(params); return { rows: [] }; } };
  const deps = { findCoverUrl: async () => "https://covers.openlibrary.org/b/isbn/x-L.jpg", prepareCover: async (u) => ({ cover: "/img/a.jpg", source: u }), generateBookDescription: async () => null };
  await fillBookGaps(pool, 1, { isbn: FLW }, deps);
  await fillBookGaps(pool, 2, { isbn: FLW, coverUrl: "https://covers.openlibrary.org/b/id/5-L.jpg" }, deps);
  assert.equal(writes[0][4], "isbn");
  assert.equal(writes[1][4], "form");
});

// ---------------------------------------------------------------- 987 prefixes

function isbn10With(body9) {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(body9[i]);
  const c = (11 - (sum % 11)) % 11;
  return body9 + (c === 10 ? "X" : String(c));
}
function isbn13With(body12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body12[i]) * (i % 2 ? 3 : 1);
  return body12 + String((10 - (sum % 10)) % 10);
}

test("an ISBN-10 starting 987 (Argentine publishers) is a real ISBN-10 and converts to 978987...", () => {
  const ten = isbn10With("987123456");
  assert.ok(isValidIsbn(ten));
  const thirteen = isbn10to13(ten);
  assert.equal(thirteen.slice(0, 6), "978987");
  assert.ok(isValidIsbn(thirteen));
  assert.deepEqual(isbnForms(ten), { isbn13: thirteen, isbn10: ten });
  assert.deepEqual(isbnForms(thirteen), { isbn13: thirteen, isbn10: ten });
  assert.equal(isbn13to10(thirteen), ten);
  assert.equal(isbnCoverUrl(ten), `https://covers.openlibrary.org/b/isbn/${thirteen}-L.jpg?default=false`);
  assert.equal(isbnCoverUrl(thirteen), isbnCoverUrl(ten), "both forms give the same cover address");
});

test("a 13-digit number starting 987 (a misread 978) is rejected cleanly, even with a correct check digit", async () => {
  const misread = isbn13With("987123456789");
  assert.equal(misread.length, 13);
  assert.equal(isValidIsbn(misread), false);
  assert.equal(isbnCoverUrl(misread), null, "no cover address is built for it");
  assert.equal(await findCoverUrl({ isbn: misread }), null);
  assert.deepEqual(calls, [], "no catalog is asked");
  assert.equal(isbn13to10(misread), null);
  // the scanner misread of 978... as 987...: swapping back gives the real, valid ISBN
  assert.ok(isValidIsbn(isbn13With("978123456789")));
  assert.equal(normalizeIsbn("987-1-234-56789-7"), "9871234567897");
});

// ---------------------------------------------------------------- the review check

const book = { isbn: FLW, cover_source_url: "https://covers.openlibrary.org/b/id/111-L.jpg" };

test("checkCover: same numbered picture as the catalog's -> match", async () => {
  const r = await checkCover(book, { lookupByIsbn: async () => ({ coverUrl: "https://covers.openlibrary.org/b/id/111-M.jpg" }) });
  assert.equal(r.state, "match");
  assert.equal(pictureId("https://covers.openlibrary.org/b/id/111-L.jpg"), "111");
});

test("checkCover: a different picture, no catalog cover, no ISBN and a failed lookup are told apart", async () => {
  assert.equal((await checkCover(book, { lookupByIsbn: async () => ({ coverUrl: "https://covers.openlibrary.org/b/id/222-L.jpg" }) })).state, "different");
  assert.equal((await checkCover(book, { lookupByIsbn: async () => ({ coverUrl: null }), head: async () => false })).state, "none");
  assert.equal((await checkCover(book, { lookupByIsbn: async () => ({ coverUrl: null }), head: async () => true })).state, "different");
  assert.equal((await checkCover({ isbn: null }, {})).state, "no-isbn");
  assert.equal((await checkCover(book, { lookupByIsbn: async () => null })).state, "unavailable");
});

// ---------------------------------------------------------------- scan with no cover -> save -> fill (Sharon, 2026-10-30)

test("scan finds no cover -> save -> fillBookGaps (real findCoverUrl): no other edition's cover is ever added", async () => {
  // The catalog knows the book but has no cover; a title search WOULD offer a picture (cover_i 999), the cover server 404s.
  handler = (u) => {
    if (u.includes("/api/volumes/brief/")) return json({ records: { "/books/OL1M": { isbns: [FLW], data: { title: "The French Lieutenant's Woman" } } } });
    if (u.includes("search.json")) return json({ docs: [{ title: "Another book", cover_i: 999 }] });
    return json({}, 404);
  };
  const writes = [];
  const pool = { query: async (sql, params) => { if (sql.startsWith("SELECT")) return { rows: [{ description: "d", cover_url: null, cover_removed_at: null }] }; writes.push(params); return { rows: [] }; } };
  // hints as the save sends them: the scan screen showed no cover, so no coverUrl hint
  await fillBookGaps(pool, 1, { isbn: FLW, title: "The French Lieutenant's Woman", author: "John Fowles" }, { generateBookDescription: async () => null });
  assert.deepEqual(searchCalls(), [], "no title search");
  assert.ok(!calls.some((u) => u.includes("/b/id/")), "no numbered (title-search) picture was fetched");
  for (const w of writes) {
    assert.equal(w[1], null, "no cover stored");
    assert.ok(w[2] === null || w[2].includes(`/b/isbn/${FLW}-`), "at most the exact-ISBN address is kept for the background job");
  }
});
