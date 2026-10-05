// Members' meetings calendar (src/routes/meetings.js) and the volunteer
// shift calendar (src/routes/volunteer.js): role guards, calendar month /
// week rendering, RSVP + sign-up toggles, capacity, unknown ids and escaping.
//
// In-process harness; rows are seeded in fixed far-future months so nothing
// another test file inserts can land in the same calendar window.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
// Production loads this before any router (src/index.js); without it a
// rejected async handler hangs the request instead of reaching the 500 handler.
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");
const { makeClient, makeUser, uniq } = require("../helpers/routeClient");

const db = prepareDatabase("meet_vol", { isolated: true });
const { pool } = require("../../src/db");

let server;
let c;
let member;
let volunteer;
let admin;
let plain;

// Midday UTC keeps the calendar day stable in any server timezone.
const noon = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 12, 0, 0));

before(async () => {
  db.create();
  server = await listen(buildApp([require("../../src/routes/meetings"), require("../../src/routes/volunteer")]));
  c = makeClient(server.base);
  member = await makeUser(pool, { member: true });
  volunteer = await makeUser(pool, { member: true, volunteer: true });
  admin = await makeUser(pool, { admin: true });
  plain = await makeUser(pool, {});
});
after(async () => {
  await server.close();
  await pool.end();
  db.drop();
});

async function makeMeeting(at, extra = {}) {
  const title = extra.title || `Meeting ${uniq()}`;
  const { rows } = await pool.query(
    "INSERT INTO meetings (title, scheduled_at, location, agenda) VALUES ($1, $2, $3, $4) RETURNING id",
    [title, at, extra.location || "Back room", extra.agenda || null]
  );
  return { id: rows[0].id, title };
}
const rsvpCount = async (id) => Number((await pool.query("SELECT COUNT(*) FROM meeting_rsvps WHERE meeting_id = $1", [id])).rows[0].count);

// ---------------------------------------------------------------- meetings

test("meetings: anonymous goes to /login, non-member to /, member/volunteer/admin get the page", async () => {
  const anon = await c.get("/meetings");
  assert.equal(anon.status, 302);
  assert.equal(anon.location, "/login");
  const nonMember = await c.get("/meetings", { as: plain });
  assert.equal(nonMember.status, 302);
  assert.equal(nonMember.location, "/");
  for (const u of [member, volunteer, admin]) {
    const ok = await c.get("/meetings?month=2091-01", { as: u });
    assert.equal(ok.status, 200);
    assert.match(ok.text, /<h1>Meetings<\/h1>/);
  }
});

test("meetings: RSVP endpoint rejects anonymous and non-member users without writing", async () => {
  const m = await makeMeeting(noon(2091, 1, 10));
  for (const who of [null, plain]) {
    const r = await c.post(`/meetings/${m.id}/rsvp`, {}, { as: who });
    assert.equal(r.status, 302);
    assert.equal(r.location, who ? "/" : "/login");
  }
  assert.equal(await rsvpCount(m.id), 0);
});

test("meetings: month view lists a meeting with escaped title/location/agenda and its RSVP count", async () => {
  const month = "2091-02";
  const evil = await makeMeeting(noon(2091, 2, 12), {
    title: `<script>alert('m')</script> ${uniq()}`, location: "<b>Loft</b>", agenda: "<img src=x onerror=1>",
  });
  const { text } = await c.get(`/meetings?month=${month}`, { as: member });
  assert.ok(!text.includes("<script>alert('m')"), "title must be escaped");
  assert.ok(!text.includes("<b>Loft</b>"));
  assert.ok(!text.includes("<img src=x onerror=1>"));
  assert.match(text, /&lt;script&gt;alert\(&#39;m&#39;\)&lt;\/script&gt;/);
  assert.match(text, /0 going/);
  assert.match(text, new RegExp(`/meetings/${evil.id}/rsvp\\?month=${month}`));
  const other = await c.get("/meetings?month=2091-03", { as: member });
  assert.ok(!other.text.includes(`/meetings/${evil.id}/rsvp`), "a different month must not show it");
});

test("meetings: week view shows only that week's meetings and week-based nav links", async () => {
  const inWeek = await makeMeeting(noon(2091, 4, 10));
  const outWeek = await makeMeeting(noon(2091, 4, 25));
  const { text } = await c.get("/meetings?view=week&week=2091-04-10", { as: member });
  assert.match(text, new RegExp(`/meetings/${inWeek.id}/rsvp\\?view=week&amp;week=2091-04-\\d\\d`));
  assert.ok(!text.includes(`/meetings/${outWeek.id}/rsvp`));
  assert.match(text, /href="\/meetings\?view=week&amp;week=2091-04-0\d"/); // prev
  assert.match(text, /href="\/meetings\?view=week&amp;week=2091-04-\d\d"/); // next
});

test("meetings: RSVP is idempotent and shows Cancel RSVP; un-RSVP removes it; redirects keep the calendar view", async () => {
  const m = await makeMeeting(noon(2091, 5, 8));
  const r1 = await c.post(`/meetings/${m.id}/rsvp?month=2091-05`, {}, { as: member });
  assert.equal(r1.status, 302);
  assert.equal(r1.location, "/meetings?month=2091-05");
  await c.post(`/meetings/${m.id}/rsvp?month=2091-05`, {}, { as: member }); // duplicate
  await c.post(`/meetings/${m.id}/rsvp`, {}, { as: volunteer });
  assert.equal(await rsvpCount(m.id), 2);

  const mine = await c.get("/meetings?month=2091-05", { as: member });
  assert.match(mine.text, /Cancel RSVP/);
  assert.match(mine.text, /2 going/);
  const notMine = await c.get("/meetings?month=2091-05", { as: admin });
  assert.ok(!notMine.text.includes("Cancel RSVP"));
  assert.match(notMine.text, /I'll be there/);

  const un = await c.post(`/meetings/${m.id}/unrsvp?view=week&week=2091-05-08`, {}, { as: member });
  assert.equal(un.location, "/meetings?view=week&week=2091-05-08");
  assert.equal(await rsvpCount(m.id), 1);
  const plainUn = await c.post(`/meetings/${m.id}/unrsvp`, {}, { as: volunteer });
  assert.equal(plainUn.location, "/meetings");
  assert.equal(await rsvpCount(m.id), 0);
});

test("meetings: a just-passed meeting is eligible for the past list and its minutes are escaped", async () => {
  const past = await makeMeeting(new Date(Date.now() - 60 * 1000), { title: `Past ${uniq()}` });
  await pool.query("UPDATE meetings SET minutes = $1 WHERE id = $2", ["Minutes <i>posted</i>", past.id]);
  const { text } = await c.get("/meetings?month=2091-06", { as: member });
  assert.match(text, /Past meetings/);
  assert.ok(!text.includes("<i>posted</i>"), "minutes escaped");
});

test("meetings: garbage id is a 404 and an RSVP to an unknown meeting stores nothing", async () => {
  assert.equal((await c.post("/meetings/abc/rsvp", {}, { as: member })).status, 404);
  const unknown = await c.post("/meetings/99999999/rsvp", {}, { as: member });
  assert.ok(unknown.status >= 400, `got ${unknown.status}`);
  assert.equal(await rsvpCount(99999999), 0);
});

// BUG: the INSERT into meeting_rsvps has no existence check, so a well-formed
// but unknown meeting id hits the meeting_id foreign key and surfaces as a
// 500 (23503) instead of the 404 page the other id routes give.
test("meetings: RSVP to an unknown (well-formed) meeting id is a 404, not a 500",
  async () => {
    const unknown = await c.post("/meetings/99999999/rsvp", {}, { as: member });
    assert.equal(unknown.status, 404);
  });

// --------------------------------------------------------------- volunteer

async function makeShift(at, { role, capacity = 2, notes = null } = {}) {
  const r = role || `Shift ${uniq()}`;
  const { rows } = await pool.query(
    "INSERT INTO volunteer_shifts (role, starts_at, ends_at, capacity, notes) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [r, at, new Date(at.getTime() + 2 * 3600 * 1000), capacity, notes]
  );
  return { id: rows[0].id, role: r };
}
const shiftSignups = async (id) => Number((await pool.query("SELECT COUNT(*) FROM volunteer_signups WHERE shift_id = $1", [id])).rows[0].count);

test("volunteer: only volunteers and admins may view or sign up; plain members and anonymous are redirected", async () => {
  const s = await makeShift(noon(2091, 7, 10));
  assert.equal((await c.get("/volunteer")).location, "/login");
  const memberView = await c.get("/volunteer", { as: member });
  assert.equal(memberView.status, 302);
  assert.equal(memberView.location, "/");
  for (const who of [null, member, plain]) {
    const r = await c.post(`/volunteer/${s.id}/signup`, {}, { as: who });
    assert.equal(r.status, 302);
  }
  assert.equal(await shiftSignups(s.id), 0);
  for (const u of [volunteer, admin]) {
    assert.equal((await c.get("/volunteer?month=2091-07", { as: u })).status, 200);
  }
});

test("volunteer: calendar shows escaped role/notes and filled/capacity; week view limits to the week", async () => {
  const s = await makeShift(noon(2091, 8, 10), { role: `<u>Cashier</u> ${uniq()}`, capacity: 3, notes: "<script>x</script>" });
  const far = await makeShift(noon(2091, 8, 28));
  const month = await c.get("/volunteer?month=2091-08", { as: volunteer });
  assert.ok(!month.text.includes("<u>Cashier</u>"));
  assert.ok(!month.text.includes("<script>x</script>"));
  assert.match(month.text, /&lt;u&gt;Cashier&lt;\/u&gt;/);
  assert.match(month.text, /0\/3 filled/);
  assert.match(month.text, new RegExp(`/volunteer/${far.id}/signup\\?month=2091-08`));
  const week = await c.get("/volunteer?view=week&week=2091-08-10", { as: volunteer });
  assert.match(week.text, new RegExp(`/volunteer/${s.id}/signup\\?view=week&amp;week=`));
  assert.ok(!week.text.includes(`/volunteer/${far.id}/signup`));
});

test("volunteer: sign up, duplicate is a no-op, cancel frees the spot; redirects keep the view", async () => {
  const s = await makeShift(noon(2091, 9, 10), { capacity: 2 });
  const r = await c.post(`/volunteer/${s.id}/signup?month=2091-09`, {}, { as: volunteer });
  assert.equal(r.status, 302);
  assert.equal(r.location, "/volunteer?month=2091-09");
  await c.post(`/volunteer/${s.id}/signup`, {}, { as: volunteer });
  assert.equal(await shiftSignups(s.id), 1);

  const page = await c.get("/volunteer?month=2091-09", { as: volunteer });
  assert.match(page.text, /1\/2 filled/);
  assert.match(page.text, new RegExp(`/volunteer/${s.id}/cancel\\?month=2091-09`));
  assert.ok(page.text.includes(s.role));

  const cancel = await c.post(`/volunteer/${s.id}/cancel?view=week&week=2091-09-10`, {}, { as: volunteer });
  assert.equal(cancel.location, "/volunteer?view=week&week=2091-09-10");
  assert.equal(await shiftSignups(s.id), 0);
  assert.equal((await c.post(`/volunteer/${s.id}/cancel`, {}, { as: volunteer })).location, "/volunteer");
});

test("volunteer: a full shift refuses further sign-ups and renders as Full", async () => {
  const s = await makeShift(noon(2091, 10, 10), { capacity: 1 });
  await c.post(`/volunteer/${s.id}/signup`, {}, { as: volunteer });
  const late = await c.post(`/volunteer/${s.id}/signup?month=2091-10`, {}, { as: admin });
  assert.equal(late.status, 302);
  assert.equal(late.location, "/volunteer?month=2091-10");
  assert.equal(await shiftSignups(s.id), 1);
  const page = await c.get("/volunteer?month=2091-10", { as: admin });
  assert.match(page.text, /is-full/);
  assert.match(page.text, /disabled>Full</);
});

test("volunteer: unknown shift and garbage id 404; cancelling a shift you are not on changes nothing", async () => {
  assert.equal((await c.post("/volunteer/99999999/signup", {}, { as: volunteer })).status, 404);
  assert.equal((await c.post("/volunteer/not-a-number/signup", {}, { as: volunteer })).status, 404);
  const s = await makeShift(noon(2091, 11, 10));
  await c.post(`/volunteer/${s.id}/signup`, {}, { as: volunteer });
  await c.post(`/volunteer/${s.id}/cancel`, {}, { as: admin }); // admin isn't signed up
  assert.equal(await shiftSignups(s.id), 1);
});

test("volunteer: a past shift stays listed in its month but is not under 'my upcoming shifts'", async () => {
  const s = await makeShift(noon(2020, 3, 10));
  await pool.query("INSERT INTO volunteer_signups (shift_id, user_id) VALUES ($1, $2)", [s.id, volunteer.id]);
  const page = await c.get("/volunteer?month=2020-03", { as: volunteer });
  assert.match(page.text, new RegExp(`/volunteer/${s.id}/cancel`));
  const now = await c.get("/volunteer", { as: volunteer });
  assert.ok(!now.text.includes(s.role));
});
