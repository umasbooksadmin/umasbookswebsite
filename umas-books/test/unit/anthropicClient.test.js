// lib/anthropic.js on its own: the request it builds, typed failures, the optional pieces (system, tools, signal), and
// that the model/price table is the single source the usage report reads. Equivalence with the old per-feature clients
// is in aiClientEquivalence.test.js.
const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const anthropic = require("../../src/lib/anthropic");
const { setAiLimits } = require("../../src/lib/aiLimits");
const { setStats, createAiUsageStats, AI_PRICES } = require("../../src/lib/aiUsageStats");

const env = { ANTHROPIC_API_KEY: "k" };
const msgs = [{ role: "user", content: "hi" }];
const okRes = () => new Response(JSON.stringify({ content: [{ type: "text", text: " hello " }], usage: { input_tokens: 3, output_tokens: 2 } }), { status: 200 });
function fakes() {
  const stats = createAiUsageStats({ now: () => 0 });
  setStats(stats);
  const caps = [];
  setAiLimits({ acquireAiCall: async () => { caps.push(1); return { ok: true }; } });
  return { stats, caps };
}
afterEach(() => { setStats(null); setAiLimits(null); });

test("one request: url, headers, body (system and tools only when given), result with status and ms", async () => {
  const { stats, caps } = fakes();
  const seen = [];
  const r = await anthropic.request({ feature: "genre", model: "m1", messages: msgs, maxTokens: 9, timeoutMs: 1000, env, fetchImpl: async (u, i) => { seen.push([u, i]); return okRes(); } });
  assert.equal(r.ok, true);
  assert.equal(r.status, 200);
  assert.ok(r.ms >= 0);
  assert.equal(anthropic.textOf(r.data), " hello ");
  assert.equal(seen[0][0], "https://api.anthropic.com/v1/messages");
  assert.deepEqual(seen[0][1].headers, { "content-type": "application/json", "x-api-key": "k", "anthropic-version": "2023-06-01" });
  assert.deepEqual(JSON.parse(seen[0][1].body), { model: "m1", max_tokens: 9, messages: msgs });
  assert.equal(caps.length, 1);
  assert.equal(stats.snapshot()[0].input_tokens, 3);
  await anthropic.request({ feature: "genre", model: "m1", system: "be brief", tools: [{ name: "t" }], messages: msgs, maxTokens: 9, timeoutMs: 1000, env, claim: false, fetchImpl: async (u, i) => { seen.push([u, i]); return okRes(); } });
  assert.deepEqual(JSON.parse(seen[1][1].body), { model: "m1", max_tokens: 9, tools: [{ name: "t" }], system: "be brief", messages: msgs });
  assert.equal(caps.length, 1, "claim: false takes no slot");
});

test("typed failures", async () => {
  fakes();
  const kinds = {};
  const go = async (name, fetchImpl, e = env) => { kinds[name] = (await anthropic.request({ feature: "genre", model: "m", messages: msgs, maxTokens: 1, timeoutMs: 1000, env: e, fetchImpl })).kind; };
  await go("no-key", async () => okRes(), {});
  await go("credit", async () => new Response("Your credit balance is too low", { status: 400 }));
  await go("rate", async () => new Response("", { status: 429 }));
  await go("http", async () => new Response("", { status: 503 }));
  await go("network", async () => { throw new TypeError("fetch failed"); });
  await go("invalid", async () => new Response("<html>", { status: 200 }));
  await go("timeout", async () => { throw Object.assign(new Error("x"), { name: "AbortError" }); });
  assert.deepEqual(kinds, { "no-key": "no-key", credit: "no-credit", rate: "rate-limit", http: "http", network: "network", invalid: "invalid", timeout: "timeout" });
  for (const k of Object.values(kinds)) assert.ok(anthropic.FAILURE_KINDS.includes(k));
});

test("cap reached: nothing is sent; the caller's signal aborts the call", async () => {
  fakes();
  setAiLimits({ acquireAiCall: async () => ({ ok: false, message: "Daily AI limit reached (1)." }) });
  let sent = 0;
  const capped = await anthropic.request({ feature: "genre", model: "m", messages: msgs, maxTokens: 1, timeoutMs: 1000, env, fetchImpl: async () => { sent += 1; return okRes(); } });
  assert.deepEqual([capped.ok, capped.kind, capped.message, sent], [false, "cap", "Daily AI limit reached (1).", 0]);
  setAiLimits({ acquireAiCall: async () => ({ ok: true }) });
  const ac = new AbortController();
  const p = anthropic.request({ feature: "genre", model: "m", messages: msgs, maxTokens: 1, timeoutMs: 5000, signal: ac.signal, env, fetchImpl: (u, i) => new Promise((_, rej) => { const fail = () => rej(Object.assign(new Error("a"), { name: "AbortError" })); if (i.signal.aborted) fail(); else i.signal.addEventListener("abort", fail); }) });
  ac.abort();
  assert.equal((await p).kind, "timeout");
});

test("the model table is the one source of ids and prices (usage report reads it)", () => {
  const ids = Object.values(anthropic.MODELS).map((m) => m.id);
  assert.ok(ids.length >= 3);
  for (const m of Object.values(anthropic.MODELS)) assert.deepEqual(AI_PRICES.usdPerMTok[m.id], m.usdPerMTok);
  assert.equal(AI_PRICES.assumedModel, anthropic.MODELS.text.id);
});

test("no AI module carries its own client or model string any more", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const lib = path.join(__dirname, "../../src");
  const hits = [];
  (function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".js") && !/anthropic(Models)?\.js$/.test(e.name)) {
        const s = fs.readFileSync(p, "utf8");
        if (/api\.anthropic\.com|claude-(haiku|sonnet|opus)-\d/.test(s.replace(/\/\/.*$/gm, ""))) hits.push(path.relative(lib, p));
      }
    }
  })(lib);
  assert.deepEqual(hits, [], "only lib/anthropic.js and lib/anthropicModels.js know the URL and the model ids");
  assert.ok(!/bookDescription/.test(fs.readFileSync(path.join(lib, "lib/collectionSuggestions.js"), "utf8").replace(/\/\/.*$/gm, "")), "collection code does not import a domain module for the AI call");
});
