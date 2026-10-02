const { test } = require("node:test");
const assert = require("node:assert/strict");
const { guardJob } = require("../../src/lib/jobGuard");

test("a tick that arrives while the previous run is in flight is skipped, then runs again afterwards", async () => {
  let runs = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const job = guardJob("Test job", async () => { runs++; await gate; });
    const first = job();
    await job(); // overlapping tick
    await job(); // and another
    assert.equal(runs, 1);
    assert.equal(warnings.length, 2, "one log line per skipped tick");
    release();
    await first;
    await job();
    assert.equal(runs, 2, "next tick after completion runs normally");
  } finally {
    console.warn = realWarn;
  }
});

test("a throwing job is logged and does not leave the guard stuck", async () => {
  let runs = 0;
  const realErr = console.error;
  console.error = () => {};
  try {
    const job = guardJob("Boom job", async () => { runs++; throw new Error("x"); });
    await job();
    await job();
    assert.equal(runs, 2);
  } finally {
    console.error = realErr;
  }
});
