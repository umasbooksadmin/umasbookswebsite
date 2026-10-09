// The ISBN lookup of the scan page must be quick and must never hang the page:
// a tight deadline with a "slow" answer, a hedged second request when the first
// is slow, a cache so the same ISBN is not asked twice, and after-response jobs
// for the work the save does not have to wait for. No network: fetch is injected.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { lookupByIsbnDetailed, createTtlCache } = require("../../src/lib/bookLookup");
const { runAfterResponse, settled } = require("../../src/lib/afterResponse");
const { serverTiming, createTimings } = require("../../src/lib/timing");

// A 979- ISBN has no ISBN-10 form, so one source asks once. Only Open Library here: the other sources have their own file.
process.env.SCAN_LOOKUP_SOURCES = "openlibrary";
const ISBN = "9791090636071";
const record = (title) => ({ records: { r: { isbns: [ISBN], data: { title, authors: [{ name: "A. Writer" }], publishers: [{ name: "Pub" }], publish_date: "2001" } } } });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
// A fetch that never answers on its own, only when its signal aborts.
const hang = (_url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))));
const counting = (impl) => { const f = async (...a) => { f.calls += 1; return impl(f.calls, ...a); }; f.calls = 0; return f; };

test("a hung catalog gives 'slow' after the deadline, not a long wait; the other sources are not needed", async () => {
  const fetchImpl = counting((n, url, init) => hang(url, init));
  const t0 = performance.now();
  const r = await lookupByIsbnDetailed(ISBN, { fetchImpl, timeoutMs: 120, hedgeMs: 0, cache: createTtlCache() });
  assert.equal(r.state, "slow");
  assert.equal(r.book, null);
  assert.ok(performance.now() - t0 < 1000, "gave up quickly");
});

test("a slow first request is hedged: the second request's answer wins", async () => {
  const fetchImpl = counting((n, url, init) => (n === 1 ? hang(url, init) : json(record("Hedged"))));
  const r = await lookupByIsbnDetailed(ISBN, { fetchImpl, timeoutMs: 2000, hedgeMs: 30, cache: createTtlCache() });
  assert.equal(r.state, "found");
  assert.equal(r.book.title, "Hedged");
  assert.equal(fetchImpl.calls, 2);
});

test("a request that fails fast is retried at once, only once", async () => {
  const flaky = counting((n) => { if (n === 1) throw new Error("ECONNRESET"); return json(record("Second try")); });
  assert.equal((await lookupByIsbnDetailed(ISBN, { fetchImpl: flaky, timeoutMs: 2000, hedgeMs: 0, cache: createTtlCache() })).book.title, "Second try");
  const dead = counting(() => { throw new Error("ECONNRESET"); });
  const r = await lookupByIsbnDetailed(ISBN, { fetchImpl: dead, timeoutMs: 2000, hedgeMs: 0, cache: createTtlCache() });
  assert.equal(r.state, "error");
  assert.equal(dead.calls, 2);
});

test("cache: the second lookup of the same ISBN does not call the network; errors and timeouts are not cached", async () => {
  const cache = createTtlCache();
  const fetchImpl = counting(() => json(record("Cached")));
  const first = await lookupByIsbnDetailed(ISBN, { fetchImpl, cache });
  const second = await lookupByIsbnDetailed(ISBN, { fetchImpl, cache });
  assert.equal(fetchImpl.calls, 1);
  assert.equal(first.cached, undefined);
  assert.equal(second.cached, true);
  assert.equal(second.book.title, "Cached");
  second.book.title = "changed by the caller";
  assert.equal((await lookupByIsbnDetailed(ISBN, { fetchImpl, cache })).book.title, "Cached", "a caller cannot change the cached copy");

  const missing = counting(() => json({}));
  const c2 = createTtlCache();
  assert.equal((await lookupByIsbnDetailed(ISBN, { fetchImpl: missing, cache: c2 })).state, "missing");
  await lookupByIsbnDetailed(ISBN, { fetchImpl: missing, cache: c2 });
  assert.equal(missing.calls, 1, "'not in the catalog' is cached too");

  const c3 = createTtlCache();
  const failing = counting(() => { throw new Error("down"); });
  await lookupByIsbnDetailed(ISBN, { fetchImpl: failing, cache: c3, hedgeMs: 0 });
  const before = failing.calls;
  await lookupByIsbnDetailed(ISBN, { fetchImpl: failing, cache: c3, hedgeMs: 0 });
  assert.ok(failing.calls > before, "a network error is asked again");
  const timed = counting((n, url, init) => hang(url, init));
  const c4 = createTtlCache();
  await lookupByIsbnDetailed(ISBN, { fetchImpl: timed, cache: c4, timeoutMs: 40, hedgeMs: 0 });
  await lookupByIsbnDetailed(ISBN, { fetchImpl: timed, cache: c4, timeoutMs: 40, hedgeMs: 0 });
  assert.equal(timed.calls, 2, "a timeout is asked again");
});

test("cache: entries expire and the cache is bounded (least recently used goes first)", () => {
  let now = 1000;
  const c = createTtlCache({ max: 2, ttlMs: 100, now: () => now });
  c.set("a", 1); c.set("b", 2);
  assert.equal(c.get("a"), 1); // a is now the most recently used
  c.set("c", 3);
  assert.equal(c.get("b"), undefined);
  assert.equal(c.get("a"), 1);
  now += 101;
  assert.equal(c.get("a"), undefined);
  assert.equal(createTtlCache({ ttlMs: 0 }).set("x", 1) || 0, 0);
});

test("after-response jobs run later, a few at a time, and a failing job does not throw", async () => {
  const order = [];
  let running = 0;
  let peak = 0;
  const warn = console.warn;
  const warnings = [];
  console.warn = (...a) => warnings.push(a.join(" "));
  try {
    runAfterResponse("boom", async () => { throw new Error("nope"); });
    for (let i = 0; i < 8; i++) {
      runAfterResponse(`job ${i}`, async () => { running += 1; peak = Math.max(peak, running); await new Promise((r) => setTimeout(r, 15)); running -= 1; order.push(i); });
    }
    assert.equal(order.length, 0, "nothing ran before the caller returned");
    await settled();
  } finally {
    console.warn = warn;
  }
  assert.equal(order.length, 8);
  assert.ok(peak <= 3, `at most 3 at once (saw ${peak})`);
  assert.ok(warnings.some((w) => /boom/.test(w) && /nope/.test(w)));
});

test("timing: steps are summed and written as a Server-Timing header; slow requests are logged", async () => {
  const t = createTimings();
  await t.time("a", async () => new Promise((r) => setTimeout(r, 10)));
  await t.time("a", async () => new Promise((r) => setTimeout(r, 10)));
  t.add("b", 1.25);
  assert.match(t.header(30), /^a;dur=\d+\.\d, b;dur=1\.3, total;dur=30\.0$|^a;dur=\d+\.\d, b;dur=1\.2, total;dur=30\.0$/);
  assert.ok(t.steps().get("a") >= 15);

  const logs = [];
  const mw = serverTiming("scan.test", { log: (m) => logs.push(m), env: { SCAN_SLOW_LOG_MS: "0" } });
  const headers = {};
  const listeners = {};
  const res = { headersSent: false, setHeader: (k, v) => { headers[k] = v; }, writeHead() { return this; }, on: (e, f) => { listeners[e] = f; } };
  const req = {};
  mw(req, res, () => {});
  req.timing.add("lookup", 5);
  res.writeHead(200);
  listeners.finish();
  assert.match(headers["Server-Timing"], /lookup;dur=5\.0, total;dur=/);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /\[slow scan\.test\].*lookup;dur=5\.0/);
});
