// The AI usage recorder (lib/aiUsageStats.js): aggregation, credit-error detection (fixture bodies), token summing,
// and the instrumentation of the four modules. Counts only; the database is a fake, fetch is injected.

const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const { createAiUsageStats, setStats, isCreditError, extractUsage, COUNTERS, AI_PRICES } = require("../../src/lib/aiUsageStats");
const { estimateUsd } = require("../../src/lib/aiUsageReport");

const CREDIT_BODY = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } });
const BILLING_BODY = JSON.stringify({ type: "error", error: { type: "billing_error", message: "Billing problem" } });
const OVERLOAD_BODY = JSON.stringify({ type: "error", error: { type: "overloaded_error", message: "Overloaded" } });
const OTHER_400 = JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "max_tokens: field required" } });

afterEach(() => setStats(null));

test("credit-error detection: body text and error type, only for 400/402 (billing_error at any status)", () => {
  assert.equal(isCreditError(400, CREDIT_BODY), true);
  assert.equal(isCreditError(402, CREDIT_BODY), true);
  assert.equal(isCreditError(402, "Payment required: Credit balance exhausted"), true, "raw text");
  assert.equal(isCreditError(400, BILLING_BODY), true);
  assert.equal(isCreditError(403, BILLING_BODY), true, "billing_error type is enough");
  assert.equal(isCreditError(400, OTHER_400), false);
  assert.equal(isCreditError(429, CREDIT_BODY), false, "a 429 stays a rate limit");
  assert.equal(isCreditError(529, OVERLOAD_BODY), false);
  assert.equal(isCreditError(400, ""), false);
  assert.equal(isCreditError(400, undefined), false);
});

test("token summing: input, output, cache tokens and web searches from the usage field", () => {
  assert.deepEqual(extractUsage({ usage: { input_tokens: 120, output_tokens: 45, cache_read_input_tokens: 10, cache_creation_input_tokens: 5, server_tool_use: { web_search_requests: 3 } } }),
    { input_tokens: 120, output_tokens: 45, cache_read_tokens: 10, cache_write_tokens: 5, web_searches: 3 });
  assert.deepEqual(extractUsage({ usage: { input_tokens: 7 } }), { input_tokens: 7, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, web_searches: 0 });
  for (const odd of [null, undefined, {}, { usage: null }, { usage: { input_tokens: "x", output_tokens: -4 } }, "text"]) {
    assert.deepEqual(extractUsage(odd), { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_write_tokens: 0, web_searches: 0 });
  }
});

test("aggregation: outcomes are exclusive and add up per day and feature", () => {
  const s = createAiUsageStats({ getPool: () => null, now: () => Date.parse("2026-10-09T10:00:00Z") });
  s.recordCall("description", { status: 200, data: { usage: { input_tokens: 100, output_tokens: 50 } }, ms: 200 });
  s.recordCall("description", { status: 200, data: { usage: { input_tokens: 80, output_tokens: 40 } }, ms: 400 });
  s.recordCall("description", { status: 429, bodyText: "{}", ms: 50 });
  s.recordCall("description", { status: 400, bodyText: CREDIT_BODY, ms: 60 });
  s.recordCall("description", { status: 500, bodyText: "", ms: 70 });
  s.recordCall("description", { failed: true, ms: 8000 });
  s.recordCall("price", { status: 200, data: { usage: { input_tokens: 3000, output_tokens: 300, server_tool_use: { web_search_requests: 2 } } }, ms: 9000 });
  const snap = Object.fromEntries(s.snapshot().map((r) => [r.feature, r]));
  const d = snap.description;
  assert.deepEqual([d.calls, d.ok, d.errors, d.limited, d.credit_errors], [6, 2, 2, 1, 1]);
  assert.equal(d.calls, d.ok + d.errors + d.limited + d.credit_errors);
  assert.equal(d.input_tokens, 180);
  assert.equal(d.output_tokens, 90);
  assert.equal(d.duration_ms_sum, 8780);
  assert.equal(d.duration_n, 6);
  assert.equal(d.day, "2026-10-09");
  assert.equal(d.last_credit_error_at, "2026-10-09T10:00:00.000Z");
  assert.equal(snap.price.web_searches, 2);
  assert.equal(snap.price.last_credit_error_at, null);
  assert.equal(s.pending(), 2);
});

test("an unknown feature or odd input is ignored and recordCall() never throws", () => {
  const s = createAiUsageStats({ getPool: () => null });
  s.recordCall("evil", { status: 200 });
  s.recordCall("genre", null);
  s.recordCall(undefined, undefined);
  s.recordCall("genre", { status: 200, data: { usage: { input_tokens: {} } }, ms: "x" });
  assert.equal(s.snapshot().length, 1);
  assert.equal(s.snapshot()[0].calls, 1);
});

const fakePool = () => {
  const calls = [];
  return { calls, fail: false, async query(sql, params) { calls.push({ sql, params }); if (this.fail) throw new Error("db down"); return { rows: [] }; } };
};

test("flush() upserts increments and keeps the counts when the database fails", async () => {
  const pool = fakePool();
  const logs = [];
  const s = createAiUsageStats({ getPool: () => pool, log: (m) => logs.push(m), now: () => Date.parse("2026-10-09T10:00:00Z") });
  s.recordCall("cover", { status: 200, data: { usage: { input_tokens: 1500, output_tokens: 60 } }, ms: 1000 });
  pool.fail = true;
  assert.deepEqual(await s.flush(), { rows: 0, failed: true });
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs[0], /sk-ant|api[_ -]?key/i);
  assert.equal(s.pending(), 1, "kept for the next try");
  s.recordCall("cover", { status: 200, data: { usage: { input_tokens: 500, output_tokens: 40 } }, ms: 500 });
  pool.fail = false;
  assert.deepEqual(await s.flush(), { rows: 1 });
  const { sql, params } = pool.calls[pool.calls.length - 1];
  assert.match(sql, /ON CONFLICT \(day, feature\) DO UPDATE/);
  assert.match(sql, /input_tokens = ai_usage_stats\.input_tokens \+ EXCLUDED\.input_tokens/);
  assert.equal(params[0][0], "2026-10-09");
  assert.equal(params[1][0], "cover");
  assert.equal(params[2 + COUNTERS.indexOf("input_tokens")][0], 2000);
  assert.equal(s.pending(), 0);
});

test("the estimate is tokens x the price constants, and nothing when the model has no price", () => {
  const t = { input_tokens: 2_000_000, output_tokens: 1_000_000 };
  const p = AI_PRICES.usdPerMTok[AI_PRICES.assumedModel];
  assert.equal(estimateUsd(t), 2 * p.input + 1 * p.output);
  assert.equal(estimateUsd(t, { ...AI_PRICES, assumedModel: "unknown-model" }), null);
  assert.match(AI_PRICES.updated, /^\d{4}-\d{2}-\d{2}$/);
});

// ---- the four modules call the recorder and their results do not change ----

const okBody = (text, usage = { input_tokens: 11, output_tokens: 7 }) => new Response(JSON.stringify({ content: [{ type: "text", text }], usage }), { status: 200, headers: { "content-type": "application/json" } });
const withFetch = async (impl, fn) => {
  const real = globalThis.fetch;
  const saved = process.env.ANTHROPIC_API_KEY;
  globalThis.fetch = impl;
  process.env.ANTHROPIC_API_KEY = "test-key";
  const quiet = console.warn;
  console.warn = () => {};
  try { return await fn(); } finally { globalThis.fetch = real; console.warn = quiet; if (saved === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = saved; }
};
const fresh = () => { const s = createAiUsageStats({ getPool: () => null }); setStats(s); return s; };
const by = (s) => Object.fromEntries(s.snapshot().map((r) => [r.feature, r]));

test("description, translation and genre: counted, results unchanged, the prompt is not stored", async () => {
  const { generateBookDescription, translateDescriptionToFrench } = require("../../src/lib/bookDescription");
  const { generateBookGenres } = require("../../src/lib/bookGenre");
  const s = fresh();
  await withFetch(async () => okBody("A fine book."), async () => {
    assert.equal(await generateBookDescription({ title: "Secret Title Alpha" }), "A fine book.");
    assert.equal(await translateDescriptionToFrench("Hello"), "A fine book.");
    assert.equal(await generateBookGenres({ title: "Secret Title Alpha" }), null, "no taxonomy genre in the answer: same result as before");
  });
  const r = by(s);
  for (const f of ["description", "translation", "genre"]) assert.deepEqual([r[f].calls, r[f].ok, r[f].input_tokens, r[f].output_tokens], [1, 1, 11, 7], f);
  assert.doesNotMatch(JSON.stringify(s.snapshot()), /Secret Title|A fine book/);
});

test("a credit-balance answer is counted as such, still returns null, and a 429 and a timeout are told apart", async () => {
  const { generateBookDescription } = require("../../src/lib/bookDescription");
  const s = fresh();
  const answers = [() => new Response(CREDIT_BODY, { status: 400 }), () => new Response("{}", { status: 429 }), () => { throw Object.assign(new Error("x"), { name: "AbortError" }); }, () => new Response("<html>", { status: 502 })];
  for (const a of answers) await withFetch(async () => a(), async () => assert.equal(await generateBookDescription({ title: "T" }), null));
  const d = by(s).description;
  assert.deepEqual([d.calls, d.credit_errors, d.limited, d.errors, d.ok], [4, 1, 1, 2, 0]);
  assert.ok(d.last_credit_error_at);
});

test("a 200 whose body is not JSON counts once, as a failure", async () => {
  const { generateBookDescription } = require("../../src/lib/bookDescription");
  const s = fresh();
  await withFetch(async () => new Response("not json", { status: 200 }), async () => assert.equal(await generateBookDescription({ title: "T" }), null));
  const d = by(s).description;
  assert.deepEqual([d.calls, d.ok, d.errors], [1, 0, 1]);
});

test("cover photo reading is counted and returns the same fields", async () => {
  const { extractBookInfoFromPhoto } = require("../../src/lib/coverVision");
  const s = fresh();
  await withFetch(async () => okBody('{"isbn": null, "title": "A", "author": "B"}', { input_tokens: 1600, output_tokens: 30 }), async () => {
    assert.deepEqual(await extractBookInfoFromPhoto(Buffer.from("x"), "image/jpeg"), { isbn: null, title: "A", author: "B" });
  });
  assert.deepEqual([by(s).cover.calls, by(s).cover.input_tokens], [1, 1600]);
});

test("price check: counted with web searches, injected fetch, result unchanged; credit error counted", async () => {
  const { fetchMarketData } = require("../../src/lib/pricing/market");
  const s = fresh();
  const answer = JSON.stringify({ originalPrice: { amount: 10, currency: "EUR" }, comparables: [] });
  const env = { ANTHROPIC_API_KEY: "test-key" };
  const q = { isbn: "9780143127550" };
  const ok = await fetchMarketData(q, { env, fetchImpl: async () => okBody(answer, { input_tokens: 4000, output_tokens: 200, server_tool_use: { web_search_requests: 3 } }) });
  assert.equal(ok.originalPrice, 10);
  const quiet = console.warn; console.warn = () => {};
  try {
    assert.equal(await fetchMarketData(q, { env, fetchImpl: async () => new Response(CREDIT_BODY, { status: 400 }) }), null);
    assert.equal(await fetchMarketData(q, { env, fetchImpl: async () => ({ ok: false, status: 500 }) }), null, "a fake response without text() still works");
  } finally { console.warn = quiet; }
  const p = by(s).price;
  assert.deepEqual([p.calls, p.ok, p.credit_errors, p.errors, p.web_searches, p.input_tokens], [3, 1, 1, 1, 3, 4000]);
});
