const { test } = require("node:test");
const assert = require("node:assert/strict");
const { saveSession } = require("../../src/lib/session");

// The race this guards (express-session answering before its store write
// lands) needs real timing to reproduce end to end; here we pin the
// contract the auth routes rely on: the promise settles only after the
// store's save callback fires.
test("saveSession resolves only after the store's save callback", async () => {
  let saved = false;
  const req = { session: { save: (cb) => setTimeout(() => { saved = true; cb(); }, 30) } };
  await saveSession(req);
  assert.equal(saved, true);
});

test("saveSession rejects when the store fails", async () => {
  const boom = new Error("store down");
  const req = { session: { save: (cb) => cb(boom) } };
  await assert.rejects(saveSession(req), boom);
});
