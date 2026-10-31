// Cost and abuse caps, outbound side: response bodies of the catalogs are read with a size limit (1 MB; BnF XML 2 MB),
// and concurrent lookups of one ISBN share ONE set of outside calls. fetch is injected; nothing touches the network.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { readBoundedText, readBoundedJson, BodyTooLargeError, DEFAULT_MAX_BYTES, XML_MAX_BYTES } = require("../../src/lib/boundedBody");
const { lookupByIsbnDetailed, createTtlCache } = require("../../src/lib/bookLookup");
const sources = require("../../src/lib/bookSources");
const { createInflight } = require("../../src/lib/inflight");
const { requestJson } = require("../../src/lib/awards/http");
const { isbn13From } = require("../helpers/isbn");

const ISBN = isbn13From("978014312755");
const brief = (isbn, data) => ({ records: { r: { isbns: [isbn], data } } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// A body of n bytes that is NOT announced by Content-Length (a chunked answer), streamed in 64 KB pieces.
function streamOf(n, { onPull } = {}) {
  let sent = 0;
  return new ReadableStream({
    pull(controller) {
      if (onPull) onPull(sent);
      const size = Math.min(65536, n - sent);
      if (size <= 0) return controller.close();
      controller.enqueue(new Uint8Array(size).fill(32));
      sent += size;
    },
  });
}

// A VALID json answer made huge by one padding field, streamed without a Content-Length: without a size cap it would
// parse and be used, so only the cap can refuse it.
function bigValidJson(obj, extraBytes) {
  const bytes = new TextEncoder().encode(JSON.stringify({ ...obj, pad: "x".repeat(extraBytes) }));
  let at = 0;
  return new ReadableStream({
    pull(controller) {
      if (at >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(at, at + 65536));
      at += 65536;
    },
  });
}

const saved = {};
beforeEach(() => { for (const k of ["ISBNDB_API_KEY", "SCAN_LOOKUP_SOURCES", "SCAN_CACHE_TTL_MS"]) { saved[k] = process.env[k]; delete process.env[k]; } sources.resetSourcePauses(); });
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

// ---------------------------------------------------------------- size caps

test("readBoundedText: the Content-Length is checked first; a body without one is aborted once it grows past the limit", async () => {
  const announced = new Response("x".repeat(100), { headers: { "content-length": String(DEFAULT_MAX_BYTES + 1) } });
  await assert.rejects(readBoundedText(announced), BodyTooLargeError);

  let pulled = 0;
  const big = new Response(streamOf(50 * 1024 * 1024, { onPull: (sent) => { pulled = sent; } }));
  await assert.rejects(readBoundedText(big), BodyTooLargeError);
  assert.ok(pulled < 3 * 1024 * 1024, `the stream was cancelled early (read ${pulled} bytes of 50 MB)`);

  assert.equal(await readBoundedText(new Response("small")), "small");
  assert.deepEqual(await readBoundedJson(new Response('{"a":1}')), { a: 1 });
  assert.equal((await readBoundedText(new Response("y".repeat(DEFAULT_MAX_BYTES)))).length, DEFAULT_MAX_BYTES, "exactly the limit is fine");
  await assert.rejects(readBoundedText(new Response("y".repeat(DEFAULT_MAX_BYTES + 1))), BodyTooLargeError);
  await assert.rejects(readBoundedText({ text: async () => "z".repeat(DEFAULT_MAX_BYTES + 1) }), BodyTooLargeError, "a fake with only text()");
});

test("lookup: an oversized Open Library answer is 'source failed' (counted as an error), never data", async () => {
  process.env.SCAN_LOOKUP_SOURCES = "openlibrary";
  const recorded = [];
  const stats = { record: (name, delta) => recorded.push([name, delta]) };
  const fetchImpl = async () => new Response(bigValidJson(brief(ISBN, { title: "Would be used without the cap" }), DEFAULT_MAX_BYTES + 5000), { status: 200, headers: { "content-type": "application/json" } });
  const r = await lookupByIsbnDetailed(ISBN, { fetchImpl, cache: false, stats, hedgeMs: 0, timeoutMs: 1500 });
  assert.equal(r.book, null);
  assert.notEqual(r.state, "found");
  const ol = recorded.find(([n]) => n === "openlibrary");
  assert.ok(ol && ol[1].errors === 1, `counted as an error: ${JSON.stringify(recorded)}`);
});

test("lookup: an oversized answer from one source does not hide a good one", async () => {
  process.env.SCAN_LOOKUP_SOURCES = "openlibrary,google";
  const fetchImpl = async (url) => {
    if (String(url).includes("openlibrary.org")) return new Response(bigValidJson(brief(ISBN, { title: "Huge OL" }), DEFAULT_MAX_BYTES + 100));
    return json({ totalItems: 1, items: [{ volumeInfo: { title: "From Google", industryIdentifiers: [{ identifier: ISBN }] } }] });
  };
  const r = await lookupByIsbnDetailed(ISBN, { fetchImpl, cache: false, stats: { record() {} }, hedgeMs: 0, timeoutMs: 1500, graceMs: 20, lateMs: 30 });
  assert.equal(r.state, "found");
  assert.equal(r.book.title, "From Google");
});

test("BnF XML may be up to 2 MB, not more", async () => {
  const forms = sources.isbnForms("9782070368228");
  const xmlOf = (n) => new Response(`<x>${" ".repeat(n)}</x>`, { status: 200 });
  const over = await sources.bnf({ forms, fetchImpl: async () => xmlOf(XML_MAX_BYTES + 10), signal: new AbortController().signal });
  assert.equal(over.state, "error", "over 2 MB: source failed");
  const between = await sources.bnf({ forms, fetchImpl: async () => xmlOf(DEFAULT_MAX_BYTES + 10), signal: new AbortController().signal });
  assert.notEqual(between.state, "error", "1 MB < size < 2 MB is still read");
});

test("ISBNdb and Google answers are size-limited too", async () => {
  process.env.ISBNDB_API_KEY = "k";
  process.env.ISBNDB_MIN_INTERVAL_MS = "0";
  const forms = sources.isbnForms(ISBN);
  const signal = new AbortController().signal;
  const helpers = { pickGenres: () => null };
  const hugeIsbndb = await sources.isbndb({ forms, fetchImpl: async () => new Response(bigValidJson({ book: { title: "Huge" } }, DEFAULT_MAX_BYTES + 1)), signal, helpers });
  assert.equal(hugeIsbndb.state, "error");
  const hugeGoogle = await sources.googleBooks({ forms, fetchImpl: async () => new Response(bigValidJson({ items: [] }, DEFAULT_MAX_BYTES + 1)), signal, helpers });
  assert.equal(hugeGoogle.state, "error");
  delete process.env.ISBNDB_MIN_INTERVAL_MS;
});

test("awards fetchers (Wikidata, NYT) share the limit: an oversized answer is a failed request", async () => {
  const big = await requestJson("https://example.test/x", { fetch: async () => new Response(bigValidJson({ a: 1 }, DEFAULT_MAX_BYTES + 1)) });
  assert.equal(big.ok, false);
  assert.match(big.error, /too large/);
  const fine = await requestJson("https://example.test/x", { fetch: async () => json({ a: 1 }) });
  assert.deepEqual([fine.ok, fine.json], [true, { a: 1 }]);
});

// ---------------------------------------------------------------- in-flight sharing

test("createInflight: concurrent callers share one run; the entry is cleaned up (also after a failure); the map is bounded", async () => {
  const f = createInflight(2);
  let runs = 0;
  const slow = () => new Promise((r) => setTimeout(() => { runs += 1; r("v"); }, 20));
  const all = await Promise.all([f.run("a", slow), f.run("a", slow), f.run("a", slow)]);
  assert.deepEqual(all, ["v", "v", "v"]);
  assert.equal(runs, 1);
  assert.equal(f.size, 0, "cleaned up in finally");
  await assert.rejects(f.run("b", async () => { throw new Error("boom"); }));
  assert.equal(f.size, 0, "also after a failure");
  const again = await f.run("b", async () => "fresh");
  assert.equal(again, "fresh", "a failure is not remembered");
  // bounded: with 2 keys running, a third runs alone, unshared
  let third = 0;
  const hold = (k) => f.run(k, () => new Promise((r) => setTimeout(r, 30)));
  const p = [hold("k1"), hold("k2"), f.run("k3", async () => { third += 1; }), f.run("k3", async () => { third += 1; })];
  assert.equal(f.size, 2);
  await Promise.all(p);
  assert.equal(third, 2);
});

test("20 concurrent lookups of the same ISBN make ONE set of outside calls, and each gets its own copy", async () => {
  process.env.SCAN_LOOKUP_SOURCES = "openlibrary";
  const urls = [];
  const fetchImpl = async (url, init = {}) => {
    if (init.method === "HEAD") return new Response(null, { status: 404 }); // the exact-ISBN cover check is not a catalog request
    urls.push(String(url));
    await new Promise((r) => setTimeout(r, 30));
    return json(brief(ISBN, { title: "Shared", authors: [{ name: "A" }], publishers: [{ name: "P" }], publish_date: "2015" }));
  };
  const results = await Promise.all(Array.from({ length: 20 }, () => lookupByIsbnDetailed(ISBN, { fetchImpl, cache: createTtlCache(), stats: { record() {} }, hedgeMs: 0, timeoutMs: 1500 })));
  assert.equal(urls.length, 1, `one outbound request, got ${urls.length}`);
  assert.ok(results.every((r) => r.state === "found" && r.book.title === "Shared"));
  results[0].book.title = "changed by one caller";
  assert.equal(results[1].book.title, "Shared", "separate copies");
  // and the map is empty again: a later lookup asks afresh
  await lookupByIsbnDetailed(ISBN, { fetchImpl, cache: createTtlCache(), stats: { record() {} }, hedgeMs: 0, timeoutMs: 1500 });
  assert.equal(urls.length, 2);
});
