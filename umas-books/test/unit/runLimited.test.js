const { test } = require("node:test");
const assert = require("node:assert/strict");
const { runLimited, cachedFor } = require("../../src/lib/runLimited");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("runLimited never runs more than `limit` tasks at once and keeps result order", async () => {
  let running = 0;
  let peak = 0;
  const tasks = Array.from({ length: 10 }, (_, i) => async () => {
    running++;
    peak = Math.max(peak, running);
    await sleep(5 + ((10 - i) % 4) * 3); // finish out of order
    running--;
    return i * 2;
  });
  const out = await runLimited(tasks, 3);
  assert.deepEqual(out, [0, 2, 4, 6, 8, 10, 12, 14, 16, 18]);
  assert.equal(peak, 3);
});

test("runLimited with limit 1 is sequential, and an empty list resolves []", async () => {
  let running = 0;
  let peak = 0;
  await runLimited([1, 2, 3].map(() => async () => { running++; peak = Math.max(peak, running); await sleep(2); running--; }), 1);
  assert.equal(peak, 1);
  assert.deepEqual(await runLimited([], 3), []);
});

test("runLimited rejects with the first failure and starts nothing after it", async () => {
  const started = [];
  const tasks = [0, 1, 2, 3, 4, 5].map((i) => async () => {
    started.push(i);
    await sleep(5);
    if (i === 1) throw new Error("boom");
    return i;
  });
  await assert.rejects(runLimited(tasks, 2), /boom/);
  await sleep(30);
  assert.ok(started.length < 6, `tasks after the failure were not started (started ${started})`);
});

test("cachedFor: computes once within the TTL, again after it, and shares an in-flight computation", async () => {
  let now = 1000;
  let calls = 0;
  const get = cachedFor(async () => { calls++; await sleep(10); return calls; }, 30000, () => now);
  const [a, b] = await Promise.all([get(), get()]);
  assert.equal(a, 1);
  assert.equal(b, 1);
  assert.equal(calls, 1, "two simultaneous callers share one computation");
  now += 29999;
  assert.equal(await get(), 1, "still cached");
  now += 2;
  assert.equal(await get(), 2, "recomputed after the TTL");
});

test("cachedFor: a failure is not cached, and TTL 0 turns the cache off", async () => {
  let calls = 0;
  const flaky = cachedFor(async () => { calls++; if (calls === 1) throw new Error("first fails"); return calls; }, 30000);
  await assert.rejects(flaky(), /first fails/);
  assert.equal(await flaky(), 2);

  let n = 0;
  const off = cachedFor(async () => ++n, () => 0);
  assert.equal(await off(), 1);
  assert.equal(await off(), 2);
});
