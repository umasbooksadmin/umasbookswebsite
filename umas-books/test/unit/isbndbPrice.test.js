// The suggested publisher's price from ISBNdb's list price (lib/isbndbPrice.js). ISBNdb is always mocked:
// no test reaches the network or needs a key.

const { test, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const P = require("../../src/lib/isbndbPrice");
const sources = require("../../src/lib/bookSources");
const { lookupByIsbnDetailed, createTtlCache } = require("../../src/lib/bookLookup");
const S = require("../../public/scan-intake.js");

const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
const ISBN = "9780143127550";
const RATES = { usdEur: 0.92, gbpEur: 1.15 };
const noStats = { record() {} };

function isbndbOnly(handler) {
  const calls = [];
  const f = async (url, init = {}) => { calls.push({ url: String(url), headers: init.headers || {} }); return handler(String(url), init); };
  f.calls = calls;
  return f;
}
const ask = (fetchImpl, isbn = ISBN, extra = {}) => P.lookupListPrice(isbn, { fetchImpl, stats: noStats, sleep: async () => {}, ...extra });

const saved = {};
beforeEach(() => {
  for (const k of ["ISBNDB_API_KEY", "ISBNDB_MIN_INTERVAL_MS", "ISBNDB_PRICE_TTL_MS"]) { saved[k] = process.env[k]; delete process.env[k]; }
  process.env.ISBNDB_API_KEY = "test-key";
  process.env.ISBNDB_MIN_INTERVAL_MS = "0";
  sources.resetSourcePauses();
});
afterEach(() => { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });

test("extractListPrice: list_price object, listPrice spelling, msrp as USD; zero, negative, junk or unknown currency are 'no price'", () => {
  assert.deepEqual(P.extractListPrice({ list_price: { amount: 8.99, currency: "usd" } }), { amount: 8.99, currency: "USD" });
  assert.deepEqual(P.extractListPrice({ listPrice: { amount: 7.5, currency: "GBP" } }), { amount: 7.5, currency: "GBP" });
  assert.deepEqual(P.extractListPrice({ msrp: 12.5 }), { amount: 12.5, currency: "USD" });
  assert.deepEqual(P.extractListPrice({ list_price: { amount: 9, currency: "EUR" }, msrp: 99 }), { amount: 9, currency: "EUR" }, "the object wins over msrp");
  for (const bad of [{ msrp: 0 }, { msrp: -3 }, { msrp: null }, { msrp: "n/a" }, {}, null, { list_price: { amount: 0, currency: "USD" } }, { list_price: { amount: 5, currency: "" } }, { list_price: { amount: 5 } }, { list_price: { amount: "x", currency: "USD" } }]) {
    assert.equal(P.extractListPrice(bad), null, JSON.stringify(bad));
  }
});

test("convertToEur: rates from the settings, EUR as is, nearest 0.05, unsupported currency or no rate is no price", () => {
  assert.deepEqual(P.convertToEur(8.99, "USD", RATES), { eur: 8.25, rate: 0.92 }); // 8.2708 -> 8.25
  assert.equal(P.convertToEur(9.99, "USD", RATES).eur, 9.2); // 9.1908 -> 9.20
  assert.equal(P.convertToEur(6.99, "GBP", RATES).eur, 8.05); // 8.0385 -> 8.05
  assert.equal(P.convertToEur(12.9, "EUR", RATES).eur, 12.9);
  assert.equal(P.convertToEur(12.93, "EUR", RATES).eur, 12.95);
  assert.equal(P.convertToEur(10, "USD", { usdEur: 0.5 }).eur, 5, "an edited rate changes the answer");
  assert.equal(P.convertToEur(10, "JPY", RATES), null);
  assert.equal(P.convertToEur(10, "", RATES), null);
  assert.equal(P.convertToEur(0, "USD", RATES), null);
  assert.equal(P.convertToEur(10, "USD", {}), null);
});

test("USD, GBP and EUR prices come back as a suggestion with the original and the converted figure", async () => {
  const cases = [
    [{ list_price: { amount: 8.99, currency: "USD" } }, { eur: 8.25, cur: "USD", approximate: true }],
    [{ list_price: { amount: 6.99, currency: "GBP" } }, { eur: 8.05, cur: "GBP", approximate: true }],
    [{ list_price: { amount: 11.9, currency: "EUR" } }, { eur: 11.9, cur: "EUR", approximate: false }],
    [{ msrp: 8.99 }, { eur: 8.25, cur: "USD", approximate: true }],
  ];
  for (const [book, want] of cases) {
    P.clearPriceCache();
    const f = isbndbOnly(() => json({ book: { title: "T", ...book } }));
    const r = await P.suggestPublisherPrice(ISBN, RATES, { fetchImpl: f, stats: noStats, sleep: async () => {} });
    assert.equal(r.state, "price");
    assert.equal(r.eur, want.eur);
    assert.equal(r.original.currency, want.cur);
    assert.equal(r.approximate, want.approximate);
  }
});

test("a missing, zero or currency-less price is 'none'; a 404 is 'none'; nothing is saved by the library", async () => {
  for (const body of [{ book: { title: "T" } }, { book: { title: "T", msrp: 0 } }, { book: { title: "T", list_price: { amount: 5, currency: "" } } }]) {
    P.clearPriceCache();
    assert.equal((await ask(isbndbOnly(() => json(body)))).state, "none");
  }
  P.clearPriceCache();
  assert.equal((await ask(isbndbOnly(() => json({}, 404)))).state, "none");
  P.clearPriceCache();
  const unknown = await P.suggestPublisherPrice(ISBN, RATES, { fetchImpl: isbndbOnly(() => json({ book: { list_price: { amount: 5, currency: "JPY" } } })), stats: noStats, sleep: async () => {} });
  assert.equal(unknown.state, "none", "an unsupported currency cannot be converted");
});

test("without a key ISBNdb is never called", async () => {
  delete process.env.ISBNDB_API_KEY;
  const f = isbndbOnly(() => json({ book: { msrp: 5 } }));
  assert.deepEqual(await ask(f), { state: "off" });
  assert.equal(f.calls.length, 0);
});

test("the answer is cached per ISBN, 'no price' too: a second ask makes no second call", async () => {
  const f = isbndbOnly(() => json({ book: { title: "T", msrp: 8.99 } }));
  assert.equal((await ask(f)).state, "ok");
  const again = await ask(f);
  assert.equal(again.state, "ok");
  assert.equal(again.cached, true);
  assert.equal(f.calls.length, 1);
  const none = isbndbOnly(() => json({ book: { title: "T" } }));
  await ask(none, "9780306406157");
  await ask(none, "9780306406157");
  assert.equal(none.calls.length, 1, "a book with no price is not re-asked");
  assert.equal(f.calls[0].headers.Authorization, "test-key");
  assert.equal(f.calls[0].url, `https://api2.isbndb.com/book/${ISBN}`);
});

test("the cache expires after the TTL", async () => {
  process.env.ISBNDB_PRICE_TTL_MS = "1000";
  let t = 1_000_000;
  const f = isbndbOnly(() => json({ book: { msrp: 5 } }));
  await ask(f, ISBN, { now: () => t });
  t += 500; await ask(f, ISBN, { now: () => t });
  assert.equal(f.calls.length, 1);
  t += 1000; await ask(f, ISBN, { now: () => t });
  assert.equal(f.calls.length, 2);
});

test("two asks at the same moment share ONE request", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const f = isbndbOnly(async () => { await gate; return json({ book: { msrp: 5 } }); });
  const a = ask(f); const b = ask(f);
  release();
  assert.equal((await a).state, "ok");
  assert.equal((await b).state, "ok");
  assert.equal(f.calls.length, 1);
});

test("401 pauses ISBNdb for 30 minutes: the price says 'unavailable', no further calls, and failures are not cached", async () => {
  const log = console.warn; const logs = []; console.warn = (...a) => logs.push(a.join(" "));
  try {
    const f = isbndbOnly(() => json({ message: "bad" }, 401));
    assert.equal((await ask(f)).state, "unavailable");
    assert.equal((await ask(f, "9780306406157")).state, "unavailable");
    assert.equal(f.calls.length, 1, "paused after the first refusal");
    assert.equal(sources.isbndbStatus().status, "invalid");
    assert.ok(sources.isbndbStatus().pausedUntil > Date.now());
    assert.equal(logs.filter((l) => /ISBNdb/.test(l)).length, 1);
    assert.ok(!logs.join("\n").includes("test-key"));
  } finally { console.warn = log; }
});

test("429 pauses for Retry-After; a request that fails (network, 500, huge body) is 'unavailable'", async () => {
  const log = console.warn; console.warn = () => {};
  try {
    const f = isbndbOnly(() => json({ message: "slow down" }, 429, { "retry-after": "90" }));
    assert.equal((await ask(f)).state, "unavailable");
    assert.equal(sources.isbndbStatus().status, "rate_limited");
    const left = sources.isbndbStatus().pausedUntil - Date.now();
    assert.ok(left > 80_000 && left <= 90_000, `paused about 90 s (${left})`);
    sources.resetSourcePauses();
    assert.equal((await ask(isbndbOnly(() => { throw new Error("net"); }))).state, "unavailable");
    assert.equal((await ask(isbndbOnly(() => json({}, 500)))).state, "unavailable");
    const big = new Response("x".repeat(1024 * 1024 + 10), { status: 200, headers: { "content-type": "application/json" } });
    assert.equal((await ask(isbndbOnly(() => big))).state, "unavailable", "response size cap");
  } finally { console.warn = log; }
});

test("a request that hangs is cut at the timeout", async () => {
  const f = isbndbOnly((u, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
  const r = await ask(f, ISBN, { timeoutMs: 30 });
  assert.equal(r.state, "unavailable");
});

test("the title fallback's answer already carries the price: it is remembered, so the price costs no second call", async () => {
  const f = isbndbOnly((u) => {
    if (u.includes("isbndb.com")) return json({ book: { title: "Paid Title", authors: ["A"], publisher: "P", date_published: "2020", msrp: 7.99 } });
    return u.includes("googleapis") ? json({ totalItems: 0 }) : u.includes("bnf.fr") ? new Response("<x/>") : json({});
  });
  const r = await lookupByIsbnDetailed("9791090636071", { fetchImpl: f, cache: createTtlCache(), hedgeMs: 0, timeoutMs: 1500, graceMs: 40, lateMs: 60 });
  assert.equal(r.book.title, "Paid Title");
  const n = f.calls.filter((c) => c.url.includes("isbndb.com")).length;
  const price = await ask(f, "9791090636071");
  assert.equal(price.state, "ok");
  assert.equal(f.calls.filter((c) => c.url.includes("isbndb.com")).length, n, "no second paid call");
});

// ---- the page's side: texts, and never filling by itself
test("page texts: the suggestion, the EUR price, no price, and silence when off or not New", () => {
  const m = S.isbndbPriceMessage({ state: "price", original: { amount: 8.99, currency: "USD" }, eur: 8.4 });
  assert.equal(m.text, "Suggested from ISBNdb: 8.99 USD = about €8.40. Check the price printed on the book.");
  assert.equal(m.value, "8.40");
  const e = S.isbndbPriceMessage({ state: "price", original: { amount: 11.9, currency: "EUR" }, eur: 11.9 });
  assert.match(e.text, /^ISBNdb list price: 11\.90 EUR\./);
  assert.equal(S.isbndbPriceMessage({ state: "none" }).text, "ISBNdb has no price for this book: type the price printed on the cover.");
  assert.equal(S.isbndbPriceMessage({ state: "none" }).value, "");
  assert.equal(S.isbndbPriceMessage({ state: "off" }).text, "");
  assert.equal(S.isbndbPriceMessage({ state: "not_new" }).text, "");
  assert.equal(S.isbndbPriceMessage(null).text, "");
});

test("page: asked only for a New book with an empty publisher's price and a complete ISBN", () => {
  assert.equal(S.wantsIsbndbPrice("new", "", "9780143127550"), true);
  assert.equal(S.wantsIsbndbPrice("new", "  ", "978-0-14-312755-0"), true);
  assert.equal(S.wantsIsbndbPrice("new", "8.50", "9780143127550"), false, "a typed price is never second-guessed");
  assert.equal(S.wantsIsbndbPrice("very_good", "", "9780143127550"), false);
  assert.equal(S.wantsIsbndbPrice("new", "", "97801431"), false);
  // never auto-fills: the script only ever writes the field inside the "Use this price" click handler
  const src = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../public/scan-intake.js"), "utf8");
  assert.equal((src.match(/priceField\.value = /g) || []).length, 1, "one place sets the price field");
  assert.match(src, /priceUse\.addEventListener\("click"[^]*?priceField\.value = suggested/);
});
