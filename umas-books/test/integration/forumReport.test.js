// "Report this post" (src/routes/forum.js POST /forum/report): members only,
// validated, rate limited per member, emails the administrators.
// In-process so sendMail can be stubbed (forum.js destructures it at require time).
// Port range 3650-3659 is reserved for this file; the in-process harness
// listens on an ephemeral port, so none is actually needed.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");

const db = prepareDatabase("forum_report");

const mailer = require("../../src/mailer");
const sent = [];
mailer.sendMail = async (opts) => { sent.push(opts); };

const { pool } = require("../../src/db");

let server;
let memberId;
let threadId;
let replyId;
const FORM = { "content-type": "application/x-www-form-urlencoded" };

before(async () => {
  db.create();
  const { rows: u } = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, is_member) VALUES ($1, 'x', 'Reporter Rita', true) RETURNING id",
    [`report-${Date.now()}@example.test`]
  );
  memberId = u[0].id;
  const { rows: t } = await pool.query(
    "INSERT INTO forum_threads (title, body, author_id) VALUES ('Hello', $1, $2) RETURNING id",
    ["T".repeat(400), memberId]
  );
  threadId = t[0].id;
  const { rows: r } = await pool.query(
    "INSERT INTO forum_replies (thread_id, body, author_id) VALUES ($1, 'nasty reply text', $2) RETURNING id",
    [threadId, memberId]
  );
  replyId = r[0].id;
  server = await listen(buildApp([require("../../src/routes/forum")]));
});
after(async () => {
  await server.close();
  await pool.end();
  db.drop();
});
beforeEach(() => { sent.length = 0; });

const member = () => ({ "x-test-user": JSON.stringify({ id: memberId, displayName: "Reporter Rita", isMember: true }) });
const report = (fields, headers = member()) =>
  fetch(`${server.base}/forum/report`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, ...headers },
    body: new URLSearchParams(fields).toString(),
  });
const good = () => ({ kind: "thread", id: String(threadId), reason: "spam", comment: "looks like an ad" });

test("thread pages offer a Report form for the thread and each reply, and the forum explains where reports go", async () => {
  const page = await (await fetch(`${server.base}/forum/${threadId}`, { headers: member() })).text();
  assert.equal((page.match(/action="\/forum\/report"/g) || []).length, 2);
  assert.match(page, /name="kind" value="reply"/);
  const list = await (await fetch(`${server.base}/forum`, { headers: member() })).text();
  assert.match(list, /administrators/);
});

test("a member can report a thread: email goes to the admin address with reporter, reason, comment, link and 300-char excerpt", async () => {
  process.env.APP_BASE_URL = "https://umas.example.test";
  try {
    const res = await report(good());
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), `/forum/${threadId}?reported=1`);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, process.env.CONTACT_TO || "admin@umasbooks.org");
    const t = sent[0].text;
    assert.match(t, /Reporter Rita/);
    assert.match(t, /Reason: Spam/);
    assert.match(t, /looks like an ad/);
    assert.ok(t.includes(`https://umas.example.test/forum/${threadId}`));
    assert.ok(t.includes("T".repeat(300)) && !t.includes("T".repeat(301)));
    const notice = await (await fetch(`${server.base}/forum/${threadId}?reported=1`, { headers: member() })).text();
    assert.match(notice, /Thanks, we will review it/);
  } finally {
    delete process.env.APP_BASE_URL;
  }
});

test("a member can report a reply; with no base URL the link is omitted", async () => {
  const saved = { a: process.env.APP_BASE_URL, r: process.env.RENDER_EXTERNAL_URL, n: process.env.NODE_ENV };
  delete process.env.APP_BASE_URL;
  delete process.env.RENDER_EXTERNAL_URL;
  process.env.NODE_ENV = "production";
  try {
    const res = await report({ kind: "reply", id: String(replyId), reason: "harassment" });
    assert.equal(res.status, 302);
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /nasty reply text/);
    assert.doesNotMatch(sent[0].text, /http/);
  } finally {
    if (saved.a !== undefined) process.env.APP_BASE_URL = saved.a;
    if (saved.r !== undefined) process.env.RENDER_EXTERNAL_URL = saved.r;
    if (saved.n === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = saved.n;
  }
});

test("non-members and logged-out visitors cannot report", async () => {
  const plain = await report(good(), { "x-test-user": JSON.stringify({ id: memberId, isMember: false }) });
  assert.equal(plain.status, 302);
  assert.equal(plain.headers.get("location"), "/");
  const anon = await report(good(), {});
  assert.equal(anon.headers.get("location"), "/login");
  assert.equal(sent.length, 0);
});

test("bad ids, kinds and reasons are refused and send nothing", async () => {
  assert.equal((await report({ ...good(), id: "abc" })).status, 404);
  assert.equal((await report({ ...good(), id: "999999" })).status, 404);
  assert.equal((await report({ ...good(), kind: "reply", id: "999999" })).status, 404);
  assert.equal((await report({ ...good(), kind: "user" })).status, 404);
  assert.equal((await report({ ...good(), reason: "dislike" })).status, 400);
  assert.equal(sent.length, 0);
});

test("comment is capped at 1000 characters", async () => {
  await report({ ...good(), comment: "c".repeat(1500) });
  assert.equal(sent.length, 1);
  assert.ok(sent[0].text.includes("c".repeat(1000)) && !sent[0].text.includes("c".repeat(1001)));
});

test("rate limit: the 11th report in an hour from one member gets 429", async () => {
  // Earlier tests in this file already used some of this member's budget.
  let status;
  for (let i = 0; i < 12; i++) {
    status = (await report(good())).status;
    if (status === 429) break;
  }
  assert.equal(status, 429);
  // A different member is unaffected.
  const { rows } = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, is_member) VALUES ($1, 'x', 'Other', true) RETURNING id",
    [`other-${Date.now()}@example.test`]
  );
  const res = await report(good(), { "x-test-user": JSON.stringify({ id: rows[0].id, displayName: "Other", isMember: true }) });
  assert.equal(res.status, 302);
});
