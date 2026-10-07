// Members' forum (src/routes/forum.js) against the real app: only members
// (or volunteers/admins) can read or post, happy-path thread + reply,
// validation failures, and escaping of user-supplied text.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3481;
const PASSWORD = "ForumTest1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app;
let pool;
let memberJar;
let memberId;
let plainJar;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const member = await createUser({ member: true, name: "Forum Member" });
  memberId = member.id;
  memberJar = await loginJar(member.email);
  plainJar = await loginJar((await createUser({})).email);
});

after(async () => {
  await pool.end();
  app.stop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function createUser({ member = false, name = "Forum Test" }) {
  const email = `forum-${uniq()}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_member, email_verified_at)
     VALUES ($1, $2, $3, $4, now()) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10), name, member]
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
  assert.equal(res.status, 302);
  return jar;
}

async function get(jar, path) {
  const res = await fetch(`${app.base}${path}`, { redirect: "manual", headers: { cookie: jar.header() } });
  return { res, text: await res.text() };
}

async function post(jar, path, fields) {
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });
  return { res, text: await res.text() };
}

const threadCount = async () => Number((await pool.query("SELECT COUNT(*) FROM forum_threads")).rows[0].count);
const replyCount = async () => Number((await pool.query("SELECT COUNT(*) FROM forum_replies")).rows[0].count);

test("guests are sent to /login for every forum page and cannot post", async () => {
  const anon = makeCookieJar();
  const threadsBefore = await threadCount();
  for (const p of ["/forum", "/forum/new", "/forum/1"]) {
    const { res } = await get(anon, p);
    assert.equal(res.status, 302, p);
    assert.equal(res.headers.get("location"), "/login", p);
  }
  for (const [p, f] of [["/forum/new", { title: "Hi", body: "There" }], ["/forum/1/replies", { body: "Hi" }]]) {
    const { res } = await post(anon, p, f);
    assert.equal(res.status, 302, p);
    assert.equal(res.headers.get("location"), "/login", p);
  }
  assert.equal(await threadCount(), threadsBefore);
});

test("a logged-in NON-member can't read or post to the forum", async () => {
  const threadsBefore = await threadCount();
  const repliesBefore = await replyCount();
  for (const p of ["/forum", "/forum/new", "/forum/1"]) {
    const { res } = await get(plainJar, p);
    assert.equal(res.status, 302, p);
    assert.equal(res.headers.get("location"), "/", p);
  }
  const t = await post(plainJar, "/forum/new", { title: "Sneaky", body: "Not a member" });
  assert.equal(t.res.status, 302);
  assert.equal(t.res.headers.get("location"), "/");
  const r = await post(plainJar, "/forum/1/replies", { body: "Sneaky reply" });
  assert.equal(r.res.headers.get("location"), "/");
  assert.equal(await threadCount(), threadsBefore);
  assert.equal(await replyCount(), repliesBefore);
});

test("member happy path: post a thread (trimmed, attributed), view it, reply, see the reply", async () => {
  const form = await get(memberJar, "/forum/new");
  assert.equal(form.res.status, 200);

  const title = `Book club picks ${uniq()}`;
  const created = await post(memberJar, "/forum/new", { title: `  ${title}  `, body: "  What should we read next?  " });
  assert.equal(created.res.status, 302);
  const m = created.res.headers.get("location").match(/^\/forum\/(\d+)$/);
  assert.ok(m, `unexpected redirect ${created.res.headers.get("location")}`);
  const threadId = Number(m[1]);

  const { rows } = await pool.query("SELECT title, body, author_id FROM forum_threads WHERE id = $1", [threadId]);
  assert.deepEqual(rows[0], { title, body: "What should we read next?", author_id: memberId });

  const list = await get(memberJar, "/forum");
  assert.equal(list.res.status, 200);
  assert.ok(list.text.includes(title));

  const reply = await post(memberJar, `/forum/${threadId}/replies`, { body: "  The Overstory!  " });
  assert.equal(reply.res.status, 302);
  assert.equal(reply.res.headers.get("location"), `/forum/${threadId}`);

  const page = await get(memberJar, `/forum/${threadId}`);
  assert.equal(page.res.status, 200);
  assert.ok(page.text.includes(title));
  assert.ok(page.text.includes("What should we read next?"));
  assert.ok(page.text.includes("The Overstory!"));
  assert.ok(page.text.includes("Forum Member"), "author display name shown");
  const { rows: replies } = await pool.query("SELECT body, author_id FROM forum_replies WHERE thread_id = $1", [threadId]);
  assert.deepEqual(replies, [{ body: "The Overstory!", author_id: memberId }]);
});

test("new-thread validation: missing or whitespace-only title/body -> 303 back to the form with an error, nothing saved", async () => {
  const before = await threadCount();
  for (const fields of [{ title: "", body: "x" }, { title: "x", body: "" }, { title: "   ", body: "   " }, {}]) {
    // Refused with 303 back to the form (Post/Redirect/Get); the error shows on that page, once.
    const { res } = await post(memberJar, "/forum/new", fields);
    assert.equal(res.status, 303, JSON.stringify(fields));
    assert.equal(res.headers.get("location"), "/forum/new");
    const shown = await get(memberJar, "/forum/new");
    assert.equal(shown.res.status, 200);
    assert.match(shown.text, /Title and message are both required/);
    if (fields.title && fields.title.trim()) assert.ok(shown.text.includes(`value="${fields.title}"`), "typed title kept");
    const reloaded = await get(memberJar, "/forum/new");
    assert.doesNotMatch(reloaded.text, /Title and message are both required/, "the message shows only once");
  }
  assert.equal(await threadCount(), before);
});

test("an empty reply is ignored (redirects back, nothing saved)", async () => {
  const { rows } = await pool.query("INSERT INTO forum_threads (title, body, author_id) VALUES ('T', 'B', $1) RETURNING id", [memberId]);
  const before = await replyCount();
  const { res } = await post(memberJar, `/forum/${rows[0].id}/replies`, { body: "   " });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `/forum/${rows[0].id}`);
  assert.equal(await replyCount(), before);
});

test("thread and reply text is HTML-escaped on output", async () => {
  const payload = `<script>alert("x${uniq()}")</script>`;
  const { rows } = await pool.query("INSERT INTO forum_threads (title, body, author_id) VALUES ($1, $1, $2) RETURNING id", [payload, memberId]);
  await post(memberJar, `/forum/${rows[0].id}/replies`, { body: payload });
  const page = await get(memberJar, `/forum/${rows[0].id}`);
  assert.ok(!page.text.includes(payload), "raw script tag must not appear");
  assert.ok(page.text.includes("&lt;script&gt;"));
});

test("an unknown thread id is a 404 for a member", async () => {
  const { res, text } = await get(memberJar, "/forum/987654321");
  assert.equal(res.status, 404);
  assert.match(text, /Thread not found/);
});

test("a non-numeric thread id is a clean 404, not a server error", async () => {
  const { res } = await get(memberJar, "/forum/abc");
  assert.equal(res.status, 404);
});

test("replying to a thread that doesn't exist is a clean 404, not a server error", async () => {
  const { res } = await post(memberJar, "/forum/987654321/replies", { body: "orphan" });
  assert.equal(res.status, 404);
});
