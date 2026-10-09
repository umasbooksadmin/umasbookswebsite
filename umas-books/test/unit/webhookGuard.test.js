// lib/webhookGuard.js: the per-address cooldown (60 s, with one trailing check) and the global cap
// (120 HelloAsso checks per 10 minutes) of the unauthenticated HelloAsso webhook.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSyncGuard, COOLDOWN_MS, MAX_PER_WINDOW } = require("../../src/lib/webhookGuard");

function setup(opts = {}) {
  let t = 1_000_000;
  const timers = [];
  const logs = [];
  const guard = createSyncGuard({
    now: () => t, log: (m) => logs.push(m),
    schedule: (fn, ms) => { const timer = { fn, at: t + ms }; timers.push(timer); return timer; },
    ...opts,
  });
  const advance = async (ms) => {
    t += ms;
    for (const timer of timers.filter((x) => !x.done && x.at <= t)) { timer.done = true; timer.fn(); }
    await new Promise((r) => setImmediate(r));
  };
  return { guard, advance, logs, timers };
}

test("defaults are 60 s and 120 per 10 minutes", () => {
  assert.equal(COOLDOWN_MS, 60000);
  assert.equal(MAX_PER_WINDOW, 120);
});

test("the first webhook for an address runs; a repeat within 60 s does not call HelloAsso again but is checked once at the end of the cooldown", async () => {
  const { guard, advance } = setup();
  const checked = [];
  const run = (e) => () => { checked.push(e); };
  assert.equal(await guard.request("Sam@Example.com", run("sam")), "ran");
  assert.equal(await guard.request("sam@example.com", run("sam")), "deferred", "case-insensitive: same address");
  assert.equal(await guard.request("sam@example.com", run("sam")), "coalesced");
  assert.equal(await guard.request("sam@example.com", run("sam")), "coalesced");
  assert.deepEqual(checked, ["sam"], "only one call so far");
  await advance(30_000);
  assert.deepEqual(checked, ["sam"]);
  await advance(31_000);
  assert.deepEqual(checked, ["sam", "sam"], "the trailing check ran: a real payment's last event is still honoured");
  assert.equal(await (async () => { await advance(61_000); return guard.request("sam@example.com", run("sam")); })(), "ran", "after the cooldown it runs at once");
});

test("different addresses are independent", async () => {
  const { guard } = setup();
  const checked = [];
  for (const e of ["a@x.test", "b@x.test", "c@x.test"]) assert.equal(await guard.request(e, () => { checked.push(e); }), "ran");
  assert.equal(checked.length, 3);
});

test("global cap: the 121st distinct address in 10 minutes is acknowledged but not checked; the window then opens again", async () => {
  const { guard, advance, logs } = setup();
  let calls = 0;
  const outcomes = [];
  for (let i = 0; i < MAX_PER_WINDOW + 30; i++) outcomes.push(await guard.request(`forged${i}@x.test`, () => { calls += 1; }));
  assert.equal(calls, MAX_PER_WINDOW);
  assert.equal(outcomes.filter((o) => o === "dropped").length, 30);
  assert.equal(logs.length, 1, "logged once per window");
  await advance(10 * 60 * 1000 + 1);
  assert.equal(await guard.request("later@x.test", () => { calls += 1; }), "ran");
});

test("memory is bounded: a flood of distinct addresses keeps at most maxKeys entries", async () => {
  const { guard } = setup({ maxKeys: 50, maxPerWindow: 100000 });
  for (let i = 0; i < 500; i++) await guard.request(`u${i}@x.test`, () => {});
  assert.ok(guard.size().last <= 50);
  assert.ok(guard.size().pending <= 50);
});

test("a failing check rejects to the caller (the route logs it) and a missing address is dropped", async () => {
  const { guard } = setup();
  await assert.rejects(guard.request("e@x.test", async () => { throw new Error("HelloAsso down"); }), /HelloAsso down/);
  assert.equal(await guard.request("", () => {}), "dropped");
});
