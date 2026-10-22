// Admin audit log (src/lib/audit.js, /admin/audit): sensitive admin actions
// leave a row with the admin, the action and a numeric target id, and never
// any member personal data. Logging problems must not break the action, and
// rows older than 12 months are purged.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3660;
const PASSWORD = "AuditLog1!Test";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app, pool, privacy;

before(async () => {
  // isolated: one test renames the audit table, which must not affect other files.
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  privacy = require("../../src/lib/privacy");
});

after(async () => {
  await pool.end();
  app.stop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function createUser({ admin = false } = {}) {
  const email = `audit-${uniq()}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at)
     VALUES ($1, $2, 'Audit Person', $3, now()) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10), admin]
  );
  return { id: rows[0].id, email };
}

async function loginJar(email) {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST",
    redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }).toString(),
  });
  jar.capture(res);
  assert.equal(res.status, 302, "test login should succeed");
  return jar;
}

async function post(jar, path, fields = {}) {
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });
  await res.text();
  return res;
}

async function waitForRows(sql, params, min = 1) {
  for (let i = 0; i < 50; i++) {
    const { rows } = await pool.query(sql, params);
    if (rows.length >= min) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return [];
}

test("an admin action writes a row with the right actor, action and target, and no member data", async () => {
  const admin = await createUser({ admin: true });
  const member = await createUser();
  const jar = await loginJar(admin.email);

  const res = await post(jar, `/admin/members/${member.id}/toggle-volunteer`, { desired: "on" });
  assert.equal(res.status, 302);
  const del = await post(jar, `/admin/members/${member.id}/delete`);
  assert.equal(del.status, 302);

  const rows = await waitForRows(
    "SELECT * FROM admin_audit_log WHERE actor_user_id = $1 AND target_id = $2 ORDER BY id",
    [admin.id, member.id],
    2
  );
  assert.deepEqual(rows.map((r) => r.action), ["member.toggle_volunteer", "member.erase"]);
  for (const r of rows) {
    assert.equal(r.actor_label, admin.email);
    assert.equal(r.target_type, "user");
    assert.ok(r.at);
  }
  // Nothing about the member beyond the numeric id.
  const everything = JSON.stringify((await pool.query("SELECT * FROM admin_audit_log")).rows);
  assert.ok(!everything.includes(member.email));
  assert.ok(!everything.includes("Audit Person"));

  // The admin's own login was recorded too.
  const logins = await waitForRows("SELECT 1 FROM admin_audit_log WHERE action = 'admin.login' AND actor_user_id = $1", [admin.id]);
  assert.equal(logins.length, 1);
});

test("a failing audit write does not break the admin action", async () => {
  const admin = await createUser({ admin: true });
  const member = await createUser();
  const jar = await loginJar(admin.email);

  await pool.query("ALTER TABLE admin_audit_log RENAME TO admin_audit_log_away");
  try {
    const res = await post(jar, `/admin/members/${member.id}/toggle-volunteer`, { desired: "on" });
    assert.equal(res.status, 302);
    const { rows } = await pool.query("SELECT is_volunteer FROM users WHERE id = $1", [member.id]);
    assert.equal(rows[0].is_volunteer, true);
  } finally {
    await pool.query("ALTER TABLE admin_audit_log_away RENAME TO admin_audit_log");
  }
});

test("/admin/audit requires an admin and lists entries without personal data", async () => {
  const anon = await fetch(`${app.base}/admin/audit`, { redirect: "manual" });
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get("location"), "/login");

  const plain = await createUser();
  const plainRes = await fetch(`${app.base}/admin/audit`, { redirect: "manual", headers: { cookie: (await loginJar(plain.email)).header() } });
  assert.notEqual(plainRes.status, 200);

  const admin = await createUser({ admin: true });
  const target = await createUser();
  const jar = await loginJar(admin.email);
  await post(jar, `/admin/members/${target.id}/toggle-volunteer`, { desired: "on" });
  await waitForRows("SELECT 1 FROM admin_audit_log WHERE action = 'member.toggle_volunteer' AND target_id = $1", [target.id]);

  const res = await fetch(`${app.base}/admin/audit`, { headers: { cookie: jar.header() } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /member\.toggle_volunteer/);
  assert.ok(html.includes(admin.email));
  assert.ok(!html.includes(target.email));
  assert.ok(!/<script(?![^>]*src=)[^>]*>/i.test(html.split("admin-main-content")[1] || ""), "no inline script in the page body");
});

test("purge deletes audit rows older than 12 months and keeps newer ones", async () => {
  const marker = `purge-test-${uniq()}`;
  await pool.query(
    `INSERT INTO admin_audit_log (at, action, detail) VALUES
       (now() - interval '13 months', 'test.old', $1),
       (now() - interval '11 months', 'test.recent', $1)`,
    [marker]
  );
  const counts = await privacy.purgeExpiredPersonalData(pool);
  assert.notEqual(counts.auditLog, "error");
  // The 11-month row survives, but its free-text detail is blanked after 6 months
  // (RETENTION.auditDetailMonths): so it is found by action, not by the marker.
  const { rows } = await pool.query("SELECT action, detail FROM admin_audit_log WHERE action IN ('test.old', 'test.recent') AND (detail = $1 OR detail IS NULL) ORDER BY at", [marker]);
  assert.ok(!rows.some((r) => r.action === "test.old"), "the 13-month row is deleted");
  const recent = rows.filter((r) => r.action === "test.recent");
  assert.ok(recent.length >= 1 && recent.every((r) => r.detail === null), "the 11-month row stays, without its free text");
});
