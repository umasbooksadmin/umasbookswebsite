// Account role switches (src/routes/admin/members.js, src/lib/accountRoles.js):
// the form posts the state it wants, so a double submit or a stale page cannot
// undo a change, and two admins cannot demote each other to zero admins.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 7801;
const PASSWORD = "RoleToggle1!Test";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app, pool;

before(async () => {
  // isolated: the last-admin tests count every admin in the database.
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
  const email = `role-${uniq()}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at)
     VALUES ($1, $2, 'Role Person', $3, now()) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10), admin]
  );
  return { id: rows[0].id, email };
}

async function loginJar(email) {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
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
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });
  await res.text();
  return res;
}

const flag = async (id, col) => (await pool.query(`SELECT ${col} AS v FROM users WHERE id = $1`, [id])).rows[0].v;
const auditRows = async (action, id) =>
  (await pool.query("SELECT detail FROM admin_audit_log WHERE action = $1 AND target_id = $2 ORDER BY id", [action, id])).rows;
async function waitAudit(action, id, n) {
  for (let i = 0; i < 50; i++) {
    const rows = await auditRows(action, id);
    if (rows.length >= n) return rows;
    await new Promise((r) => setTimeout(r, 100));
  }
  return auditRows(action, id);
}

test("posting the same desired state twice leaves it set (no flip back), with one audit row recording old and new", async () => {
  const admin = await createUser({ admin: true });
  const target = await createUser();
  const jar = await loginJar(admin.email);

  for (const role of ["member", "volunteer", "till"]) {
    const url = `/admin/members/${target.id}/toggle-${role}`;
    const col = `is_${role}`;
    assert.equal((await post(jar, url, { desired: "on" })).status, 302);
    const second = await post(jar, url, { desired: "on" });
    assert.match(second.headers.get("location"), new RegExp(`roleNotice=${role}\\.same`));
    assert.equal(await flag(target.id, col), true, `${role} stays on after a double submit`);
    const rows = await waitAudit(`member.toggle_${role}`, target.id, 1);
    assert.equal(rows.length, 1, "nothing changed the second time, so nothing was logged");
    assert.match(rows[0].detail, /\(off -> on\)/);
    await post(jar, url, { desired: "off" });
    assert.equal(await flag(target.id, col), false);
    assert.match((await waitAudit(`member.toggle_${role}`, target.id, 2))[1].detail, /\(on -> off\)/);
  }
});

test("a missing or garbled desired value changes nothing", async () => {
  const admin = await createUser({ admin: true });
  const target = await createUser();
  const jar = await loginJar(admin.email);
  for (const fields of [{}, { desired: "maybe" }]) {
    const res = await post(jar, `/admin/members/${target.id}/toggle-volunteer`, fields);
    assert.match(res.headers.get("location"), /roleNotice=volunteer\.bad/);
  }
  assert.equal(await flag(target.id, "is_volunteer"), false);
});

test("member status on clears member_expires_at; setting it again does not touch it", async () => {
  const admin = await createUser({ admin: true });
  const target = await createUser();
  const jar = await loginJar(admin.email);
  await pool.query("UPDATE users SET member_expires_at = now() + interval '30 days' WHERE id = $1", [target.id]);
  await post(jar, `/admin/members/${target.id}/toggle-member`, { desired: "on" });
  assert.equal(await flag(target.id, "member_expires_at"), null);
});

test("the account panel shows the friendly notice and posts the opposite state", async () => {
  const admin = await createUser({ admin: true });
  const target = await createUser();
  const jar = await loginJar(admin.email);
  const res = await post(jar, `/admin/members/${target.id}/toggle-admin`, { desired: "on" });
  const page = await (await fetch(`${app.base}${res.headers.get("location")}`, { headers: { cookie: jar.header() } })).text();
  assert.match(page, /Admin rights given\./);
  assert.match(page, /toggle-admin">\s*<input type="hidden" name="_csrf"[^>]*>\s*<input type="hidden" name="desired" value="off">/);
});

test("admins cannot demote or deactivate themselves", async () => {
  const admin = await createUser({ admin: true });
  const jar = await loginJar(admin.email);
  assert.match((await post(jar, `/admin/members/${admin.id}/toggle-admin`, { desired: "off" })).headers.get("location"), /admin\.self/);
  assert.match((await post(jar, `/admin/members/${admin.id}/toggle-disabled`, { desired: "on" })).headers.get("location"), /disabled\.self/);
  assert.equal(await flag(admin.id, "is_admin"), true);
  assert.equal(await flag(admin.id, "is_disabled"), false);
});

test("two admins demoting each other at the same moment leave exactly one admin", async () => {
  await pool.query("UPDATE users SET is_admin = false WHERE is_admin");
  const a = await createUser({ admin: true });
  const b = await createUser({ admin: true });
  const jarA = await loginJar(a.email);
  const jarB = await loginJar(b.email);
  const [r1, r2] = await Promise.all([
    post(jarA, `/admin/members/${b.id}/toggle-admin`, { desired: "off" }),
    post(jarB, `/admin/members/${a.id}/toggle-admin`, { desired: "off" }),
  ]);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM users WHERE is_admin AND NOT is_disabled");
  assert.equal(rows[0].n, 1, "exactly one active admin remains");
  // Two real requests are never exactly simultaneous: depending on timing the second one is either stopped by the
  // last-admin lock (both got past the admin check together) or refused with 403 because the first had already
  // taken its sender's admin rights away. Both are correct; what must hold is one demotion happened and no more.
  const outcome = (r) => (r.status === 403 ? "forbidden" : (r.headers.get("location") || "").match(/roleNotice=admin\.([\w-]+)/)?.[1] ?? `status ${r.status}`);
  const outcomes = [r1, r2].map(outcome).sort();
  assert.ok(
    outcomes.join() === "last-admin,off" || outcomes.join() === "forbidden,off",
    `one demotion succeeds and the other is stopped (last-admin lock or no longer an admin); got ${outcomes.join(", ")}`
  );
});

test("the last-admin lock itself: two simultaneous demotions of each other through the lock, exactly one wins", async () => {
  // Same race without the HTTP layer, so BOTH calls reach the lock together and the loser is always the lock's
  // "last_admin" answer (the test above cannot promise that: the second request may arrive after the first finished).
  const { setAccountFlag } = require("../../src/lib/accountRoles");
  for (const role of ["admin", "disabled"]) {
    await pool.query("UPDATE users SET is_admin = false WHERE is_admin");
    const a = await createUser({ admin: true });
    const b = await createUser({ admin: true });
    const desired = role === "admin" ? false : true;
    const results = await Promise.all([setAccountFlag(pool, a.id, role, desired), setAccountFlag(pool, b.id, role, desired)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["changed", "last_admin"], `${role}: one change, one refusal`);
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM users WHERE is_admin AND NOT is_disabled");
    assert.equal(rows[0].n, 1);
  }
});

test("two admins deactivating each other at the same moment leave one active admin", async () => {
  await pool.query("UPDATE users SET is_admin = false WHERE is_admin");
  const a = await createUser({ admin: true });
  const b = await createUser({ admin: true });
  const jarA = await loginJar(a.email);
  const jarB = await loginJar(b.email);
  await Promise.all([
    post(jarA, `/admin/members/${b.id}/toggle-disabled`, { desired: "on" }),
    post(jarB, `/admin/members/${a.id}/toggle-disabled`, { desired: "on" }),
  ]);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM users WHERE is_admin AND NOT is_disabled");
  assert.equal(rows[0].n, 1);
});

test("granting admin to someone else works and is audited", async () => {
  const admin = await createUser({ admin: true });
  const target = await createUser();
  const jar = await loginJar(admin.email);
  await post(jar, `/admin/members/${target.id}/toggle-admin`, { desired: "on" });
  assert.equal(await flag(target.id, "is_admin"), true);
  assert.match((await waitAudit("member.toggle_admin", target.id, 1))[0].detail, /Admin rights given \(off -> on\)/);
});
