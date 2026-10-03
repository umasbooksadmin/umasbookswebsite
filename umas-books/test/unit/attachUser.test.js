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

// Inactivity clock: any authenticated request counts as activity, written
// at most once per day (tracked by a marker in the session).
test("refreshes last_login_at and clears the inactivity warning at most once per day", async () => {
  const updates = [];
  const pool = {
    query: async (sql, params) => {
      if (/^UPDATE users SET last_login_at/.test(sql)) {
        assert.match(sql, /inactivity_warned_at = NULL/);
        updates.push(params);
        return { rows: [] };
      }
      return { rows: [{ is_admin: false, is_member: false, is_volunteer: false, is_disabled: false, password_changed_at: new Date(5) }] };
    },
  };
  const req = { session: { user: { id: 7, passwordChangedAt: 5 } } };
  const run = () => new Promise((resolve) => attachUser(pool)(req, { locals: {} }, resolve));
  await run();
  await run();
  await run();
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], [7]);

  // A new day triggers one more write.
  req.session.user.activeDay = "2000-01-01";
  await run();
  assert.equal(updates.length, 2);
});
