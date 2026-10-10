// Member dashboard + announcements (src/routes/dashboard.js) and the
// charity vote / idea routes (src/routes/charity.js) against the real app:
// who may see what, which announcements are live, round visibility and
// results rules, single vs multiple choice voting, closed/inactive rounds,
// idea validation and escaping.
//
// Own throwaway database (isolated:true): the "active charity round" and
// "top 3 live announcements" are global queries, so these tests reset that
// state themselves, which would race with other files on a shared database.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3582;
const PASSWORD = "CharityDash1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app;
let pool;
let member;
let volunteer;
let admin;
let plain;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  member = await makeUser({ member: true, name: "Marie <b>Member</b>" });
  volunteer = await makeUser({ member: true, volunteer: true });
  admin = await makeUser({ admin: true });
  plain = await makeUser({});
});
after(async () => {
  await pool.end();
  await app.stop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function makeUser({ member = false, volunteer = false, admin = false, name = "Dash User" }) {
  const email = `cd-${uniq()}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_member, is_volunteer, is_admin, email_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10), name, member, volunteer, admin]
  );
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }).toString(),
  });
  jar.capture(res);
  assert.equal(res.status, 302, "test user can log in");
  return { id: rows[0].id, jar };
}

async function get(who, path) {
  const res = await fetch(`${app.base}${path}`, { redirect: "manual", headers: who ? { cookie: who.jar.header() } : {} });
  return { res, status: res.status, location: res.headers.get("location"), text: await res.text() };
}
async function post(who, path, fields) {
  const jar = who ? who.jar : makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: formBody({ ...fields, _csrf: token }),
  });
  return { res, status: res.status, location: res.headers.get("location"), text: await res.text() };
}
// Array values become repeated fields (what a multi-checkbox form sends).
function formBody(fields) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const x of [].concat(v)) body.append(k, String(x));
  return body.toString();
}

// ---------------------------------------------------------------- announcements

const HOUR = 3600 * 1000;
async function makeAnnouncement({ title, status = "published", at = new Date(Date.now() - HOUR), expires = null, pinned = false, excerpt = null }) {
  const t = title || `Ann ${uniq()}`;
  await pool.query(
    "INSERT INTO announcements (title, body, status, published_at, expires_at, is_pinned, excerpt) VALUES ($1, '<p>Body text</p>', $2, $3, $4, $5, $6)",
    [t, status, at, expires, pinned, excerpt]
  );
  return t;
}

test("dashboard: guests go to the membership page, non-members get the 'for members' page (403)", async () => {
  const anon = await get(null, "/dashboard");
  assert.equal(anon.status, 302);
  assert.equal(anon.location, "/membership.html");
  const nm = await get(plain, "/dashboard");
  assert.equal(nm.status, 403);
  assert.match(nm.text, /This area is for members/);
});

test("dashboard: member, volunteer and admin get the page; display name is escaped", async () => {
  for (const u of [member, volunteer, admin]) {
    const r = await get(u, "/dashboard");
    assert.equal(r.status, 200);
    assert.match(r.text, /Welcome back,/);
  }
  const { text } = await get(member, "/dashboard");
  assert.ok(!text.includes("Marie <b>Member</b>"));
  assert.match(text, /Marie &lt;b&gt;Member&lt;\/b&gt;/);
  for (const href of ['href="/forum"', 'href="/meetings"', 'href="/announcements"', 'href="/account/password"']) {
    assert.ok(text.includes(href), href);
  }
});

test("dashboard: the volunteer card is shown to volunteers and admins only; the Admin link to admins only", async () => {
  const m = (await get(member, "/dashboard")).text;
  assert.ok(!m.includes('href="/volunteer"') && !m.includes('href="/admin"'));
  const v = (await get(volunteer, "/dashboard")).text;
  assert.ok(v.includes('href="/volunteer"'));
  assert.ok(!v.includes('href="/admin"'));
  const a = (await get(admin, "/dashboard")).text;
  assert.ok(a.includes('href="/volunteer"') && a.includes('href="/admin"'));
});

test("dashboard: announcements show only live ones; pinned first; at most 3; titles and excerpts escaped", async () => {
  await pool.query("UPDATE announcements SET status = 'draft'");
  const live1 = await makeAnnouncement({ at: new Date(Date.now() - 1 * HOUR) });
  const live2 = await makeAnnouncement({ at: new Date(Date.now() - 2 * HOUR) });
  const live3 = await makeAnnouncement({ at: new Date(Date.now() - 3 * HOUR) });
  await makeAnnouncement({ at: new Date(Date.now() - 50 * HOUR), pinned: true, title: `<em>Pinned</em> ${uniq()}`, excerpt: "<u>ex</u>" });
  const draft = await makeAnnouncement({ status: "draft" });
  const future = await makeAnnouncement({ at: new Date(Date.now() + 5 * HOUR) });
  const expired = await makeAnnouncement({ expires: new Date(Date.now() - HOUR) });
  const scheduledPast = await makeAnnouncement({ status: "scheduled", at: new Date(Date.now() - 10 * 60 * 1000) });

  const { text } = await get(member, "/dashboard");
  // Order: pinned, then newest: scheduledPast (10 min ago), live1.
  assert.ok(text.includes("&lt;em&gt;Pinned&lt;/em&gt;"), "pinned leads despite its age");
  assert.ok(!text.includes("<em>Pinned</em>"));
  assert.ok(text.includes("&lt;u&gt;ex&lt;/u&gt;") && !text.includes("<u>ex</u>"));
  assert.ok(text.includes(scheduledPast), "a scheduled post whose time has passed is live");
  assert.ok(text.includes(live1));
  for (const hidden of [live2, live3, draft, future, expired]) assert.ok(!text.includes(hidden), `${hidden} must not be on the dashboard`);
  assert.ok(text.indexOf("Pinned") < text.indexOf(scheduledPast) && text.indexOf(scheduledPast) < text.indexOf(live1));

  // /announcements is members-only and lists more than 3 live ones.
  assert.equal((await get(null, "/announcements")).location, "/login?returnTo=%2Fannouncements");
  assert.equal((await get(plain, "/announcements")).status, 403);
  const all = await get(volunteer, "/announcements");
  assert.equal(all.status, 200);
  for (const shown of [live1, live2, live3, scheduledPast]) assert.ok(all.text.includes(shown));
  for (const hidden of [draft, future, expired]) assert.ok(!all.text.includes(hidden));
});

test("announcements page with nothing live says so", async () => {
  await pool.query("UPDATE announcements SET status = 'draft'");
  const { status, text } = await get(member, "/announcements");
  assert.equal(status, 200);
  assert.ok(!text.includes("dash-ann-item"));
});

// --------------------------------------------------------------- charity round

async function makeRound({ allowMultiple = false, visibleTo = "members", showResults = false, opensAt = new Date(Date.now() - HOUR), closesAt = null, active = true, options = 3 } = {}) {
  await pool.query("UPDATE charity_rounds SET is_active = FALSE");
  const { rows } = await pool.query(
    `INSERT INTO charity_rounds (title, opens_at, closes_at, is_active, allow_multiple, visible_to, show_results_during_vote)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [`Round ${uniq()}`, opensAt, closesAt, active, allowMultiple, visibleTo, showResults]
  );
  const roundId = rows[0].id;
  const optionIds = [];
  for (let i = 0; i < options; i++) {
    const o = await pool.query("INSERT INTO charity_options (round_id, name, description) VALUES ($1, $2, $3) RETURNING id", [roundId, `Option ${i} ${uniq()}`, `<b>desc ${i}</b>`]);
    optionIds.push(o.rows[0].id);
  }
  return { roundId, optionIds };
}
const myVotes = async (userId, roundId) =>
  (await pool.query("SELECT option_id FROM charity_votes WHERE user_id = $1 AND round_id = $2 ORDER BY option_id", [userId, roundId])).rows.map((r) => r.option_id);

beforeEach(async () => { await pool.query("UPDATE charity_rounds SET is_active = FALSE"); });

test("dashboard charity panel: 'no vote open' without an active round, 'Vote Now' with one", async () => {
  const none = await get(member, "/dashboard");
  assert.match(none.text, /No vote open right now/);
  await makeRound();
  const some = await get(member, "/dashboard");
  assert.match(some.text, /Vote on Our Next Charity/);
  assert.ok(some.text.includes('href="/charity"'));
});

test("GET /charity: no round or a members-only round turns people away (anon -> /login, non-member -> 403 page)", async () => {
  assert.equal((await get(null, "/charity")).location, "/login?returnTo=%2Fcharity");
  assert.equal((await get(plain, "/charity")).status, 403);
  await makeRound({ visibleTo: "members" });
  assert.equal((await get(null, "/charity")).location, "/login?returnTo=%2Fcharity");
  assert.equal((await get(plain, "/charity")).status, 403);
  assert.equal((await get(member, "/charity")).status, 200);
});

test("GET /charity: a round visible to everyone is readable anonymously without the vote form", async () => {
  const { optionIds } = await makeRound({ visibleTo: "everyone", showResults: true });
  const anon = await get(null, "/charity");
  assert.equal(anon.status, 200);
  assert.ok(!anon.text.includes('name="optionIds"'), "no voting controls for a non-member");
  assert.match(anon.text, /0 votes/);
  const plainUser = await get(plain, "/charity");
  assert.equal(plainUser.status, 200);
  assert.ok(!plainUser.text.includes('name="optionIds"'));
  const m = await get(member, "/charity");
  assert.ok(m.text.includes(`value="${optionIds[0]}"`));
  assert.match(m.text, /type="radio"/);
  assert.ok(!m.text.includes("<b>desc 0</b>"), "option description escaped");
});

test("GET /charity: results are hidden while voting unless enabled, shown once the round has closed", async () => {
  await makeRound({ showResults: false });
  assert.ok(!(await get(member, "/charity")).text.includes("vote-bar"));
  await makeRound({ showResults: true, allowMultiple: true });
  const shown = await get(member, "/charity");
  assert.ok(shown.text.includes("vote-bar"));
  assert.match(shown.text, /type="checkbox"/);
  assert.match(shown.text, /select multiple charities/);
  await makeRound({ showResults: false, opensAt: new Date(Date.now() - 3 * HOUR), closesAt: new Date(Date.now() - HOUR) });
  assert.ok((await get(member, "/charity")).text.includes("vote-bar"), "closed round shows results");
});

// ----------------------------------------------------------------- voting

test("vote: non-members and anonymous cannot vote", async () => {
  const { roundId, optionIds } = await makeRound();
  assert.equal((await post(null, "/charity/vote", { optionIds: String(optionIds[0]) })).location, "/login");
  assert.equal((await post(plain, "/charity/vote", { optionIds: String(optionIds[0]) })).location, "/");
  assert.deepEqual(await myVotes(plain.id, roundId), []);
});

test("vote: single-choice keeps the first valid choice and re-voting replaces it; unknown option ids are ignored", async () => {
  const { roundId, optionIds } = await makeRound({ allowMultiple: false });
  const other = await makeRound({ allowMultiple: false });
  await pool.query("UPDATE charity_rounds SET is_active = FALSE WHERE id = $1", [other.roundId]);
  await pool.query("UPDATE charity_rounds SET is_active = TRUE WHERE id = $1", [roundId]);

  const r = await post(member, "/charity/vote", { optionIds: [String(optionIds[0]), String(optionIds[1])] });
  assert.equal(r.status, 302);
  assert.equal(r.location, "/charity");
  assert.deepEqual(await myVotes(member.id, roundId), [optionIds[0]]);
  await post(member, "/charity/vote", { optionIds: String(optionIds[2]) });
  assert.deepEqual(await myVotes(member.id, roundId), [optionIds[2]]);
  // An option belonging to another round, and garbage, are filtered out (vote cleared).
  await post(member, "/charity/vote", { optionIds: [String(other.optionIds[0]), "abc"] });
  assert.deepEqual(await myVotes(member.id, roundId), []);
});

test("vote: multiple-choice stores every distinct valid choice once", async () => {
  const { roundId, optionIds } = await makeRound({ allowMultiple: true });
  const res = await post(volunteer, "/charity/vote", { optionIds: [optionIds[0], optionIds[1], optionIds[1]] });
  assert.equal(res.status, 302);
  assert.deepEqual(await myVotes(volunteer.id, roundId), [optionIds[0], optionIds[1]]);
  const page = await get(volunteer, "/charity");
  assert.match(page.text, /checked/);
});

test("vote: a closed, not-yet-open or no-longer-active round leaves existing votes untouched", async () => {
  const { roundId, optionIds } = await makeRound();
  await post(admin, "/charity/vote", { optionIds: String(optionIds[0]) });
  assert.deepEqual(await myVotes(admin.id, roundId), [optionIds[0]]);

  await pool.query("UPDATE charity_rounds SET closes_at = now() - interval '1 minute' WHERE id = $1", [roundId]);
  await post(admin, "/charity/vote", { optionIds: String(optionIds[1]) });
  assert.deepEqual(await myVotes(admin.id, roundId), [optionIds[0]], "closed");

  await pool.query("UPDATE charity_rounds SET closes_at = NULL, opens_at = now() + interval '1 hour' WHERE id = $1", [roundId]);
  await post(admin, "/charity/vote", { optionIds: String(optionIds[1]) });
  assert.deepEqual(await myVotes(admin.id, roundId), [optionIds[0]], "not yet open");

  await pool.query("UPDATE charity_rounds SET is_active = FALSE WHERE id = $1", [roundId]);
  const noRound = await post(admin, "/charity/vote", { optionIds: String(optionIds[1]) });
  assert.equal(noRound.location, "/charity");
  assert.deepEqual(await myVotes(admin.id, roundId), [optionIds[0]], "inactive");
});

// ------------------------------------------------------------------ ideas

const ideasFor = async (userId) => (await pool.query("SELECT * FROM charity_ideas WHERE submitted_by = $1 ORDER BY id", [userId])).rows;

test("ideas: only members can submit; a valid idea is stored with a whitelisted category and an http(s) URL", async () => {
  const u = await makeUser({ member: true });
  assert.equal((await post(null, "/charity/ideas", { name: "X" })).location, "/login");
  assert.equal((await post(plain, "/charity/ideas", { name: "X" })).location, "/");
  assert.deepEqual(await ideasFor(plain.id), []);

  const r = await post(u, "/charity/ideas", { name: "  Save the Bees  ", description: " Pollinators ", category: "Environment", websiteUrl: "https://bees.example.test/x" });
  assert.equal(r.status, 302);
  assert.equal(r.location, "/charity");
  const [idea] = await ideasFor(u.id);
  assert.equal(idea.name, "Save the Bees");
  assert.equal(idea.description, "Pollinators");
  assert.equal(idea.category, "Environment");
  assert.equal(idea.website_url, "https://bees.example.test/x");
  assert.equal(idea.status, "pending");
});

test("ideas: blank name stores nothing; unknown category and non-http URLs are dropped; long text is capped", async () => {
  const u = await makeUser({ member: true });
  await post(u, "/charity/ideas", { name: "   ", description: "nope" });
  assert.equal((await ideasFor(u.id)).length, 0);
  await post(u, "/charity/ideas", { name: "Odd", category: "Not A Category", websiteUrl: "javascript:alert(1)" });
  await post(u, "/charity/ideas", { name: "N".repeat(400), description: "D".repeat(3000), websiteUrl: "ftp://x.example.test" });
  const [odd, long] = await ideasFor(u.id);
  assert.equal(odd.category, null);
  assert.equal(odd.website_url, null);
  assert.equal(odd.description, null);
  assert.equal(long.name.length, 150);
  assert.equal(long.description.length, 1000);
  assert.equal(long.website_url, null);
});

test("ideas: a member's own recent ideas are listed on /charity with escaping and a status label", async () => {
  const u = await makeUser({ member: true });
  await makeRound();
  await post(u, "/charity/ideas", { name: "<script>alert('i')</script>" });
  const page = await get(u, "/charity");
  assert.ok(!page.text.includes("<script>alert('i')"));
  assert.match(page.text, /&lt;script&gt;alert\(&#39;i&#39;\)&lt;\/script&gt;/);
  assert.match(page.text, /Pending review/);
  await pool.query("UPDATE charity_ideas SET status = 'approved' WHERE submitted_by = $1", [u.id]);
  assert.match((await get(u, "/charity")).text, /Approved/);
  await pool.query("UPDATE charity_ideas SET status = 'rejected' WHERE submitted_by = $1", [u.id]);
  assert.match((await get(u, "/charity")).text, /Not selected/);
  const others = await get(member, "/charity");
  assert.ok(!others.text.includes("alert(&#39;i&#39;)"), "other members' ideas are private");
});
