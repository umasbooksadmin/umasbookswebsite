// The award lookups (src/lib/awards/*) with the network stubbed through the
// injectable `fetch`: Wikidata parser and query, NYT mapper / rate gate / key
// secrecy, the AI parser and its safeguards, and the typed-in awards parser.
// Nothing here touches the network or the database.

const { test, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

const wikidata = require("../../src/lib/awards/wikidata");
const nyt = require("../../src/lib/awards/nyt");
const ai = require("../../src/lib/awards/ai");
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

test("wikidata: the ISBN can never break out of the query", () => {
  assert.equal(wikidata.buildQuery(wikidata.cleanIsbns('9780000000002" } UNION { ?x ?y ?z #')), null);
  const evil = wikidata.cleanIsbns('978"; DROP\\ 0306406152');
  assert.ok(!evil.isbn13 || /^\d{13}$/.test(evil.isbn13));
  const q = wikidata.buildQuery({ isbn13: '9780306406157" } #', isbn10: "0306406152" });
  assert.ok(!q.includes("#"), "an invalid ISBN-13 is dropped");
  assert.ok(q.includes('wdt:P957 "0306406152"'));
  const both = wikidata.buildQuery(wikidata.cleanIsbns("0-306-40615-2"));
  assert.ok(both.includes('wdt:P212 "9780306406157"') && both.includes('wdt:P957 "0306406152"'));
  assert.ok(both.includes("P629") && both.includes("P166") && both.includes("P1411") && both.includes("P585"));
});

test("wikidata: sends the User-Agent, parses the answer, and fails open", async () => {
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), headers: init.headers });
    return json(SPARQL);
  };
  const ok = await wikidata.lookupWikidataAwards({ isbn: "9780306406157" }, { fetch, gapMs: 0 });
  assert.equal(ok.error, false);
  assert.equal(ok.items.length, 4);
  assert.match(seen[0].url, /^https:\/\/query\.wikidata\.org\/sparql\?format=json&query=/);
  assert.equal(seen[0].headers["user-agent"], "UmasBooks/1.0 (admin@umasbooks.org)");

  const bad = await wikidata.lookupWikidataAwards({ isbn: "9780306406157" }, { fetch: async () => json({}, 500), gapMs: 0 });
  assert.deepEqual([bad.items, bad.error], [[], true]);
  const boom = await wikidata.lookupWikidataAwards({ isbn: "9780306406157" }, { fetch: async () => { throw new Error("down"); }, gapMs: 0 });
  assert.equal(boom.error, true);
  const none = await wikidata.lookupWikidataAwards({ isbn: null }, { fetch: async () => assert.fail("no ISBN, no request"), gapMs: 0 });
  assert.equal(none.skipped, true);
});

test("wikidata: a request that hangs is cut off by the timeout", async () => {
  const fetch = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  const res = await wikidata.lookupWikidataAwards({ isbn: "9780306406157" }, { fetch, gapMs: 0, timeoutMs: 30 });
  assert.equal(res.error, true);
});

test("wikidata: keeps a gap between two requests", async () => {
  const sleeps = [];
  const sleep = async (ms) => { sleeps.push(ms); };
  const fetch = async () => json(SPARQL);
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

beforeEach(() => { nyt.resetGate(); ai.resetAiUsage(); });

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

// ---------------------------------------------------------------------- AI

const URL_A = "https://www.thebookerprizes.com/winner";
const good = (extra = {}) => JSON.stringify({ items: [{ label: "Booker Prize", year: 2019, kind: "award", source_url: URL_A, ...extra }] });

test("ai: parses valid JSON and fenced JSON", () => {
  assert.deepEqual(ai.parseAiItems(good()), [{ label: "Booker Prize", year: 2019, kind: "award", source_url: URL_A }]);
  assert.equal(ai.parseAiItems("```json\n" + good() + "\n```").length, 1);
  assert.equal(ai.parseAiItems("Here you go: " + good() + " Thanks.").length, 1);
});

test("ai: garbage, wrong shapes and empty lists give nothing", () => {
  for (const text of ["", "no json at all", "{not json}", "[1,2]", '{"items":"x"}', '{"items":[null,3,"a"]}', '{"items":[]}']) {
    assert.deepEqual(ai.parseAiItems(text), [], text);
  }
});

test("ai: rejects http URLs, non-URLs, unknown kinds, over-long labels, marketing", () => {
  assert.equal(ai.parseAiItems(good({ source_url: "http://example.com/x" })).length, 0);
  assert.equal(ai.parseAiItems(good({ source_url: "javascript:alert(1)" })).length, 0);
  assert.equal(ai.parseAiItems(good({ source_url: null })).length, 0);
  assert.equal(ai.parseAiItems(good({ kind: "review" })).length, 0);
  assert.equal(ai.parseAiItems(good({ label: "x".repeat(201) })).length, 0);
  assert.equal(ai.parseAiItems(good({ label: "" })).length, 0);
  assert.equal(ai.parseAiItems(good({ year: "nope" }))[0].year, null);
  const dup = JSON.stringify({ items: [JSON.parse(good()).items[0], JSON.parse(good({ label: "booker prize" })).items[0]] });
  assert.equal(ai.parseAiItems(dup).length, 1);
  assert.match(ai.buildPrompt({ title: "T", author: "A" }), /Do NOT include publisher marketing/);
});

test("ai: a URL that never appeared in the search results is dropped", () => {
  const seenUrls = new Set([URL_A]);
  assert.equal(ai.parseAiItems(good(), seenUrls).length, 1);
  assert.equal(ai.parseAiItems(good({ source_url: "https://invented.example/pulitzer" }), seenUrls).length, 0);
  assert.equal(ai.parseAiItems(good(), new Set()).length, 0);
});

const ENV_ON = { ANTHROPIC_API_KEY: "ant-key", AWARDS_AI: "1" };
const aiReply = (text, urls = [URL_A]) => json({
  content: [
    { type: "server_tool_use", name: "web_search", input: { query: "q" } },
    { type: "web_search_tool_result", content: urls.map((url) => ({ type: "web_search_result", url, title: "t" })) },
    { type: "text", text },
  ],
});

test("ai: calls the Messages API with the web search tool and keeps backed items", async () => {
  let sent;
  const fetch = async (url, init) => { sent = { url: String(url), headers: init.headers, body: JSON.parse(init.body) }; return aiReply(good()); };
  const res = await ai.lookupAiAwards({ title: "T", authors: "A", isbn: "9780306406157", published_year: 2019 }, { fetch, env: { ...ENV_ON, ANTHROPIC_WORKSPACE_ID: "ws_1", AWARDS_AI_MODEL: "model-x" } });
  assert.equal(res.items.length, 1);
  assert.equal(sent.url, "https://api.anthropic.com/v1/messages");
  assert.equal(sent.headers["x-api-key"], "ant-key");
  assert.equal(sent.headers["anthropic-workspace-id"], "ws_1");
  assert.equal(sent.body.model, "model-x");
  assert.deepEqual(sent.body.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }]);
});

test("ai: a tool/API error or an error body returns [] and flags an error, with one call only", async () => {
  let calls = 0;
  const res = await ai.lookupAiAwards({ title: "T", authors: "A" }, { fetch: async () => { calls++; return json({ error: { message: "tool not supported" } }, 400); }, env: ENV_ON });
  assert.deepEqual([res.items, res.error, calls], [[], true, 1]);
  const body = await ai.lookupAiAwards({ title: "T", authors: "A" }, { fetch: async () => json({ type: "error", error: {} }), env: ENV_ON });
  assert.equal(body.error, true);
});

test("ai: needs the key, the switch, a title and an author", async () => {
  const never = async () => assert.fail("must not call the API");
  for (const [book, env] of [
    [{ title: "T", authors: "A" }, { ANTHROPIC_API_KEY: "k" }],
    [{ title: "T", authors: "A" }, { AWARDS_AI: "1" }],
    [{ title: "T", authors: "A" }, { ANTHROPIC_API_KEY: "k", AWARDS_AI: "0" }],
    [{ title: "T", authors: "" }, ENV_ON],
    [{ title: "", authors: "A" }, ENV_ON],
  ]) {
    assert.equal((await ai.lookupAiAwards(book, { fetch: never, env })).skipped, true);
  }
  assert.equal(ai.aiEnabled({ ANTHROPIC_API_KEY: "k", AWARDS_AI: "true" }), true);
  assert.equal(ai.dailyMax({}), 100);
  assert.equal(ai.dailyMax({ AWARDS_AI_DAILY_MAX: "7" }), 7);
  assert.equal(ai.dailyMax({ AWARDS_AI_DAILY_MAX: "junk" }), 100);
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
