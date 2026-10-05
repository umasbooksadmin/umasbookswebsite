// RSVP to a meeting that doesn't exist: 404 page, not a foreign-key 500.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");

const db = prepareDatabase("meeting_rsvp", { isolated: true });
const { pool } = require("../../src/db");

let server;
let userId;
before(async () => {
  db.create();
  const { rows } = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, is_member) VALUES ($1, 'x', 'Rsvp Member', true) RETURNING id",
    [`rsvp-${Date.now()}@example.test`]
  );
  userId = rows[0].id;
  server = await listen(buildApp([require("../../src/routes/meetings")]));
});
after(async () => {
  await server.close();
  await pool.end();
  db.drop();
});

const post = (path) => fetch(`${server.base}${path}`, {
  method: "POST",
  redirect: "manual",
  headers: { "x-test-user": JSON.stringify({ id: userId, isMember: true }) },
});

test("rsvp to a nonexistent or garbage meeting id is a 404, and creates nothing", async () => {
  for (const id of ["99999999", "abc", "0", "99999999999"]) {
    assert.equal((await post(`/meetings/${id}/rsvp`)).status, 404, id);
  }
  const { rowCount } = await pool.query("SELECT 1 FROM meeting_rsvps WHERE user_id = $1", [userId]);
  assert.equal(rowCount, 0);
});

test("rsvp to a real meeting still works and unrsvp removes it", async () => {
  const { rows } = await pool.query("INSERT INTO meetings (title, scheduled_at) VALUES ('M', now() + interval '1 day') RETURNING id");
  const id = rows[0].id;
  assert.equal((await post(`/meetings/${id}/rsvp`)).status, 302);
  assert.equal((await pool.query("SELECT 1 FROM meeting_rsvps WHERE meeting_id = $1", [id])).rowCount, 1);
  assert.equal((await post(`/meetings/${id}/unrsvp`)).status, 302);
  assert.equal((await pool.query("SELECT 1 FROM meeting_rsvps WHERE meeting_id = $1", [id])).rowCount, 0);
});
