const { test } = require("node:test");
const assert = require("node:assert/strict");
const { csrfTokenEndpoint } = require("../../src/middleware/csrf");

// Regression: /api/csrf-token answered before the session holding the new
// token was saved (express-session flushes headers early), so a client that
// POSTed immediately could be rejected with a 403 (seen as an intermittent
// CI failure). The response must wait for the save.
test("the token response is sent only after the session has been saved", async () => {
  let saved = false;
  const events = [];
  const req = { session: { save: (cb) => setTimeout(() => { saved = true; events.push("saved"); cb(); }, 30) } };
  const res = {
    set() {},
    json(body) { events.push("responded"); this.body = body; },
  };
  await csrfTokenEndpoint(req, res);
  assert.equal(saved, true);
  assert.deepEqual(events, ["saved", "responded"]);
  assert.match(res.body.token, /^[0-9a-f]{64}$/);
  assert.equal(req.session.csrfToken, res.body.token);
});
