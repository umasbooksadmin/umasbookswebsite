// The award lookups (src/lib/awards/*) with the network stubbed through the
// injectable `fetch`: Wikidata parser and query, NYT mapper / rate gate / key
// secrecy, the AI parser and its safeguards, and the typed-in awards parser.
// Nothing here touches the network or the database.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const wikidata = require("../../src/lib/awards/wikidata");
const nyt = require("../../src/lib/awards/nyt");
const { parseManualAwards } = require("../../src/lib/awards/manual");

const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const b = (awardLabel, year, kind) => ({
  ...(awardLabel === undefined ? {} : { awardLabel: { type: "literal", value: awardLabel } }),
  ...(year ? { year: { type: "literal", value: String(year) } } : {}),
  kind: { type: "literal", value: kind },
});

// ---------------------------------------------------------------- Wikidata

const SPARQL = {
  head: { vars: ["awardLabel", "year", "kind"] },
  results: {
    bindings: [
      b("Hugo Award for Best Novel", 1990, "award"),
      b("Hugo Award for Best Novel", 1990, "shortlist"), // same award listed twice: one row, the win
      b("Nebula Award for Best Novel", 1989, "shortlist"),
      b(undefined, 1991, "award"), // no English label: skipped
      b("Q123456", 1991, "award"), // a bare Q-number is not a label either
      b("Locus Award", null, "award"),
      b("Locus Award", 1991, "award"), // dated copy wins over the undated one
      b("  Spaced   ", 2001, "award"),
    ],
  },
};

test("wikidata: parses awards and nominations, skips unlabeled, dedupes", () => {
  const items = wikidata.parseBindings(SPARQL);
  assert.deepEqual(items.map((i) => [i.label, i.year, i.kind]), [
    ["Hugo Award for Best Novel", 1990, "award"],
    ["Nebula Award for Best Novel", 1989, "shortlist"],
    ["Locus Award", 1991, "award"],
    ["Spaced", 2001, "award"],
  ]);
});

test("wikidata: at most 15 per book; junk responses give nothing", () => {
  const many = { results: { bindings: Array.from({ length: 40 }, (_, i) => b(`Prize ${i}`, 2000 + (i % 20), "award")) } };
  assert.equal(wikidata.parseBindings(many).length, 15);
  assert.deepEqual(wikidata.parseBindings(null), []);
  assert.deepEqual(wikidata.parseBindings({ results: {} }), []);
});

const noSleep = async () => {};

test("wikidata: valid hyphenated forms are generated for ISBN-13 and ISBN-10", () => {
  const cases = {
    "9781400033416": ["978-1-4000-3341-6", "1-4000-3341-1"], // Beloved
    "9780156027328": ["978-0-15-602732-8", "0-15-602732-1"], // Life of Pi
    "9780679731726": ["978-0-679-73172-6", "0-679-73172-5"], // The Remains of the Day
    "0306406152": ["978-0-306-40615-7", "0-306-40615-2"], // given as ISBN-10
  };
  for (const [input, [h13, h10]] of Object.entries(cases)) {
    const ids = wikidata.cleanIsbns(input);
    assert.equal(ids.isbn13h, h13, input);
    assert.equal(ids.isbn10h, h10, input);
    const q = wikidata.buildQuery(ids);
    for (const v of [ids.isbn13, ids.isbn10, h13, h10]) assert.ok(q.includes(`"${v}"`), `${v} is searched`);
  }
  // 979- books have no ISBN-10 at all.
  const fr = wikidata.cleanIsbns("9791032305690");
  assert.equal(fr.isbn13h, "979-10-323-0569-0");
  assert.equal(fr.isbn10h, null);
  // Something that is not a valid ISBN still searches the plain form but invents no hyphenated one.
  const bad = wikidata.cleanIsbns("1234567890123");
  assert.deepEqual([bad.isbn13h, bad.isbn10h], [null, null]);
});

test("wikidata: the ISBN can never break out of the query", () => {
  assert.equal(wikidata.buildQuery(wikidata.cleanIsbns('9780000000002" } UNION { ?x ?y ?z #')), null);
  const evil = wikidata.cleanIsbns('978"; DROP\\ 0306406152');
  assert.ok(!evil.isbn13 || /^\d{13}$/.test(evil.isbn13));
  const q = wikidata.buildQuery({ isbn13: '9780306406157" } #', isbn10: "0306406152", isbn13h: '978-0"} #', isbn10h: null });
  assert.ok(!q.includes("#") && !q.includes("DROP"), "anything that is not digits, X or hyphens is dropped");
  assert.ok(q.includes('"0306406152"'));
});

test("wikidata: the query only reads awards of the matching edition or its work", () => {
  const q = wikidata.buildQuery(wikidata.cleanIsbns("9781400033416"));
  // ISBN is bound first, then the edition, then the holder: ?holder can never be unbound.
  assert.match(q, /VALUES \?isbn \{[^}]*"978-1-4000-3341-6"[^}]*\}/);
  assert.ok(q.includes("?edition wdt:P212 ?isbn") && q.includes("?edition wdt:P957 ?isbn"));
  assert.ok(q.includes("?edition wdt:P629? ?holder"), "the edition itself or the work it is an edition of");
  assert.ok(q.indexOf("?edition wdt:P629? ?holder") < q.indexOf("?holder ?pp ?st"), "the holder is bound before any award pattern");
  assert.ok(q.includes("p:P166 ps:P166") && q.includes("p:P1411 ps:P1411") && q.includes("pq:P585"));
  assert.ok(q.includes('"award"') && q.includes('"shortlist"'));
  assert.ok(!q.includes("BIND(?item AS ?work)"), "the old unbound-?work pattern is gone");
  assert.ok(!/\?work\b/.test(q));
  assert.match(q, /LIMIT \d+\s*$/);
  assert.ok(q.includes('wikibase:language "en,mul"'), "English, then language-neutral labels");
  // The two statement kinds must not be a UNION: that shape times out on the live service.
  assert.ok(!/UNION\s*\{\s*\?holder/.test(q));
});

test("wikidata: the author query asks only about the Nobel Prize in Literature", () => {
  const q = wikidata.buildAuthorQuery(wikidata.cleanIsbns("9781400033416"));
  assert.ok(q.includes("?holder wdt:P50 ?author") && q.includes("ps:P166 wd:Q37922"));
  assert.ok(q.includes('"978-1-4000-3341-6"'));
  assert.equal(wikidata.buildAuthorQuery(wikidata.cleanIsbns("")), null);
  assert.deepEqual(wikidata.parseAuthorNobel({ results: { bindings: [{ year: { value: "1993" } }] } }), [
    { label: "Author: Nobel Prize in Literature", year: 1993, kind: "award", source_url: null },
  ]);
  assert.equal(wikidata.parseAuthorNobel({ results: { bindings: [{}] } })[0].year, null);
  assert.deepEqual(wikidata.parseAuthorNobel({ results: { bindings: [] } }), []);
  assert.deepEqual(wikidata.parseAuthorNobel(null), []);
});

// A fetch stub that answers the awards query and the author query separately.
const routed = ({ awards = SPARQL, author = { results: { bindings: [] } } } = {}) => async (url) =>
  json(decodeURIComponent(String(url)).includes("wdt:P50") ? author : awards);

test("wikidata: the author's Nobel Prize in Literature is added with a clear label; its failure is not fatal", async () => {
  const author = { results: { bindings: [{ year: { value: "1993" } }] } };
  const res = await wikidata.lookupWikidataAwards({ isbn: "9781400033416" }, { fetch: routed({ author }), gapMs: 0, sleep: noSleep });
  assert.equal(res.error, false);
  assert.ok(res.items.some((i) => i.label === "Author: Nobel Prize in Literature" && i.year === 1993));
  assert.equal(res.items.length, 5);

  const warn = console.warn;
  console.warn = () => {};
  try {
    const fetch = async (url) => (decodeURIComponent(String(url)).includes("wdt:P50") ? json({}, 500) : json(SPARQL));
    const ok = await wikidata.lookupWikidataAwards({ isbn: "9781400033416" }, { fetch, gapMs: 0, sleep: noSleep });
    assert.equal(ok.error, false, "the book's own awards still count");
    assert.equal(ok.items.length, 4);
  } finally {
    console.warn = warn;
  }
});

test("wikidata: sends the User-Agent, parses the answer, and fails open", async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers });
    return json(decodeURIComponent(String(url)).includes("wdt:P50") ? { results: { bindings: [] } } : SPARQL);
  };
  const ok = await wikidata.lookupWikidataAwards({ isbn: "9780306406157" }, { fetch, gapMs: 0, sleep: noSleep });
  assert.equal(ok.error, false);
  assert.equal(ok.items.length, 4);
  assert.match(seen[0].url, /^https:\/\/query\.wikidata\.org\/sparql\?format=json&query=/);
  assert.ok(decodeURIComponent(seen[0].url).includes('"978-0-306-40615-7"'), "the hyphenated ISBN is in the request");
  assert.equal(seen[0].headers["user-agent"], "UmasBooks/1.0 (admin@umasbooks.org)");

  const none = await wikidata.lookupWikidataAwards({ isbn: null }, { fetch: async () => assert.fail("no ISBN, no request"), gapMs: 0 });
  assert.equal(none.skipped, true);
});

test("wikidata: a failure is an error (never 'no awards') after retrying with backoff", async () => {
  for (const make of [() => json({}, 500), () => json({}, 429), () => { throw new Error("down"); }]) {
    let calls = 0;
    const sleeps = [];
    const res = await wikidata.lookupWikidataAwards({ isbn: "9780306406157" }, {
      fetch: async () => { calls++; return make(); }, gapMs: 0, sleep: async (ms) => { sleeps.push(ms); },
    });
    assert.deepEqual([res.items, res.error], [[], true]);
    assert.equal(calls, 3, "one try plus two retries");
    assert.deepEqual(sleeps, [2000, 6000], "backs off between tries");
  }
});

test("wikidata: a client error (4xx other than 429) is not retried", async () => {
  let calls = 0;
  const res = await wikidata.lookupWikidataAwards({ isbn: "9780306406157" }, { fetch: async () => { calls++; return json({}, 400); }, gapMs: 0, sleep: noSleep });
  assert.equal(res.error, true);
  assert.equal(calls, 1);
});

test("wikidata: a retry that succeeds returns the awards", async () => {
  let calls = 0;
  const fetch = async (url) => (decodeURIComponent(String(url)).includes("wdt:P50") ? json({ results: { bindings: [] } }) : ++calls === 1 ? json({}, 504) : json(SPARQL));
  const res = await wikidata.lookupWikidataAwards({ isbn: "9780306406157" }, { fetch, gapMs: 0, sleep: noSleep });
  assert.equal(res.error, false);
  assert.equal(res.items.length, 4);
  assert.equal(calls, 2);
});

test("wikidata: a request that hangs is cut off by the timeout and recorded as an error", async () => {
  let calls = 0;
  const fetch = (url, init) => new Promise((resolve, reject) => {
    calls++;
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  const res = await wikidata.lookupWikidataAwards({ isbn: "9780306406157" }, { fetch, gapMs: 0, timeoutMs: 20, sleep: noSleep });
  assert.equal(res.error, true);
  assert.deepEqual(res.items, []);
  assert.equal(calls, 3);
  assert.ok(wikidata.TIMEOUT_MS >= 20000, "the default timeout is patient enough for the live API");
});

test("wikidata: an implausibly large result is discarded, logged, and not an error", async () => {
  const flood = { results: { bindings: Array.from({ length: wikidata.MAX_PLAUSIBLE + 1 }, (_, i) => b(`Unrelated Award ${i}`, 2000 + (i % 20), "award")) } };
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.join(" "));
  let res;
  try {
    res = await wikidata.lookupWikidataAwards({ isbn: "9780306406157" }, { fetch: async () => json(flood), gapMs: 0, sleep: noSleep });
  } finally {
    console.warn = orig;
  }
  assert.deepEqual([res.items, res.error, res.suspicious], [[], false, true]);
  assert.ok(warnings.some((w) => /implausible/.test(w)));
  // Exactly at the limit is still accepted (capped to 15 per book).
  const okSet = { results: { bindings: Array.from({ length: wikidata.MAX_PLAUSIBLE }, (_, i) => b(`Award ${i}`, 2000, "award")) } };
  const ok = await wikidata.lookupWikidataAwards({ isbn: "9780306406157" }, { fetch: routed({ awards: okSet }), gapMs: 0, sleep: noSleep });
  assert.equal(ok.suspicious, undefined);
  assert.equal(ok.items.length, 15);
});

test("wikidata: keeps a gap between two requests", async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const fetch = routed();
  await wikidata.lookupWikidataAwards({ isbn: "9780306406157" }, { fetch, gapMs: 1200, sleep });
  await wikidata.lookupWikidataAwards({ isbn: "9780306406157" }, { fetch, gapMs: 1200, sleep });
  assert.ok(sleeps.length >= 1 && sleeps[sleeps.length - 1] > 0 && sleeps[sleeps.length - 1] <= 1200);
});

// --------------------------------------------------------------------- NYT

const NYT = {
  status: "OK",
  results: [{
    title: "X",
    ranks_history: [
      { list_name: "Hardcover Fiction", published_date: "2019-03-10", rank: 1 },
      { list_name: "Hardcover Fiction", published_date: "2019-03-17", rank: 2 }, // same list+year: one row
      { list_name: "Hardcover Fiction", published_date: "2020-01-05", rank: 9 },
      { list_name: "Paperback Trade Fiction", published_date: "2021-06-06", rank: 4 },
      { published_date: "2021-06-06" }, // no list name: skipped
    ],
  }],
};

beforeEach(() => { nyt.resetGate(); });

test("nyt: maps ranks_history to one row per list and year", () => {
  assert.deepEqual(nyt.mapHistory(NYT).map((i) => [i.label, i.year, i.kind]), [
    ["New York Times Best Seller (Hardcover Fiction)", 2019, "bestseller"],
    ["New York Times Best Seller (Hardcover Fiction)", 2020, "bestseller"],
    ["New York Times Best Seller (Paperback Trade Fiction)", 2021, "bestseller"],
  ]);
  assert.deepEqual(nyt.mapHistory({}), []);
});

test("nyt: does nothing without a key; asks for the ISBN-13 with the key", async () => {
  const none = await nyt.lookupNytAwards({ isbn: "9780306406157" }, { apiKey: "", fetch: async () => assert.fail("no key, no request") });
  assert.equal(none.skipped, true);
  let url;
  const res = await nyt.lookupNytAwards({ isbn: "0306406152" }, { apiKey: "k-123", fetch: async (u) => { url = String(u); return json(NYT); } });
  assert.equal(res.items.length, 3);
  assert.match(url, /^https:\/\/api\.nytimes\.com\/svc\/books\/v3\/lists\/best-sellers\/history\.json\?isbn=9780306406157&api-key=k-123$/);
});

test("nyt: rate gate allows 5 per minute, then recovers", async () => {
  const t0 = Date.UTC(2026, 0, 1, 12, 0, 0);
  for (let i = 0; i < 5; i++) assert.equal(nyt.tryAcquire(t0 + i * 1000), true);
  assert.equal(nyt.tryAcquire(t0 + 6000), false);
  assert.equal(nyt.tryAcquire(t0 + 61 * 1000), true);
  // through the lookup: a refused call is an error (retried later), not a crash
  nyt.resetGate();
  let calls = 0;
  const fetch = async () => { calls++; return json(NYT); };
  const results = [];
  for (let i = 0; i < 7; i++) results.push(await nyt.lookupNytAwards({ isbn: "9780306406157" }, { apiKey: "k", fetch, now: t0 }));
  assert.equal(calls, 5);
  assert.deepEqual(results.map((r) => r.error), [false, false, false, false, false, true, true]);
});

test("nyt: the API key never reaches the logs, even when the call fails", async () => {
  const logged = [];
  const orig = [console.warn, console.error, console.log];
  console.warn = console.error = console.log = (...a) => logged.push(a.join(" "));
  try {
    await nyt.lookupNytAwards({ isbn: "9780306406157" }, { apiKey: "SECRET-KEY-999", fetch: async () => json({}, 429) });
    nyt.resetGate();
    await nyt.lookupNytAwards({ isbn: "9780306406157" }, { apiKey: "SECRET-KEY-999", fetch: async (u) => { throw new Error(`connect failed for ${u}`); } });
  } finally {
    [console.warn, console.error, console.log] = orig;
  }
  assert.ok(logged.length >= 2, "failures were logged");
  assert.ok(!logged.join("\n").includes("SECRET-KEY-999"));
});

// The AI web-search source is gone: its module no longer exists.
test("there is no AI awards module any more", () => {
  assert.throws(() => require("../../src/lib/awards/ai"), /Cannot find module/);
});

// ------------------------------------------------------------ typed-in text

test("manual: splits on commas, parses (year), trims and dedupes", () => {
  assert.deepEqual(parseManualAwards(" Booker Prize (2019) , Hugo Award for Best Novel,, booker prize (2019), Sunday Times Bestseller (x), NYT Best Seller (1999)"), [
    { label: "Booker Prize", year: 2019, kind: "award" },
    { label: "Hugo Award for Best Novel", year: null, kind: "award" },
    { label: "Sunday Times Bestseller (x)", year: null, kind: "bestseller" },
    { label: "NYT Best Seller", year: 1999, kind: "bestseller" },
  ]);
  assert.equal(parseManualAwards("x".repeat(300))[0].label.length, 200);
  assert.deepEqual(parseManualAwards(""), []);
  assert.deepEqual(parseManualAwards(undefined), []);
});
