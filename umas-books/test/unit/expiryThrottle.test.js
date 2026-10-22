const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { makeThrottledExpiry, EXPIRY_THROTTLE_MS } = require("../../src/lib/reservations");

test("the throttled expiry sweep runs at most once per window, and again after it", async () => {
  let now = 1000;
  let sweeps = 0;
  const pool = {};
  const throttled = makeThrottledExpiry(30000, () => now, async () => { sweeps++; });
  await Promise.all([throttled(pool), throttled(pool), throttled(pool)]);
  assert.equal(sweeps, 1, "concurrent views share one sweep");
  now += 29000;
  await throttled(pool);
  assert.equal(sweeps, 1, "inside the window: no sweep");
  now += 2000;
  await throttled(pool);
  assert.equal(sweeps, 2, "after the window: sweeps again");
  await makeThrottledExpiry(30000, () => now, async () => { sweeps++; })({});
  assert.equal(sweeps, 3, "another pool is separate");
});

test("a failed sweep is not cached", async () => {
  let calls = 0;
  const throttled = makeThrottledExpiry(30000, () => 5, async () => { calls++; if (calls === 1) throw new Error("db"); });
  const pool = {};
  await assert.rejects(throttled(pool));
  await throttled(pool);
  assert.equal(calls, 2);
});

test("the window is 30 s", () => assert.equal(EXPIRY_THROTTLE_MS, 30000));

test("only the read-only book page is throttled; cart, return, till and admin sweep every time", () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, "../../src/routes", f), "utf8");
  assert.match(src("books.js"), /expireStaleReservationsThrottled\(pool\)/);
  assert.doesNotMatch(src("books.js"), /[^d]expireStaleReservations\(pool\)/);
  for (const f of ["cart.js", "admin/till.js", "admin/orders.js", "admin/inventory.js"]) {
    assert.match(src(f), /await expireStaleReservations\(pool\)/, f);
    assert.doesNotMatch(src(f), /Throttled/, f);
  }
});
