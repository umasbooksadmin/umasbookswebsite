const { test } = require("node:test");
const assert = require("node:assert/strict");
const { attachUser } = require("../../src/middleware/auth");

// Regression: attachUser is async middleware on Express 4, which ignores
// a rejected promise — a DB error used to leave the request hanging.
test("a database error is passed to next() instead of leaving the request hanging", async () => {
  const boom = new Error("db down");
  const pool = { query: async () => { throw boom; } };
  const req = { session: { user: { id: 1, passwordChangedAt: 0 } } };
  const res = { locals: {} };
  const err = await new Promise((resolve) => attachUser(pool)(req, res, resolve));
  assert.equal(err, boom);
});
