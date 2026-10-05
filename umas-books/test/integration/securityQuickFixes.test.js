// Security quick fixes from the production review, route level (in-process
// so the mailer can be stubbed and "no mail was sent" can be asserted):
//   1. signup / admin member-create must not mail a multi-recipient or
//      malformed "email", must create no account, and signup must answer
//      exactly as it does for a real signup (enumeration-safe);
//   2. out-of-range / unknown ids on anonymous-reachable routes must not
//      reach Postgres as a 500 (each 500 also burns the alert throttle).
// The in-process error handler returns 500 for anything thrown, so a 500
// here is exactly "this would have alerted".

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
// Must load before the routers: a rejected async handler becomes a 500 (as
// in production) instead of an unhandled rejection and a hung request.
const { prepareDatabase, buildApp, listen, waitFor } = require("../helpers/inProcessApp");

const db = prepareDatabase("secquick");

// Stubs go in BEFORE the routes load (they destructure at require time).
const mailer = require("../../src/mailer");
const sent = [];
mailer.sendMail = async (opts) => { sent.push(opts); };
// No network call to HaveIBeenPwned from these tests.
require("../../src/lib/passwordPolicy").validateNewPassword = async () => null;

const { pool } = require("../../src/db");

let server;
before(async () => {
  db.create();
  server = await listen(buildApp([
    require("../../src/routes/auth"),
    require("../../src/routes/admin/members"),
    require("../../src/routes/books"),
    require("../../src/routes/cart"),
    require("../../src/routes/meetings"),
  ]));
});
after(async () => {
  await server.close();
  await pool.end();
  db.drop();
});
beforeEach(() => { sent.length = 0; });

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const HUGE = "99999999999";
const UNKNOWN_ID = "2147483000";
const form = (body) => new URLSearchParams(body).toString();
function post(path, body, headers = {}) {
  return fetch(`${server.base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: form(body),
  });
}
const userHeader = (u) => ({ "x-test-user": JSON.stringify(u) });
const adminHeader = userHeader({ id: 1, email: "a@x.test", displayName: "Admin Test", isAdmin: true });
const count = async (email) => (await pool.query("SELECT count(*)::int AS n FROM users WHERE email = $1", [email])).rows[0].n;
async function createUser(flags = {}) {
  const email = `secquick-${uniq()}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_member, email_verified_at)
     VALUES ($1, $2, 'Sec Quick', $3, now()) RETURNING id`,
    [email, await bcrypt.hash("Irrelevant-1!", 4), !!flags.member]
  );
  return { id: rows[0].id, email };
}

// ---- 1. mail relay ----

test("signup: a multi-recipient email creates no account, sends no mail, and looks like a normal signup", async () => {
  const good = `secquick-good-${uniq()}@example.test`;
  const goodRes = await post("/signup", { email: good, password: "Correct-Horse-1", displayName: "Good" });
  assert.equal(goodRes.status, 200);
  const goodBody = await goodRes.text();
  await waitFor(() => sent.length === 1, { message: "verification email for the real signup" });
  assert.equal(sent[0].to, good);
  sent.length = 0;

  const bad = [
    `a-${uniq()}@example.test, b-${uniq()}@example.test`,
    `a-${uniq()}@example.test;b@example.test`,
    `"x" <a-${uniq()}@example.test>`,
    "not-an-email",
  ];
  for (const email of bad) {
    const res = await post("/signup", { email, password: "Correct-Horse-1", displayName: "Mallory" });
    assert.equal(res.status, 200, email);
    assert.equal(await res.text(), goodBody, `response for ${email} must be identical to a real signup`);
    assert.equal((await pool.query("SELECT 1 FROM users WHERE email = $1", [email.toLowerCase()])).rowCount, 0);
  }
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(sent.length, 0, "no mail may be sent for an invalid address");
  assert.equal(await count(good), 1);
});

test("signup: the display name is capped at 100 characters", async () => {
  const email = `secquick-name-${uniq()}@example.test`;
  const res = await post("/signup", { email, password: "Correct-Horse-1", displayName: "N".repeat(500) });
  assert.equal(res.status, 200);
  const { rows } = await pool.query("SELECT display_name FROM users WHERE email = $1", [email]);
  assert.equal(rows[0].display_name.length, 100);
});

test("admin create-member: an invalid or multi-recipient email creates nothing and mails nobody", async () => {
  for (const email of [`a-${uniq()}@example.test, b-${uniq()}@example.test`, "nope"]) {
    const res = await post("/admin/members", { email, displayName: "Invitee" }, adminHeader);
    assert.equal(res.status, 302);
    assert.equal((await pool.query("SELECT 1 FROM users WHERE email = $1", [email])).rowCount, 0);
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent.length, 0);

  const ok = `secquick-admin-${uniq()}@example.test`;
  const res = await post("/admin/members", { email: ok, displayName: "Invitee" }, adminHeader);
  assert.equal(res.status, 302);
  assert.equal(await count(ok), 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, ok);
});

test("admin edit-member: a multi-recipient email is not applied", async () => {
  const u = await createUser();
  const bad = `x-${uniq()}@example.test, y@example.test`;
  const res = await post(`/admin/members/${u.id}/edit`, { email: bad, displayName: "Renamed" }, adminHeader);
  assert.equal(res.status, 302);
  const { rows } = await pool.query("SELECT email FROM users WHERE id = $1", [u.id]);
  assert.equal(rows[0].email, u.email);
  assert.equal(sent.length, 0);
});

// ---- 2. anonymous 500s ----

test("POST /cart/add with an out-of-range copyId redirects instead of 500", async () => {
  for (const copyId of [HUGE, "abc", "-1", "1e3", ""]) {
    const res = await post("/cart/add", { copyId });
    assert.equal(res.status, 302, `copyId=${copyId}`);
  }
  assert.equal((await post("/cart/add", { copyId: UNKNOWN_ID })).status, 302);
});

test("POST /cart/add-dropin with an out-of-range classId redirects instead of 500", async () => {
  for (const classId of [HUGE, "abc", "-1"]) {
    const res = await post("/cart/add-dropin", { classId });
    assert.equal(res.status, 302, `classId=${classId}`);
  }
  assert.equal((await post("/cart/add-dropin", { classId: UNKNOWN_ID })).status, 302);
});

test("the public POST /books/:id/reserve route is gone (404): no anonymous holds, no mail to arbitrary addresses", async () => {
  const { rows } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'A') RETURNING id", [`Quick Fix ${uniq()}`]);
  const bookId = rows[0].id;
  const { rows: c } = await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'in_stock', 5) RETURNING id", [bookId]);
  const res = await post(`/books/${bookId}/reserve`, { copyId: c[0].id, name: "Guest", email: `v-${uniq()}@example.test` });
  assert.equal(res.status, 404);
  const { rows: after } = await pool.query("SELECT status FROM book_copies WHERE id = $1", [c[0].id]);
  assert.equal(after[0].status, "in_stock");
});

test("POST /api/favorites/toggle: huge id is 400, unknown book is 404, real book is 204", async () => {
  const u = await createUser();
  const hdr = userHeader({ id: u.id, email: u.email });
  assert.equal((await post("/api/favorites/toggle", { bookId: HUGE, isFavorite: "1" }, hdr)).status, 400);
  assert.equal((await post("/api/favorites/toggle", { bookId: UNKNOWN_ID, isFavorite: "1" }, hdr)).status, 404);
  const { rows } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'A') RETURNING id", [`Fav ${uniq()}`]);
  assert.equal((await post("/api/favorites/toggle", { bookId: String(rows[0].id), isFavorite: "1" }, hdr)).status, 204);
  const fav = await pool.query("SELECT 1 FROM favorites WHERE user_id = $1 AND book_id = $2", [u.id, rows[0].id]);
  assert.equal(fav.rowCount, 1);
});

test("POST /meetings/:id/rsvp: unknown meeting is 404 (not an FK-violation 500), huge id is 404", async () => {
  const u = await createUser({ member: true });
  const hdr = userHeader({ id: u.id, email: u.email, isMember: true });
  assert.equal((await post(`/meetings/${UNKNOWN_ID}/rsvp`, {}, hdr)).status, 404);
  assert.equal((await post(`/meetings/${HUGE}/rsvp`, {}, hdr)).status, 404);
  const { rows } = await pool.query(
    "INSERT INTO meetings (title, scheduled_at) VALUES ($1, now() + interval '1 day') RETURNING id", [`Quick ${uniq()}`]
  );
  const ok = await post(`/meetings/${rows[0].id}/rsvp`, {}, hdr);
  assert.equal(ok.status, 302);
  const rsvp = await pool.query("SELECT 1 FROM meeting_rsvps WHERE meeting_id = $1 AND user_id = $2", [rows[0].id, u.id]);
  assert.equal(rsvp.rowCount, 1);
});

test("GET /admin/members?view= with an out-of-range id renders the list instead of 500", async () => {
  for (const view of [HUGE, "abc", "-5"]) {
    const res = await fetch(`${server.base}/admin/members?view=${view}`, { headers: adminHeader });
    assert.equal(res.status, 200, `view=${view}`);
    await res.text();
  }
});

test("GET /admin/members with a repeated q parameter does not 500", async () => {
  const res = await fetch(`${server.base}/admin/members?q=a&q=b`, { headers: adminHeader });
  assert.equal(res.status, 200);
  await res.text();
});

test("GET /api/books/search caps q and survives a repeated q", async () => {
  const long = await fetch(`${server.base}/api/books/search?q=${"z".repeat(5000)}`);
  assert.equal(long.status, 200);
  assert.deepEqual(await long.json(), []);
  const rep = await fetch(`${server.base}/api/books/search?q=a&q=b`);
  assert.equal(rep.status, 200);
  await rep.text();
});
