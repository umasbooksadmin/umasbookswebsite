const test = require("node:test");
const assert = require("node:assert/strict");
const { pruneStaleFlash, flashHousekeeping, takeFlash, MAX_AGE_MS } = require("../../src/lib/flash");

test("flash: entries nobody picked up within 10 minutes are dropped on the next request, fresh ones stay", () => {
  const now = Date.now();
  const req = { session: { pageFlash: { cart: { at: now - MAX_AGE_MS - 1000, data: { phone: "0612345678" } }, other: { at: now - 1000, data: { x: 1 } }, junk: {} } } };
  let called = false;
  flashHousekeeping(req, {}, () => { called = true; });
  assert.ok(called);
  assert.deepEqual(Object.keys(req.session.pageFlash), ["other"]);
  assert.deepEqual(takeFlash(req, "other"), { x: 1 });
  assert.equal(req.session.pageFlash, undefined, "an empty flash object is removed from the session");
});

test("flash: nothing to do without a session or flash", () => {
  assert.equal(pruneStaleFlash({}), 0);
  assert.equal(pruneStaleFlash({ session: {} }), 0);
});
