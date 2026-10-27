// The "back to the list" text an admin POST carries (hidden field backQuery) is rebuilt from a whitelist
// (lib/backQuery.js) in members, announcements and blog: hostile values never reach the redirect Location.
// Port 7861 is reserved.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { Client } = require("pg");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PASSWORD = "BackQuery1!Test";
let app, db, jar, memberId, announcementId, blogId;

before(async () => {
  app = await startTestApp({ port: 7861, isolated: true });
  db = new Client({ connectionString: app.databaseUrl });
  await db.connect();
  const email = `backquery-${Date.now()}@example.test`;
  await db.query("INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at) VALUES ($1, $2, 'Admin', true, now())", [email, await bcrypt.hash(PASSWORD, 10)]);
  memberId = (await db.query("INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Member') RETURNING id", [`bq-member-${Date.now()}@example.test`])).rows[0].id;
  announcementId = (await db.query("INSERT INTO announcements (title, body, status) VALUES ('A', '<p>b</p>', 'published') RETURNING id")).rows[0].id;
  blogId = (await db.query("INSERT INTO blog_posts (slug, title, body, status) VALUES ('bq', 'B', '<p>b</p>', 'published') RETURNING id")).rows[0].id;
  jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }).toString(),
  });
  jar.capture(res);
  assert.equal(res.status, 302);
});
after(async () => { await db.end(); await app.stop(); });

async function postLocation(path, backQuery) {
  const body = new URLSearchParams({ _csrf: await fetchCsrfToken(app.base, jar) });
  if (backQuery !== undefined) body.set("backQuery", backQuery);
  const res = await fetch(`${app.base}${path}`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() }, body: body.toString() });
  jar.capture(res);
  await res.text();
  assert.ok([302, 303].includes(res.status), `${path} -> ${res.status}`);
  return res.headers.get("location");
}

const HOSTILE = [
  "status=draft&evil=1",
  "//evil.example/x",
  "q=a%0d%0aSet-Cookie:%20x=1",
  "status=draft#frag",
  "returnTo=//evil.example&q=ok",
  `q=${"z".repeat(4000)}`,
];

const targets = () => [
  { name: "members", path: () => `/admin/members/${memberId}/reset-2fa`, base: () => `/admin/members?view=${memberId}`, good: "q=bob&role=member&status=active&page=2", goodOut: "&q=bob&role=member&status=active&page=2" },
  { name: "announcements", path: () => `/admin/announcements/${announcementId}/pin`, base: () => "/admin/announcements", good: "status=draft&q=x&pinnedOnly=1", goodOut: "?status=draft&q=x&pinnedOnly=1" },
  { name: "blog", path: () => `/admin/blog/${blogId}/delete`, base: () => "/admin/blog", good: "status=draft&category=News&page=3", goodOut: "?status=draft&category=News&page=3" },
];

test("a normal backQuery still brings the admin back to the same filtered list", async () => {
  for (const t of targets()) {
    const loc = await postLocation(t.path(), t.good);
    assert.equal(loc, `${t.base()}${t.goodOut}`, t.name);
  }
});

test("hostile backQuery values never reach the redirect: no extra parameter, host, newline or long string", async () => {
  for (const t of targets()) {
    for (const bad of HOSTILE) {
      const loc = await postLocation(t.path(), bad);
      assert.ok(loc.startsWith(t.base().split("?")[0]), `${t.name}: ${loc}`);
      assert.ok(!/evil|[\r\n]|#|\/\//i.test(loc.replace(/^\/+/, "")), `${t.name} ${bad.slice(0, 30)} -> ${loc.slice(0, 80)}`);
      assert.ok(loc.length < 300, `${t.name}: ${loc.length}`);
    }
    assert.equal(await postLocation(t.path(), undefined), t.base(), `${t.name} without a backQuery`);
  }
});
