// "Update all collections" is one web request (Cloudflare closes at 100 s): it must stop STARTING collections early
// and cap each AI call so the total stays under about 85 s, reporting what was skipped. Fake clock, fake generator.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { updateAllCollections, UPDATE_ALL_START_MS, UPDATE_ALL_TOTAL_MS } = require("../../src/lib/collectionSuggestions");

const rows = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, title_en: `C${i + 1}`, last_generated_at: new Date(), curation_prompt: "x" }));
const fakePool = (list) => ({ query: async () => ({ rows: list }) });

function run(perCallMs, extra = {}) {
  let t = 0;
  const calls = [];
  const generate = async (_pool, id, opts) => {
    calls.push({ id, startedAt: t, timeoutMs: opts.timeoutMs });
    t += Math.min(perCallMs, opts.timeoutMs); // a call runs up to its own time limit
    return { ok: true, added: 1, considered: 1 };
  };
  return updateAllCollections(fakePool(rows), { now: () => t, generate, ...extra }).then((out) => ({ out, calls, end: () => t }));
}

test("defaults: no start after 40 s, 85 s total", () => {
  assert.equal(UPDATE_ALL_START_MS, 40000);
  assert.equal(UPDATE_ALL_TOTAL_MS, 85000);
});

test("slow collections: stops starting after 40 s, the rest are 'later', and the total stays under 90 s", async () => {
  const { out, calls, end } = await run(45000); // the first call runs to its limit, so nothing more is started
  assert.deepEqual(out.map((r) => r.status), ["added", "later", "later", "later", "later", "later"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].timeoutMs, 45000);
  assert.ok(end() <= 90000, `total ${end()} ms`);
});

test("each call is capped to what is left of the 85 s", async () => {
  const { out, calls, end } = await run(20000);
  assert.deepEqual(out.map((r) => r.status), ["added", "added", "added", "later", "later", "later"]);
  assert.deepEqual(calls.map((c) => c.startedAt), [0, 20000, 40000]);
  assert.deepEqual(calls.map((c) => c.timeoutMs), [45000, 45000, 45000]);
  const slow = await run(45000, { startMs: 100000 }); // start cutoff off: only the total budget limits the calls
  assert.deepEqual(slow.calls.map((c) => c.timeoutMs), [45000, 40000]);
  assert.ok(slow.end() <= 90000);
  assert.ok(end() <= 90000);
});

test("the last call started just before the cutoff still ends by the total", async () => {
  const { calls, end } = await run(39000);
  const last = calls[calls.length - 1];
  assert.ok(last.startedAt <= 40000);
  assert.ok(end() <= 85000, `total ${end()} ms`);
});

test("fast collections are all done; manual and never-built ones are not 'later'", async () => {
  const list = [rows[0], { ...rows[1], curation_prompt: "" }, { ...rows[2], last_generated_at: null }, rows[3]];
  const out = await updateAllCollections(fakePool(list), { now: () => 0, generate: async () => ({ ok: true, nothingNew: true }) });
  assert.deepEqual(out.map((r) => r.status), ["nothing", "manual", "never", "nothing"]);
});

test("a generator that throws is reported as failed and the run goes on", async () => {
  let n = 0;
  const out = await updateAllCollections(fakePool(rows.slice(0, 2)), { now: () => 0, generate: async () => { if (n++ === 0) throw new Error("boom"); return { ok: true, added: 2, considered: 3 }; } });
  assert.deepEqual(out.map((r) => r.status), ["failed", "added"]);
});

test("too little time left to be worth a call counts as 'later' even before the start cutoff", async () => {
  const out = await updateAllCollections(fakePool(rows.slice(0, 1)), { startMs: 90000, totalMs: 5000, now: () => 0, generate: async () => assert.fail("must not start") });
  assert.deepEqual(out.map((r) => r.status), ["later"]);
});
