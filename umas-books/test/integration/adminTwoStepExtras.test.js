// The admin extras on pages that are not behind requireAdmin (review 6A L4): blog drafts with ?preview=1 (the post
// page and the feed) and hidden forum posts and replies. With two-step verification required, an admin who has not
// enrolled yet gets none of them, exactly as requireAdmin sends such a session to the setup page; once enrolled, all of
// them. One shared rule: middleware/auth.js isFullAdmin. Real app, real login. Port 4393 is reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PASSWORD = "TwoStepExtras1!";
let app, pool, admin, jar, slug, threadId;
const uniq = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
const DRAFT_TITLE = "Unreleased draft post";
const HIDDEN_BODY = "HIDDEN-THREAD-BODY-TEXT";
const HIDDEN_REPLY = "HIDDEN-REPLY-TEXT";

before(async () => {
  app = await startTestApp({ port: 4393, isolated: true, env: { ADMIN_2FA_REQUIRED: "true" } });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const email = `two-step-extras-${uniq()}@example.test`;
  admin = (await pool.query(
    "INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at) VALUES ($1, $2, 'Admin', true, now()) RETURNING id",
    [email, await bcrypt.hash(PASSWORD, 10)]
  )).rows[0];
  slug = `draft-${uniq()}`;
  await pool.query("INSERT INTO blog_posts (slug, title, body, status) VALUES ($1, $2, '<p>Not yet</p>', 'draft')", [slug, DRAFT_TITLE]);
  threadId = (await pool.query(
    "INSERT INTO forum_threads (title, body, author_id, hidden_at, hidden_reason) VALUES ('Hidden thread title', $1, $2, now(), 'spam') RETURNING id",
    [HIDDEN_BODY, admin.id]
  )).rows[0].id;
  await pool.query("INSERT INTO forum_replies (thread_id, body, author_id, hidden_at, hidden_reason) VALUES ($1, $2, $3, now(), 'spam')", [threadId, HIDDEN_REPLY, admin.id]);

  jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }).toString(),
  });
  jar.capture(res);
  assert.equal(res.status, 302, "the admin logs in with the password (no second factor enrolled yet)");
});
after(async () => {
  await pool.end();
  app.stop();
});

const get = async (p) => {
  const res = await fetch(`${app.base}${p}`, { redirect: "manual", headers: { cookie: jar.header() } });
  jar.capture(res);
  return { status: res.status, text: await res.text(), location: res.headers.get("location") };
};

test("an admin without two-step: requireAdmin pages send to the setup page, and no draft or hidden post is shown", async () => {
  const adminPage = await get("/admin");
  assert.equal(adminPage.status, 302);
  assert.match(adminPage.location, /^\/account\/2fa\?required=1/);
  const draft = await get(`/blog/${slug}?preview=1`);
  assert.equal(draft.status, 404, "the draft is not previewed");
  const feed = JSON.parse((await get("/api/blog/posts?preview=1")).text);
  assert.ok(!feed.some((p) => p.slug === slug), "the feed has no draft");
  const thread = await get(`/forum/${threadId}`);
  assert.equal(thread.status, 200);
  assert.ok(!thread.text.includes(HIDDEN_BODY), "the hidden thread's text is not shown");
  assert.ok(!thread.text.includes(HIDDEN_REPLY), "nor its hidden reply");
});

test("the same admin once enrolled in two-step sees the draft and the hidden posts", async () => {
  await pool.query("UPDATE users SET totp_enabled_at = now() WHERE id = $1", [admin.id]);
  const draft = await get(`/blog/${slug}?preview=1`);
  assert.equal(draft.status, 200);
  assert.ok(draft.text.includes(DRAFT_TITLE));
  const feed = JSON.parse((await get("/api/blog/posts?preview=1")).text);
  assert.ok(feed.some((p) => p.slug === slug));
  const thread = await get(`/forum/${threadId}`);
  assert.ok(thread.text.includes(HIDDEN_BODY));
  assert.ok(thread.text.includes(HIDDEN_REPLY));
});
