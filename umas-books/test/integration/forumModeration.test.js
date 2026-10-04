// Forum moderation (src/routes/admin/forum.js + src/routes/forum.js): an admin
// hides / restores a thread or reply, members see a placeholder, the author
// gets a statement of reasons (EU DSA art. 17) in their language, and an audit
// row records the action without the post text.
// In-process so the mailer can be stubbed. Port 3780 is reserved for this
// file (3780-3789); the in-process harness listens on an ephemeral port.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");
const { untranslated } = require("../helpers/i18nAudit");

const db = prepareDatabase("forum_moderation");

const mailer = require("../../src/mailer");
const sent = [];
let failSends = false;
mailer.sendMail = async (opts) => {
  if (failSends) throw new Error("smtp down");
  sent.push(opts);
};

const { pool } = require("../../src/db");

const FORM = { "content-type": "application/x-www-form-urlencoded" };
const PLACEHOLDER_EN = "This post was removed by the moderators.";
const PLACEHOLDER_FR = "Ce message a été retiré par les modérateurs.";
const SECRET_TITLE = "Buy cheap watches now";
const SECRET_BODY = "SECRET-BODY-TEXT visit my shop for cheap watches";

let server;
let adminId, enAuthor, frAuthor, viewerId;

before(async () => {
  db.create();
  const mk = async (label, lang, extra = {}) => {
    const { rows } = await pool.query(
      "INSERT INTO users (email, password_hash, display_name, is_member, is_admin, lang) VALUES ($1, 'x', $2, true, $3, $4) RETURNING id, email",
      [`${label}-${Date.now()}@example.test`, label, !!extra.admin, lang]
    );
    return rows[0];
  };
  adminId = (await mk("Admin Ann", "en", { admin: true })).id;
  enAuthor = await mk("English Eve", "en");
  frAuthor = await mk("Francoise", "fr");
  viewerId = (await mk("Viewer Vic", "en")).id;
  server = await listen(buildApp([require("../../src/routes/forum"), require("../../src/routes/admin/forum")]));
});
after(async () => {
  await server.close();
  await pool.end();
  db.drop();
});
beforeEach(() => { sent.length = 0; failSends = false; });

const as = (id, extra = {}, lang) => ({
  "x-test-user": JSON.stringify({ id, displayName: "U", isMember: true, ...extra }),
  ...(lang ? { cookie: `umasbooks_lang=${lang}` } : {}),
});
const admin = (lang) => as(adminId, { isAdmin: true }, lang);
const member = (lang) => as(viewerId, {}, lang);

const post = (path, fields, headers) =>
  fetch(`${server.base}${path}`, { method: "POST", redirect: "manual", headers: { ...FORM, ...headers }, body: new URLSearchParams(fields).toString() });
const page = async (path, headers) => (await fetch(`${server.base}${path}`, { headers })).text();

async function newThread(authorId, title = SECRET_TITLE, body = SECRET_BODY) {
  const { rows } = await pool.query("INSERT INTO forum_threads (title, body, author_id) VALUES ($1, $2, $3) RETURNING id", [title, body, authorId]);
  return rows[0].id;
}
async function newReply(threadId, authorId, body) {
  const { rows } = await pool.query("INSERT INTO forum_replies (thread_id, body, author_id) VALUES ($1, $2, $3) RETURNING id", [threadId, body, authorId]);
  return rows[0].id;
}
const hideFields = (kind, id, reason = "spam", note = "") => ({ kind, id: String(id), reason, note });
const auditRows = async (action, targetId) =>
  (await pool.query("SELECT * FROM admin_audit_log WHERE action = $1 AND target_id = $2", [action, targetId])).rows;

test("only an admin can hide: a member is refused and nothing changes", async () => {
  const t = await newThread(enAuthor.id);
  const res = await post("/admin/forum/hide", hideFields("thread", t), member());
  assert.equal(res.status, 403);
  assert.equal((await pool.query("SELECT hidden_at FROM forum_threads WHERE id = $1", [t])).rows[0].hidden_at, null);
  assert.equal(sent.length, 0);
  const res2 = await post("/admin/forum/restore", { kind: "thread", id: String(t) }, member());
  assert.equal(res2.status, 403);
});

test("moderation controls are shown to admins only", async () => {
  const t = await newThread(enAuthor.id);
  assert.match(await page(`/forum/${t}`, admin()), /action="\/admin\/forum\/hide"/);
  assert.doesNotMatch(await page(`/forum/${t}`, member()), /admin\/forum/);
});

test("admin hides a thread: columns set, member sees the placeholder and no text, admin sees the original with the reason and Restore", async () => {
  const t = await newThread(enAuthor.id, "LEAK-TITLE-CHECK", SECRET_BODY);
  const res = await post("/admin/forum/hide", hideFields("thread", t, "illegal", "Please read the rules"), admin());
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `/forum/${t}`);
  const row = (await pool.query("SELECT * FROM forum_threads WHERE id = $1", [t])).rows[0];
  assert.ok(row.hidden_at);
  assert.equal(row.hidden_by, adminId);
  assert.match(row.hidden_reason, /^illegal/);

  const memberPage = await page(`/forum/${t}`, member());
  assert.ok(memberPage.includes(PLACEHOLDER_EN));
  assert.ok(!memberPage.includes("SECRET-BODY-TEXT"));
  assert.ok(!memberPage.includes("LEAK-TITLE-CHECK"));
  assert.ok(!memberPage.includes("action=\"/forum/" + t + "/replies\""), "no reply form on a removed thread");

  const list = await page("/forum", member());
  assert.ok(list.includes(PLACEHOLDER_EN));
  assert.ok(!list.includes("LEAK-TITLE-CHECK"), "title must not leak in the list");
  assert.ok(!list.includes(`/forum/${t}"`), "no link to the removed thread");

  const adminPage = await page(`/forum/${t}`, admin());
  assert.ok(adminPage.includes("SECRET-BODY-TEXT"));
  assert.match(adminPage, /Hidden: Illegal content/);
  assert.match(adminPage, /action="\/admin\/forum\/restore"/);
  assert.match(await page("/forum", admin()), /LEAK-TITLE-CHECK/);
});

test("a member cannot reply to a removed thread", async () => {
  const t = await newThread(enAuthor.id);
  await post("/admin/forum/hide", hideFields("thread", t), admin());
  const res = await post(`/forum/${t}/replies`, { body: "sneaky reply" }, member());
  assert.equal(res.status, 302);
  assert.equal((await pool.query("SELECT COUNT(*) FROM forum_replies WHERE thread_id = $1", [t])).rows[0].count, "0");
});

test("hiding a reply hides only that reply", async () => {
  const t = await newThread(enAuthor.id, "Visible thread", "Visible body");
  const keep = await newReply(t, enAuthor.id, "A polite reply");
  const bad = await newReply(t, frAuthor.id, "REPLY-SECRET rude words");
  const res = await post("/admin/forum/hide", hideFields("reply", bad, "harassment"), admin());
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), `/forum/${t}`);
  const memberPage = await page(`/forum/${t}`, member());
  assert.ok(memberPage.includes("Visible body") && memberPage.includes("A polite reply"));
  assert.ok(memberPage.includes(PLACEHOLDER_EN));
  assert.ok(!memberPage.includes("REPLY-SECRET"));
  const adminPage = await page(`/forum/${t}`, admin());
  assert.ok(adminPage.includes("REPLY-SECRET"));
  assert.match(adminPage, /Hidden: Harassment/);
  assert.ok(keep);
});

test("the author gets a statement of reasons in English, with what, why, who, how to contest and the right to complain", async () => {
  const t = await newThread(enAuthor.id);
  await post("/admin/forum/hide", hideFields("thread", t, "spam", "No adverts please"), admin());
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.to, enAuthor.email);
  assert.equal(m.replyTo, "admin@umasbooks.org");
  assert.match(m.subject, /removed from the Uma's Books forum/);
  assert.ok(m.text.includes(SECRET_TITLE), "names what was removed (thread title)");
  assert.match(m.text, /Reason: Spam/);
  assert.match(m.text, /No adverts please/);
  assert.match(m.text, /moderators/);
  assert.match(m.text, /admin@umasbooks\.org/);
  assert.match(m.text, /review the decision/);
  assert.match(m.text, /complaint/);
});

test("the author's language is used: French", async () => {
  const t = await newThread(frAuthor.id);
  const r = await newReply(t, frAuthor.id, "x".repeat(150));
  await post("/admin/forum/hide", hideFields("reply", r, "harassment"), admin());
  assert.equal(sent.length, 1);
  const m = sent[0];
  assert.equal(m.to, frAuthor.email);
  assert.match(m.subject, /a été retiré du forum/);
  assert.match(m.text, /Motif : Harcèlement/);
  assert.match(m.text, /modérateurs/);
  assert.match(m.text, /plainte/);
  assert.ok(m.text.includes(`"${"x".repeat(100)}"`) && !m.text.includes("x".repeat(101)), "first 100 characters of a reply");
});

test("audit rows record kind and reason code only, never the post text or note", async () => {
  const t = await newThread(enAuthor.id);
  await post("/admin/forum/hide", hideFields("thread", t, "illegal", "PRIVATE-NOTE"), admin());
  await post("/admin/forum/restore", { kind: "thread", id: String(t) }, admin());
  const [hide] = await auditRows("forum.hide", t);
  const [restore] = await auditRows("forum.restore", t);
  assert.ok(hide && restore);
  assert.equal(hide.actor_user_id, adminId);
  assert.equal(hide.detail, "thread illegal");
  for (const r of [hide, restore]) {
    const blob = JSON.stringify(r);
    assert.ok(!blob.includes("SECRET-BODY-TEXT") && !blob.includes(SECRET_TITLE) && !blob.includes("PRIVATE-NOTE"));
  }
});

test("restore makes the text visible again and clears the columns", async () => {
  const t = await newThread(enAuthor.id);
  await post("/admin/forum/hide", hideFields("thread", t), admin());
  const res = await post("/admin/forum/restore", { kind: "thread", id: String(t) }, admin());
  assert.equal(res.status, 302);
  const row = (await pool.query("SELECT * FROM forum_threads WHERE id = $1", [t])).rows[0];
  assert.equal(row.hidden_at, null);
  assert.equal(row.hidden_reason, null);
  assert.equal(row.hidden_by, null);
  assert.ok((await page(`/forum/${t}`, member())).includes("SECRET-BODY-TEXT"));
});

test("hiding twice emails the author once", async () => {
  const t = await newThread(enAuthor.id);
  await post("/admin/forum/hide", hideFields("thread", t), admin());
  await post("/admin/forum/hide", hideFields("thread", t, "other"), admin());
  assert.equal(sent.length, 1);
});

test("unknown targets and bad input: 404 / 400, and no email", async () => {
  assert.equal((await post("/admin/forum/hide", hideFields("thread", 999999), admin())).status, 404);
  assert.equal((await post("/admin/forum/hide", hideFields("reply", 999999), admin())).status, 404);
  assert.equal((await post("/admin/forum/hide", hideFields("thread", "abc"), admin())).status, 404);
  assert.equal((await post("/admin/forum/hide", hideFields("post", 1), admin())).status, 404);
  assert.equal((await post("/admin/forum/restore", { kind: "thread", id: "999999" }, admin())).status, 404);
  const t = await newThread(enAuthor.id);
  assert.equal((await post("/admin/forum/hide", hideFields("thread", t, "nonsense"), admin())).status, 400);
  assert.equal((await pool.query("SELECT hidden_at FROM forum_threads WHERE id = $1", [t])).rows[0].hidden_at, null);
  assert.equal(sent.length, 0);
});

test("an erased author (no account) is skipped silently; a failed send does not block the hide", async () => {
  const gone = await newThread(null);
  const res = await post("/admin/forum/hide", hideFields("thread", gone), admin());
  assert.equal(res.status, 302);
  assert.ok((await pool.query("SELECT hidden_at FROM forum_threads WHERE id = $1", [gone])).rows[0].hidden_at);
  assert.equal(sent.length, 0);

  failSends = true;
  const t = await newThread(enAuthor.id);
  const res2 = await post("/admin/forum/hide", hideFields("thread", t), admin());
  assert.equal(res2.status, 302);
  assert.ok((await pool.query("SELECT hidden_at FROM forum_threads WHERE id = $1", [t])).rows[0].hidden_at);
  assert.equal((await auditRows("forum.hide", t)).length, 1);
});

test("a hidden-post thread page has no untranslated text in French vs English", async () => {
  const t = await newThread(enAuthor.id, "Seeded title", "Seeded body");
  await newReply(t, enAuthor.id, "Seeded visible reply");
  const bad = await newReply(t, enAuthor.id, "Seeded hidden reply");
  await post("/admin/forum/hide", hideFields("reply", bad), admin());
  const allow = ["Seeded title", "Seeded body", "Seeded visible reply", /^(English Eve|U|Forum)$/];
  const en = await page(`/forum/${t}`, member("en"));
  const fr = await page(`/forum/${t}`, member("fr"));
  assert.ok(fr.includes(PLACEHOLDER_FR));
  assert.deepEqual(untranslated(en, fr, allow), []);

  const t2 = await newThread(enAuthor.id);
  await post("/admin/forum/hide", hideFields("thread", t2), admin());
  const en2 = await page(`/forum/${t2}`, member("en"));
  const fr2 = await page(`/forum/${t2}`, member("fr"));
  assert.ok(fr2.includes(PLACEHOLDER_FR));
  assert.deepEqual(untranslated(en2, fr2, allow), []);
  const listEn = await page("/forum", member("en"));
  const listFr = await page("/forum", member("fr"));
  assert.ok(listFr.includes(PLACEHOLDER_FR));
  // In CI every test file shares one database, so the list also shows threads
  // written by OTHER test files: member-written text is data, the same in both
  // languages. Allow every stored title/body, not just this file's.
  const { rows: userText } = await pool.query(
    "SELECT title AS t FROM forum_threads UNION ALL SELECT body FROM forum_threads UNION ALL SELECT body FROM forum_replies");
  const stored = new Set(userText.map((r) => String(r.t).trim()));
  const listAllow = [
    /^(English Eve|Francoise|Admin Ann|Member|Forum)$/,
    /^(Buy cheap watches now|Seeded title|Visible thread)$/,
    ...stored,
  ];
  assert.deepEqual(untranslated(listEn, listFr, listAllow), []);
});
