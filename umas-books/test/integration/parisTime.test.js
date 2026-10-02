// Uma's Books is in France: every date/time an admin types means Europe/Paris,
// not UTC. Before this, "18:00" was stored as 18:00Z (20:00 in Paris in
// summer) and the pages disagreed with each other. This test drives the real
// app end to end, plus the one-time migration that corrected stored rows.
// (Summer = UTC+2, winter = UTC+1; the clocks changed on 25 Oct 2026.)

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const fs = require("node:fs");
const path = require("node:path");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3540; // distinct from 3411-3419, 3430-3499 used elsewhere
const PASSWORD = "Paris-Time-Test1!";

let app;
let pool;
let jar;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));

  const email = `paris-admin-${Date.now()}@example.test`;
  await pool.query(
    "INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at) VALUES ($1, $2, 'Paris Admin', TRUE, now())",
    [email, await bcrypt.hash(PASSWORD, 12)]
  );
  jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: `email=${encodeURIComponent(email)}&password=${encodeURIComponent(PASSWORD)}&_csrf=${token}`,
  });
  jar.capture(res);
  assert.equal(res.status, 302);
});

after(async () => {
  await pool.end();
  await app.stop();
});

async function post(urlPath, fields) {
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}${urlPath}`, {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });
  jar.capture(res);
  return res;
}

const iso = (d) => new Date(d).toISOString();

test("an event typed as 18:00–19:30 in July is stored as 16:00Z–17:30Z, and its calendar file says so", async () => {
  const res = await post("/admin/events", { title: "Paris Night", date: "2026-07-15", startTime: "18:00", endTime: "19:30" });
  assert.equal(res.status, 302);
  const { rows } = await pool.query("SELECT id, starts_at, ends_at FROM events WHERE title = 'Paris Night'");
  assert.equal(iso(rows[0].starts_at), "2026-07-15T16:00:00.000Z");
  assert.equal(iso(rows[0].ends_at), "2026-07-15T17:30:00.000Z");

  const ics = await (await fetch(`${app.base}/events/${rows[0].id}/ics`)).text();
  assert.match(ics, /DTSTART:20260715T160000Z/, "a calendar app shows 18:00 Paris, not 20:00");
});

test("the admin edit form pre-fills the time that was typed, and saving it again changes nothing", async () => {
  const { rows } = await pool.query("SELECT id FROM events WHERE title = 'Paris Night'");
  const page = await (await fetch(`${app.base}/admin/events?month=2026-07`, { headers: { cookie: jar.header() } })).text();
  assert.match(page, /value="2026-07-15T18:00"/);
  assert.match(page, /value="2026-07-15T19:30"/);

  const res = await post(`/admin/events/${rows[0].id}`, { title: "Paris Night", startsAt: "2026-07-15T18:00", endsAt: "2026-07-15T19:30" });
  assert.equal(res.status, 302);
  const after = (await pool.query("SELECT starts_at FROM events WHERE id = $1", [rows[0].id])).rows[0];
  assert.equal(iso(after.starts_at), "2026-07-15T16:00:00.000Z");
});

test("a winter event uses UTC+1", async () => {
  await post("/admin/events", { title: "Paris Winter", date: "2026-01-15", startTime: "18:00" });
  const { rows } = await pool.query("SELECT starts_at FROM events WHERE title = 'Paris Winter'");
  assert.equal(iso(rows[0].starts_at), "2026-01-15T17:00:00.000Z");
});

test("a malformed date or time is ignored instead of stored", async () => {
  const before = (await pool.query("SELECT count(*)::int AS n FROM events")).rows[0].n;
  await post("/admin/events", { title: "Bad Time", date: "2026-07-15", startTime: "25:99" });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM events")).rows[0].n, before);
});

test("a weekly volunteer shift keeps 18:00 Paris across the October clock change", async () => {
  await post("/admin/volunteer-shifts", { role: "Paris Shift", date: "2026-10-20", startTime: "18:00", endTime: "20:00", repeatWeeks: "3" });
  const { rows } = await pool.query("SELECT starts_at, ends_at FROM volunteer_shifts WHERE role = 'Paris Shift' ORDER BY starts_at");
  assert.deepEqual(rows.map((r) => iso(r.starts_at)), ["2026-10-20T16:00:00.000Z", "2026-10-27T17:00:00.000Z", "2026-11-03T17:00:00.000Z"]);
  assert.deepEqual(rows.map((r) => iso(r.ends_at)), ["2026-10-20T18:00:00.000Z", "2026-10-27T19:00:00.000Z", "2026-11-03T19:00:00.000Z"]);
});

test("a session and a meeting are read as Paris time too", async () => {
  await post("/admin/sessions", { title: "Paris Session", date: "2026-07-15", startTime: "10:00", endTime: "11:00", capacity: "5" });
  await post("/admin/meetings", { title: "Paris Meeting", date: "2026-07-15", time: "19:00" });
  const s = (await pool.query("SELECT starts_at, ends_at FROM classes WHERE title = 'Paris Session'")).rows[0];
  assert.equal(iso(s.starts_at), "2026-07-15T08:00:00.000Z");
  assert.equal(iso(s.ends_at), "2026-07-15T09:00:00.000Z");
  const m = (await pool.query("SELECT scheduled_at FROM meetings WHERE title = 'Paris Meeting'")).rows[0];
  assert.equal(iso(m.scheduled_at), "2026-07-15T17:00:00.000Z");
});

// ---- the one-time correction of rows saved before this change -------------
test("migration 033 moves typed times by the Paris offset and leaves real instants alone", async () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "033_paris_wall_times.sql"), "utf8");

  // Rows exactly as the OLD code stored them: the typed wall time labelled Z.
  const ev = await pool.query("INSERT INTO events (title, starts_at, ends_at) VALUES ('Old Event', '2026-07-15T18:00:00Z', NULL) RETURNING id");
  const evw = await pool.query("INSERT INTO events (title, starts_at) VALUES ('Old Winter', '2026-01-15T18:00:00Z') RETURNING id");
  const cls = await pool.query("INSERT INTO classes (title, starts_at, ends_at, capacity) VALUES ('Old Class', '2026-07-15T10:00:00Z', '2026-07-15T11:00:00Z', 5) RETURNING id");
  const shift = await pool.query("INSERT INTO volunteer_shifts (role, starts_at, ends_at) VALUES ('Old Shift', '2026-07-15T09:00:00Z', '2026-07-15T12:00:00Z') RETURNING id");
  const mtg = await pool.query("INSERT INTO meetings (title, scheduled_at) VALUES ('Old Meeting', '2026-07-15T19:00:00Z') RETURNING id");
  const annSched = await pool.query("INSERT INTO announcements (title, body, status, published_at) VALUES ('Scheduled', 'x', 'scheduled', '2026-07-15T08:00:00Z') RETURNING id");
  const annPub = await pool.query("INSERT INTO announcements (title, body, status, published_at) VALUES ('Published', 'x', 'published', '2026-07-15T08:00:00Z') RETURNING id");
  const activeRound = await pool.query("INSERT INTO charity_rounds (title, is_active, closes_at) VALUES ('Active', TRUE, '2026-07-15T18:00:00Z') RETURNING id");
  await pool.query("UPDATE charity_rounds SET is_active = FALSE WHERE id <> $1", [activeRound.rows[0].id]);
  const closedRound = await pool.query("INSERT INTO charity_rounds (title, is_active, closes_at) VALUES ('Closed', FALSE, '2026-07-15T18:00:00Z') RETURNING id");

  await pool.query(sql);

  const one = async (table, col, id) => iso((await pool.query(`SELECT ${col} AS v FROM ${table} WHERE id = $1`, [id])).rows[0].v);
  assert.equal(await one("events", "starts_at", ev.rows[0].id), "2026-07-15T16:00:00.000Z");
  assert.equal(await one("events", "starts_at", evw.rows[0].id), "2026-01-15T17:00:00.000Z", "winter shifts by one hour, summer by two");
  assert.equal((await pool.query("SELECT ends_at FROM events WHERE id = $1", [ev.rows[0].id])).rows[0].ends_at, null, "a missing end time stays missing");
  assert.equal(await one("classes", "starts_at", cls.rows[0].id), "2026-07-15T08:00:00.000Z");
  assert.equal(await one("classes", "ends_at", cls.rows[0].id), "2026-07-15T09:00:00.000Z");
  assert.equal(await one("volunteer_shifts", "starts_at", shift.rows[0].id), "2026-07-15T07:00:00.000Z");
  assert.equal(await one("volunteer_shifts", "ends_at", shift.rows[0].id), "2026-07-15T10:00:00.000Z");
  assert.equal(await one("meetings", "scheduled_at", mtg.rows[0].id), "2026-07-15T17:00:00.000Z");
  assert.equal(await one("announcements", "published_at", annSched.rows[0].id), "2026-07-15T06:00:00.000Z", "a scheduled announcement's typed time shifts");
  assert.equal(await one("announcements", "published_at", annPub.rows[0].id), "2026-07-15T08:00:00.000Z", "a published one is a real instant: untouched");
  assert.equal(await one("charity_rounds", "closes_at", activeRound.rows[0].id), "2026-07-15T16:00:00.000Z");
  assert.equal(await one("charity_rounds", "closes_at", closedRound.rows[0].id), "2026-07-15T18:00:00.000Z", "a closed round is left alone");
});
