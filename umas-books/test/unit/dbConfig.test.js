const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parsePoolMax, DEFAULT_POOL_MAX } = require("../../src/lib/dbConfig");
const { createPoolMonitor } = require("../../src/lib/poolMonitor");

test("DB_POOL_MAX: unset or blank gives the default of 20, without a warning", () => {
  assert.deepEqual(parsePoolMax(undefined), { value: 20 });
  assert.deepEqual(parsePoolMax(""), { value: 20 });
  assert.equal(DEFAULT_POOL_MAX, 20);
});

test("DB_POOL_MAX: whole numbers from 2 to 50 are accepted", () => {
  for (const v of ["2", "15", " 30 ", "50"]) assert.equal(parsePoolMax(v).warning, undefined, v);
  assert.equal(parsePoolMax("15").value, 15);
  assert.equal(parsePoolMax(" 30 ").value, 30);
});

test("DB_POOL_MAX: anything else falls back to 20 with a warning that names the value", () => {
  for (const v of ["1", "0", "51", "-5", "abc", "10.5", "1e1", "0x10", "NaN"]) {
    const r = parsePoolMax(v);
    assert.equal(r.value, 20, v);
    assert.match(r.warning, /DB_POOL_MAX/, v);
  }
});

function fakePool(counts = {}) {
  return { waitingCount: 0, totalCount: 20, idleCount: 0, options: { max: 20 }, ...counts };
}

test("pool monitor: silent for a short wait, logs after 2 s with the counts, then at most once a minute", () => {
  const lines = [];
  const pool = fakePool({ waitingCount: 4 });
  const m = createPoolMonitor(pool, { log: (l) => lines.push(l) });
  assert.equal(m.check(0), false);
  assert.equal(m.check(1999), false);
  assert.equal(m.check(2000), true);
  assert.match(lines[0], /waiting=4 total=20 idle=0 max=20/);
  assert.equal(m.check(30000), false, "not again within a minute");
  assert.equal(m.check(62000), true, "again after a minute of continuous waiting");
  assert.equal(lines.length, 2);
});

test("pool monitor: a queue that clears resets the 2 s clock", () => {
  const lines = [];
  const pool = fakePool({ waitingCount: 1 });
  const m = createPoolMonitor(pool, { log: (l) => lines.push(l) });
  m.check(0);
  pool.waitingCount = 0;
  m.check(1500);
  pool.waitingCount = 1;
  assert.equal(m.check(3000), false, "waiting started again at 3000");
  assert.equal(m.check(4999), false);
  assert.equal(m.check(5000), true);
});
