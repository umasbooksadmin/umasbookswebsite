// Admin "Download data (JSON)" for a member (right of access/portability):
// GET /admin/members/:id/export.json. Admin only, no secrets, and it finds
// data held under the member's email as well as their user id.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3640;
const PASSWORD = "ExportTest1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app, pool;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});

after(async () => {
  await pool.end();
  app.stop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function createUser({ admin = false } = {}) {
  const email = `export-${uniq()}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at)
     VALUES ($1, $2, 'Export Me', $3, now()) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10), admin]
  );
  return { id: rows[0].id, email };
}

async function loginAs(user) {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const login = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ email: user.email, password: PASSWORD, _csrf: token }).toString(),
  });
  jar.capture(login);
  assert.equal(login.status, 302);
  return jar;
}

const get = (path, jar) =>
  fetch(`${app.base}${path}`, { redirect: "manual", headers: jar ? { cookie: jar.header() } : {} });

test("admin downloads a member's data as JSON, without secrets", async () => {
  const admin = await createUser({ admin: true });
  const member = await createUser();
  const { rows: ev } = await pool.query("INSERT INTO events (title, starts_at) VALUES ('Quiz night', now()) RETURNING id");
  await pool.query("INSERT INTO event_signups (event_id, name, email) VALUES ($1, 'Export Me', $2)", [ev[0].id, member.email.toUpperCase()]);
  const { rows: ord } = await pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, buyer_phone, status, total_amount)
     VALUES ('Export Me', $1, '0611111111', 'paid', 7) RETURNING id`,
    [member.email]
  );
  const { rows: bk } = await pool.query("INSERT INTO books (title) VALUES ('Export Book') RETURNING id");
  const { rows: copy } = await pool.query("INSERT INTO book_copies (book_id, price) VALUES ($1, 7) RETURNING id", [bk[0].id]);
  await pool.query(
    "INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, 'Export Book', 7)",
    [ord[0].id, copy[0].id]
  );
  await pool.query(
    `INSERT INTO membership_payments (user_id, helloasso_order_id, payer_email, amount_cents, paid_at)
     VALUES (NULL, $1, $2, 1500, now())`,
    [Math.floor(Math.random() * 1e12), member.email]
  );
  await pool.query("INSERT INTO forum_threads (title, body, author_id) VALUES ('My thread', 'my words', $1)", [member.id]);

  const jar = await loginAs(admin);
  const res = await get(`/admin/members/${member.id}/export.json`, jar);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /^attachment;/);
  assert.match(res.headers.get("cache-control"), /no-store/);
  assert.match(res.headers.get("content-type"), /application\/json/);

  const text = await res.text();
  const data = JSON.parse(text);
  // Reading a member's data is logged (id only, no personal data).
  const { rows: audited } = await pool.query(
    "SELECT actor_user_id, target_id, detail FROM admin_audit_log WHERE action = 'member.export' AND target_id = $1", [member.id]);
  assert.equal(audited.length, 1);
  assert.equal(audited[0].actor_user_id, admin.id);
  assert.ok(!JSON.stringify(audited[0]).includes(member.email));
  for (const section of [
    "user", "event_signups", "class_signups", "orders", "membership_payments", "favorites",
    "volunteer_signups", "meeting_rsvps", "forum_threads", "forum_replies",
    "charity_votes", "charity_ideas", "book_reservations",
  ]) {
    assert.ok(section in data, `missing section ${section}`);
  }
  assert.equal(data.user.email, member.email);
  assert.ok(!("password_hash" in data.user));
  assert.ok(!text.includes("$2a$") && !text.includes("$2b$"), "no bcrypt hash anywhere in the file");
  assert.equal(data.event_signups.length, 1);
  assert.equal(data.event_signups[0].event_title, "Quiz night");
  assert.equal(data.orders.length, 1);
  assert.equal(data.orders[0].buyer_phone, "0611111111");
  assert.equal(data.orders[0].items[0].title, "Export Book");
  assert.equal(data.membership_payments.length, 1, "payment matched by payer email while user_id is NULL");
  assert.equal(data.forum_threads[0].body, "my words");
});

test("a non-admin cannot download member data", async () => {
  const member = await createUser();
  const other = await createUser();
  const anon = await get(`/admin/members/${member.id}/export.json`);
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get("location"), "/login");

  const jar = await loginAs(other);
  const res = await get(`/admin/members/${member.id}/export.json`, jar);
  assert.equal(res.status, 403);
  assert.ok(!(await res.text()).includes(member.email));
});

test("an invalid or unknown id is a 404", async () => {
  const admin = await createUser({ admin: true });
  const jar = await loginAs(admin);
  for (const id of ["abc", "0", "-1", "99999999999", "2147483647"]) {
    const res = await get(`/admin/members/${id}/export.json`, jar);
    assert.equal(res.status, 404, `id ${id}`);
  }
});

test("the member detail page links to the export", async () => {
  const admin = await createUser({ admin: true });
  const member = await createUser();
  const jar = await loginAs(admin);
  const html = await (await get(`/admin/members?view=${member.id}`, jar)).text();
  assert.ok(html.includes(`href="/admin/members/${member.id}/export.json"`));
  assert.ok(html.includes("Download data (JSON)"));
});
