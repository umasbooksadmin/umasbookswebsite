// Regression coverage: event and volunteer-shift signups used to read
// the current signup count and only then insert, with no locking — two
// requests arriving at the same moment could both pass the capacity
// check before either inserted, overfilling a capacity-1 event/shift.
// Fixed by locking the event/shift row for the duration of the
// check-then-insert (see routes/events.js, routes/volunteer.js).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3414; // distinct from other integration test files
const CONCURRENCY = 10;

let app;
let pool;

before(async () => {
  app = await startTestApp({ port: PORT });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});

after(async () => {
  await pool.end();
  app.stop();
});

test(`${CONCURRENCY} concurrent event signups against capacity 1 produce exactly 1 row`, async () => {
  const { rows } = await pool.query(
    "INSERT INTO events (title, starts_at, capacity) VALUES ('Capacity Race Test', now() + interval '1 day', 1) RETURNING id"
  );
  const eventId = rows[0].id;

  const racers = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    const jar = makeCookieJar();
    const token = await fetchCsrfToken(app.base, jar);
    racers.push({ jar, token, email: `racer${i}-${Date.now()}@example.test` });
  }

  const statuses = await Promise.all(
    racers.map((r) =>
      fetch(`${app.base}/events/${eventId}/signup`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: r.jar.header() },
        body: `name=Racer&email=${encodeURIComponent(r.email)}&_csrf=${r.token}`,
      }).then((res) => res.status)
    )
  );
  assert.ok(statuses.every((s) => s === 302), "every signup attempt should redirect regardless of outcome");

  const { rows: signups } = await pool.query("SELECT COUNT(*)::int AS n FROM event_signups WHERE event_id = $1", [eventId]);
  assert.equal(signups[0].n, 1);
});

test(`${CONCURRENCY} concurrent volunteer signups against capacity 1 produce exactly 1 row`, async () => {
  const { rows } = await pool.query(
    "INSERT INTO volunteer_shifts (role, starts_at, ends_at, capacity) VALUES ('Shelving', now() + interval '1 day', now() + interval '1 day 2 hours', 1) RETURNING id"
  );
  const shiftId = rows[0].id;

  const hash = await bcrypt.hash("Irrelevant1!", 12);
  const jars = [];
  for (let i = 0; i < CONCURRENCY; i++) {
    const email = `vol-racer${i}-${Date.now()}@example.test`;
    await pool.query(
      "INSERT INTO users (email, password_hash, display_name, is_volunteer, email_verified_at) VALUES ($1, $2, 'Vol Racer', TRUE, now())",
      [email, hash]
    );
    const jar = makeCookieJar();
    const token = await fetchCsrfToken(app.base, jar);
    const loginRes = await fetch(`${app.base}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
      body: `email=${encodeURIComponent(email)}&password=Irrelevant1!&_csrf=${token}`,
    });
    jar.capture(loginRes);
    jars.push(jar);
  }

  const statuses = await Promise.all(
    jars.map(async (jar) => {
      const token = await fetchCsrfToken(app.base, jar);
      const res = await fetch(`${app.base}/volunteer/${shiftId}/signup`, {
        method: "POST",
        redirect: "manual",
        headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar.header() },
        body: `_csrf=${token}`,
      });
      return res.status;
    })
  );
  assert.ok(statuses.every((s) => s === 302));

  const { rows: signups } = await pool.query("SELECT COUNT(*)::int AS n FROM volunteer_signups WHERE shift_id = $1", [shiftId]);
  assert.equal(signups[0].n, 1);
});
