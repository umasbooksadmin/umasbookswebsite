// The AI market check (src/lib/pricing/market.js) without any network or
// database: the answer parser, the on/off switches and the request that is
// built. The cache and the daily cap are tested against a real database in
// test/integration/pricingAdmin.test.js.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseMarketResponse, aiEnabled, dailyMax, toIsbn13, fetchMarketData, buildPrompt, DEFAULT_DAILY_MAX, TIMEOUT_MS } = require("../../src/lib/pricing/market");
const { DEFAULT_SETTINGS } = require("../../src/lib/pricing/rules");

const S = DEFAULT_SETTINGS; // 1 USD = 0.92 EUR, 1 GBP = 1.15 EUR
const answer = (o) => JSON.stringify(o);
const comp = (over = {}) => ({ site: "AbeBooks", url: "https://www.abebooks.fr/book/1", price: { amount: 7.2, currency: "EUR" }, condition: "Very Good", note: "", ...over });

test("parser: a valid answer", () => {
  const r = parseMarketResponse(answer({ originalPrice: { amount: 12.5, currency: "EUR" }, comparables: [comp(), comp({ site: "eBay", url: "https://www.ebay.fr/itm/2", price: { amount: 8, currency: "EUR" }, condition: "Good", note: "ok" })] }), S);
  assert.equal(r.originalPrice, 12.5);
  assert.deepEqual(r.comparables.map((c) => [c.site, c.price, c.condition]), [["AbeBooks", 7.2, "Very Good"], ["eBay", 8, "Good"]]);
  assert.equal(r.comparables[1].note, "ok");
});

test("parser: fenced answers and chatter around the JSON are tolerated", () => {
  const body = answer({ originalPrice: null, comparables: [comp()] });
  for (const text of ["```json\n" + body + "\n```", "```\n" + body + "\n```", "Here is what I found:\n" + body + "\nHope that helps."]) {
    const r = parseMarketResponse(text, S);
    assert.equal(r.comparables.length, 1);
    assert.equal(r.originalPrice, null);
  }
});

test("parser: garbage and wrong shapes give null (or nothing usable)", () => {
  for (const text of ["", "no json here", "{not json}", "[1,2,3]", "null", '"text"', undefined]) {
    assert.equal(parseMarketResponse(text, S), null, JSON.stringify(text));
  }
  assert.deepEqual(parseMarketResponse("{}", S), { originalPrice: null, comparables: [] });
  assert.deepEqual(parseMarketResponse(answer({ comparables: "many", originalPrice: 5 }), S), { originalPrice: null, comparables: [] });
});

test("parser: USD and GBP are converted to EUR with the settings; EUR is as is", () => {
  const r = parseMarketResponse(answer({
    originalPrice: { amount: 10, currency: "USD" },
    comparables: [
      comp({ url: "https://a.example/1", price: { amount: 10, currency: "USD" } }),
      comp({ url: "https://a.example/2", price: { amount: 10, currency: "GBP" } }),
      comp({ url: "https://a.example/3", price: { amount: 10, currency: "eur" } }),
    ],
  }), S);
  assert.equal(r.originalPrice, 9.2);
  assert.deepEqual(r.comparables.map((c) => c.price), [9.2, 11.5, 10]);
  const custom = parseMarketResponse(answer({ comparables: [comp({ price: { amount: 10, currency: "USD" } })] }), { ...S, usdEur: 0.5 });
  assert.equal(custom.comparables[0].price, 5);
});

test("parser: only https URLs; other schemes, junk and missing URLs are dropped; duplicates once", () => {
  const urls = ["http://www.abebooks.fr/x", "ftp://x.example/a", "javascript:alert(1)", "//x.example/a", "not a url", "", null, "https://nodot/x"];
  const r = parseMarketResponse(answer({ comparables: [...urls.map((u) => comp({ url: u })), comp({ url: "https://ok.example/a" }), comp({ url: "https://ok.example/a" })] }), S);
  assert.deepEqual(r.comparables.map((c) => c.url), ["https://ok.example/a"]);
});

test("parser: absurd values (under EUR 0.50, over EUR 500), unknown currencies and non-numbers are dropped", () => {
  const r = parseMarketResponse(answer({
    originalPrice: { amount: 9999, currency: "EUR" },
    comparables: [
      comp({ url: "https://a.example/1", price: { amount: 0.49, currency: "EUR" } }),
      comp({ url: "https://a.example/2", price: { amount: 0.5, currency: "EUR" } }),
      comp({ url: "https://a.example/3", price: { amount: 500, currency: "EUR" } }),
      comp({ url: "https://a.example/4", price: { amount: 501, currency: "EUR" } }),
      comp({ url: "https://a.example/5", price: { amount: 7, currency: "JPY" } }),
      comp({ url: "https://a.example/6", price: { amount: "seven", currency: "EUR" } }),
      comp({ url: "https://a.example/7", price: null }),
      comp({ url: "https://a.example/8", price: { amount: 600, currency: "USD" } }), // 552 EUR
      comp({ url: "https://a.example/9", price: { amount: -4, currency: "EUR" } }),
    ],
  }), S);
  assert.equal(r.originalPrice, null);
  assert.deepEqual(r.comparables.map((c) => c.price), [0.5, 500]);
});

test("parser: text is cleaned and capped, and at most 12 comparables are kept", () => {
  const r = parseMarketResponse(answer({ comparables: [comp({ site: "A\u0000B".repeat(40), condition: "x".repeat(100), note: "n".repeat(500) })] }), S);
  const c = r.comparables[0];
  assert.ok(c.site.length <= 40 && !c.site.includes("\u0000"));
  assert.ok(c.condition.length <= 40);
  assert.ok(c.note.length <= 200);
  const many = parseMarketResponse(answer({ comparables: Array.from({ length: 30 }, (_, i) => comp({ url: `https://a.example/${i}` })) }), S);
  assert.equal(many.comparables.length, 12);
  assert.equal(parseMarketResponse(answer({ comparables: [comp({ site: "" })] }), S).comparables.length, 0);
});

test("switches: PRICING_AI must be '1' or 'true' AND a key must exist; the daily cap defaults to 150", () => {
  const key = { ANTHROPIC_API_KEY: "k" };
  assert.equal(aiEnabled({ ...key }), false);
  assert.equal(aiEnabled({ ...key, PRICING_AI: "" }), false);
  assert.equal(aiEnabled({ ...key, PRICING_AI: "0" }), false);
  assert.equal(aiEnabled({ ...key, PRICING_AI: "yes" }), false);
  assert.equal(aiEnabled({ PRICING_AI: "1" }), false, "no key");
  assert.equal(aiEnabled({ ...key, PRICING_AI: "1" }), true);
  assert.equal(aiEnabled({ ...key, PRICING_AI: "TRUE" }), true);
  assert.equal(dailyMax({}), 150);
  assert.equal(DEFAULT_DAILY_MAX, 150);
  assert.equal(dailyMax({ PRICING_AI_DAILY_MAX: "7" }), 7);
  assert.equal(dailyMax({ PRICING_AI_DAILY_MAX: "0" }), 0);
  assert.equal(dailyMax({ PRICING_AI_DAILY_MAX: "lots" }), 150);
  assert.equal(TIMEOUT_MS, 12000);
});

test("ISBN-10 becomes ISBN-13; junk is null", () => {
  assert.equal(toIsbn13("0-14-044913-6"), "9780140449136");
  assert.equal(toIsbn13("9780140449136"), "9780140449136");
  assert.equal(toIsbn13("080442957X"), "9780804429573");
  for (const bad of ["", null, "123", "abcdefghijklm", "97801404491366"]) assert.equal(toIsbn13(bad), null);
});

const reply = (text, status = 200) => async () => new Response(JSON.stringify({ content: [{ type: "text", text }] }), { status, headers: { "content-type": "application/json" } });
const ENV = { ANTHROPIC_API_KEY: "test-key", PRICING_AI: "1" };

test("request: same headers as the description call, the web search tool, only ISBN/title/author/binding in the prompt", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push({ url, init }); return reply(answer({ originalPrice: null, comparables: [comp()] }))(); };
  const out = await fetchMarketData({ isbn: "0140449136", title: "The Odyssey", author: "Homer", binding: "trade" }, { fetchImpl, env: { ...ENV, ANTHROPIC_WORKSPACE_ID: "ws_1", PRICING_AI_MODEL: "model-x" } });
  assert.equal(out.comparables.length, 1);
  const { url, init } = seen[0];
  assert.equal(url, "https://api.anthropic.com/v1/messages");
  assert.equal(init.method, "POST");
  assert.equal(init.headers["x-api-key"], "test-key");
  assert.equal(init.headers["anthropic-version"], "2023-06-01");
  assert.equal(init.headers["anthropic-workspace-id"], "ws_1");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "model-x");
  assert.deepEqual(body.tools, [{ type: "web_search_20250305", name: "web_search", max_uses: 4 }]);
  const prompt = body.messages[0].content;
  assert.ok(prompt.includes("9780140449136") && prompt.includes("The Odyssey") && prompt.includes("Homer") && prompt.includes("trade paperback"));
  assert.match(prompt, /real URL/);
  assert.match(prompt, /THIS exact edition/);
  const noWs = await fetchMarketData({ isbn: "9780140449136" }, { fetchImpl, env: { ANTHROPIC_API_KEY: "k" } });
  assert.ok(noWs);
  assert.equal("anthropic-workspace-id" in seen[1].init.headers, false);
  assert.equal(JSON.parse(seen[1].init.body).model, require("../../src/lib/anthropic").MODELS.priceLookup.id, "default model is the price-lookup model");
});

test("request: fails open: API errors, rejected tool, bad JSON, no ISBN, no key, thrown errors and timeouts all give null", async () => {
  const q = { isbn: "9780140449136", title: "T" };
  assert.equal(await fetchMarketData(q, { fetchImpl: reply("", 400), env: ENV }), null);
  assert.equal(await fetchMarketData(q, { fetchImpl: reply("", 529), env: ENV }), null);
  assert.equal(await fetchMarketData(q, { fetchImpl: reply("I could not find anything."), env: ENV }), null);
  assert.equal(await fetchMarketData(q, { fetchImpl: async () => { throw new Error("socket hang up"); }, env: ENV }), null);
  assert.equal(await fetchMarketData({ title: "T" }, { fetchImpl: reply("{}"), env: ENV }), null);
  assert.equal(await fetchMarketData(q, { fetchImpl: reply("{}"), env: {} }), null);
  const hang = (url, init) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
  assert.equal(await fetchMarketData(q, { fetchImpl: hang, env: ENV, timeoutMs: 20 }), null);
});

test("request: the JSON answer is found among web-search narration blocks", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ content: [
    { type: "text", text: "Let me search for that edition." },
    { type: "server_tool_use", name: "web_search" },
    { type: "web_search_tool_result", content: [] },
    { type: "text", text: "```json\n" + answer({ originalPrice: null, comparables: [comp()] }) + "\n```" },
  ] }), { status: 200 });
  const out = await fetchMarketData({ isbn: "9780140449136" }, { fetchImpl, env: ENV });
  assert.equal(out.comparables.length, 1);
  assert.match(buildPrompt({ isbn13: "9780140449136", title: "x" }), /ONLY JSON/);
});
