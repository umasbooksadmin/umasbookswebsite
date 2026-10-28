"use strict";
// Equivalence harness for the Anthropic client refactor. runMatrix(root) runs every AI feature of the code under
// `root` (a checkout of umas-books/) against a recording fake fetch, a fake daily cap and a real usage recorder over a
// matrix of simulated answers, and returns plain JSON: for each feature x scenario the exact outgoing requests (url,
// method, headers with the key hidden, parsed JSON body), what the feature returned, the usage rows it counted, the
// credit-alert calls, the cap calls, the timer lengths it asked for and the warnings it logged.
//
// scripts/ai-golden.js runs it against origin/main (before the refactor) and stores the output as
// test/fixtures/ai-client-golden.json; test/unit/aiClientEquivalence.test.js runs it against the current code and
// compares deeply. No real network, no real key (a fixed fake key), no database.

const path = require("node:path");

const KEY = "sk-ant-test-key-not-real";
const CREDIT_BODY = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } });
const BILLING_BODY = JSON.stringify({ type: "error", error: { type: "billing_error", message: "Payment required" } });
const OVERLOADED_BODY = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
const USAGE = { input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 5, cache_creation_input_tokens: 7, server_tool_use: { web_search_requests: 2 } };

// What each feature gets back from a good answer.
const OK_TEXT = {
  description: "A quiet, funny story about a lighthouse keeper.",
  translation: "Une histoire calme et drole sur un gardien de phare.",
  genre: "Fantasy, Young Adult Fiction, Not A Genre",
  cover: 'Here it is: {"isbn": "9780140449136", "title": "The Odyssey", "author": "Homer"}',
  price: '{"originalPrice": {"amount": 12.5, "currency": "EUR"}, "comparables": [{"site": "AbeBooks", "url": "https://www.abebooks.fr/x", "price": {"amount": 7.2, "currency": "EUR"}, "condition": "Very Good", "note": "ok"}]}',
  collection: '[{"id": 1, "reason": "Quiet and kind."}]',
  collectionTitle: '"Le Coin Lecture"',
};

const okBody = (text, usage = USAGE) => JSON.stringify({ id: "msg_1", type: "message", role: "assistant", model: "x", content: [{ type: "text", text }], stop_reason: "end_turn", usage });

// scenario name -> (feature key) -> { response: () => Response | throws, shrink? }
const SCENARIOS = {
  "200 ok": (f) => ({ res: () => new Response(okBody(OK_TEXT[f]), { status: 200 }) }),
  "200 ok without usage": (f) => ({ res: () => new Response(JSON.stringify({ content: [{ type: "text", text: OK_TEXT[f] }] }), { status: 200 }) }),
  "200 empty content (refusal shape)": () => ({ res: () => new Response(JSON.stringify({ content: [], stop_reason: "refusal", usage: USAGE }), { status: 200 }) }),
  "200 block without text": () => ({ res: () => new Response(JSON.stringify({ content: [{ type: "tool_use", id: "t" }], usage: USAGE }), { status: 200 }) }),
  "200 text is not a string": () => ({ res: () => new Response(JSON.stringify({ content: [{ type: "text", text: 42 }], usage: USAGE }), { status: 200 }) }),
  "200 body is not JSON": () => ({ res: () => new Response("<html>gateway</html>", { status: 200 }) }),
  "200 oversize body": (f) => ({ res: () => new Response(okBody(`${OK_TEXT[f]} ${"x".repeat(3 * 1024 * 1024)}`), { status: 200 }) }),
  "400 credit balance too low": () => ({ res: () => new Response(CREDIT_BODY, { status: 400 }) }),
  "402 billing error": () => ({ res: () => new Response(BILLING_BODY, { status: 402 }) }),
  "400 other bad request": () => ({ res: () => new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens too large" } }), { status: 400 }) }),
  "401 bad key": () => ({ res: () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } }), { status: 401 }) }),
  "429 with billing_error body": () => ({ res: () => new Response(BILLING_BODY, { status: 429 }) }),
  "429 rate limit": () => ({ res: () => new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }), { status: 429 }) }),
  "500 server error": () => ({ res: () => new Response("boom", { status: 500 }) }),
  "529 overloaded": () => ({ res: () => new Response(OVERLOADED_BODY, { status: 529 }) }),
  "network error": () => ({ res: () => { throw new TypeError("fetch failed"); } }),
  "timeout (no answer)": () => ({ shrink: true, res: (init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" })))) }),
  "answer cut off by the timeout while reading": () => ({ shrink: true, res: (init) => ({ ok: true, status: 200, json: () => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))) }) }),
};
// Environment variants (cap, no key, workspace header) are scenarios of their own with the plain good answer.
const SETUPS = {
  "no API key": { key: false, res: "200 ok" },
  "daily cap reached": { cap: true, res: "200 ok" },
  "workspace header set": { workspace: "wrkspc_123", res: "200 ok" },
};

const FIXED_NOW = Date.parse("2026-10-20T10:00:00Z");

async function runMatrix(root) {
  const lib = (name) => require(path.join(root, "src/lib", name));
  const limitsMod = lib("aiLimits");
  const statsMod = lib("aiUsageStats");
  const description = lib("bookDescription");
  const { generateBookGenres } = lib("bookGenre");
  const { extractBookInfoFromPhoto } = lib("coverVision");
  const market = lib("pricing/market");
  const { translateEmptyFrench } = lib("collectionTranslate");
  // Before the refactor the shared text client was claudeRequest in bookDescription; after, askText in anthropic.js.
  const ask = description.claudeRequest || lib("anthropic").askText;
  const { isValidIsbn } = lib("bookLookup");
  void isValidIsbn;

  const photo = Buffer.from("fake-image-bytes");
  const query = { isbn: "9780140449136", title: "The Odyssey", author: "Homer", binding: "trade" };

  // feature id -> async (fetchOverride) -> value
  const FEATURES = {
    description: { text: "description", run: () => description.generateBookDescription({ title: "The Lighthouse", author: "A. Writer", publisher: "Pub", publishedYear: 1999 }) },
    genre: { text: "genre", run: () => generateBookGenres({ title: "The Hobbit", author: "Tolkien", description: "A hobbit goes out.", existingGenres: "Fiction" }) },
    cover: { text: "cover", run: () => extractBookInfoFromPhoto(photo, "image/jpeg") },
    price: { text: "price", run: () => market.fetchMarketData(query, { env: { ANTHROPIC_API_KEY: KEY, ...(process.env.ANTHROPIC_WORKSPACE_ID ? { ANTHROPIC_WORKSPACE_ID: process.env.ANTHROPIC_WORKSPACE_ID } : {}) }, fetchImpl: (u, i) => globalThis.fetch(u, i) }) },
    "price (override model)": { text: "price", run: () => market.fetchMarketData(query, { env: { ANTHROPIC_API_KEY: KEY, PRICING_AI_MODEL: "model-x" }, fetchImpl: (u, i) => globalThis.fetch(u, i) }) },
    "price lookup (caps, cache row)": { text: "price", run: async () => {
      const rows = [];
      const pool = { query: async (sql, params) => { if (/^SELECT/.test(sql)) return { rows: [] }; rows.push({ state: params[2], data: params[1] }); return { rows: [] }; } };
      const out = await market.lookupMarket(pool, { ...query, isbn: "9780140449136" }, { env: { PRICING_AI: "1", ANTHROPIC_API_KEY: KEY, PRICING_AI_DAILY_MAX: "5" }, fetchImpl: (u, i) => globalThis.fetch(u, i), now: FIXED_NOW });
      return { out: out && { ...out, fetchedAt: "<date>" }, saved: rows };
    } },
    "collection suggestions (ask)": { text: "collection", run: () => ask("Pick books.", { maxTokens: 1800, timeoutMs: 45000, label: "AI collection suggestions", feature: "description" }) },
    "collection translate to French": { text: "collectionTitle", run: () => translateEmptyFrench({ title_en: "Cosy corner", description_en: "", title_fr: "", description_fr: "kept" }) },
    "collection translate blurb": { text: "collectionTitle", run: () => translateEmptyFrench({ title_en: "", description_en: "A shelf of warm books.", title_fr: "kept", description_fr: "" }) },
  };

  const realFetch = globalThis.fetch;
  const realWarn = console.warn;
  const realSetTimeout = globalThis.setTimeout;
  const saved = { key: process.env.ANTHROPIC_API_KEY, ws: process.env.ANTHROPIC_WORKSPACE_ID, dm: process.env.AI_DAILY_MAX_CALLS };
  const out = {};

  async function one(featureName, feature, setupName, scenario, setup) {
    const requests = [];
    const timers = [];
    const warns = [];
    const capCalls = [];
    const alerts = [];
    if (setup.key === false) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = KEY;
    if (setup.workspace) process.env.ANTHROPIC_WORKSPACE_ID = setup.workspace; else delete process.env.ANTHROPIC_WORKSPACE_ID;
    limitsMod.setAiLimits({
      acquireAiCall: async () => { capCalls.push("acquireAiCall"); return setup.cap ? { ok: false, max: 600, message: "Daily AI limit reached (600). Resets at midnight Paris time." } : { ok: true }; },
      acquirePriceCall: async () => { capCalls.push("acquirePriceCall"); return setup.cap ? { ok: false, scope: "all", max: 600, message: "Daily AI limit reached (600). Resets at midnight Paris time." } : { ok: true }; },
    });
    const stats = statsMod.createAiUsageStats({ now: () => FIXED_NOW, alert: { creditOutOf: () => alerts.push("creditOutOf"), creditWorking: () => alerts.push("creditWorking") } });
    statsMod.setStats(stats);
    globalThis.fetch = async (url, init = {}) => {
      const headers = { ...init.headers };
      if (headers["x-api-key"]) headers["x-api-key"] = headers["x-api-key"] === KEY ? "<the key>" : "<WRONG KEY>";
      requests.push({ url: String(url), method: init.method, headers, hasSignal: Boolean(init.signal), body: JSON.parse(init.body) });
      return scenario.res(init);
    };
    console.warn = (...args) => warns.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
    globalThis.setTimeout = (fn, ms, ...rest) => {
      if (ms >= 1000) timers.push(ms);
      return realSetTimeout(fn, scenario.shrink && ms >= 1000 ? 25 : ms, ...rest);
    };
    let value;
    let threw = null;
    try { value = await feature.run(); } catch (err) { threw = String(err && err.message); }
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    globalThis.setTimeout = realSetTimeout;
    const usage = stats.snapshot().map((r) => { const { duration_ms_sum, ...rest } = r; return { ...rest, duration_ms_sum_is_number: typeof duration_ms_sum === "number" }; });
    // A very long string (the oversize answer) is kept as its length and a hash: equal text, small fixture.
    const shrinkLong = (_k, v) => (typeof v === "string" && v.length > 5000 ? `<${v.length} chars, sha1 ${require("node:crypto").createHash("sha1").update(v).digest("hex")}>` : v);
    out[`${featureName} | ${setupName}`] = JSON.parse(JSON.stringify({ requests, value: value === undefined ? "<undefined>" : value, threw, usage, alerts, capCalls, timers, warns }, shrinkLong));
  }

  try {
    for (const [featureName, feature] of Object.entries(FEATURES)) {
      for (const [name, make] of Object.entries(SCENARIOS)) await one(featureName, feature, name, make(feature.text), {});
      for (const [name, setup] of Object.entries(SETUPS)) await one(featureName, feature, name, SCENARIOS[setup.res](feature.text), setup);
    }
  } finally {
    globalThis.fetch = realFetch;
    console.warn = realWarn;
    globalThis.setTimeout = realSetTimeout;
    statsMod.setStats(null);
    limitsMod.setAiLimits(null);
    for (const [k, v] of [["ANTHROPIC_API_KEY", saved.key], ["ANTHROPIC_WORKSPACE_ID", saved.ws], ["AI_DAILY_MAX_CALLS", saved.dm]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  return out;
}

module.exports = { runMatrix, SCENARIOS, SETUPS, KEY };
