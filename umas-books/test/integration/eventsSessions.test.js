// Public events calendar + sign-up + .ics + JSON feed (src/routes/events.js)
// and the public drop-in sessions calendar (src/routes/sessions.js).
//
// In-process harness against the shared test database: every row uses a
// unique title and a fixed far-future month so concurrent test files can't
// land in the same calendar window; the one time-relative assertion (the
// upcoming feed) only checks rows this file created.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
// Production loads this before any router (src/index.js).
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");
const { makeClient, uniq } = require("../helpers/routeClient");

const db = prepareDatabase("events_sessions", { isolated: true });
const { pool } = require("../../src/db");
const { eventSignupLimiter } = require("../../src/middleware/rateLimits");

let server;
let c;

// Midday UTC keeps the calendar day stable in any server timezone.
const noon = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 12, 0, 0));

before(async () => {
  db.create();
  const app = buildApp([require("../../src/routes/events"), require("../../src/routes/sessions")]);
  // src/index.js sets this view local; the shared harness doesn't.
  app.locals.mondayFirstWeeks = require("../../src/lib/calendar").mondayFirstWeeks;
  server = await listen(app);
  c = makeClient(server.base);
});
after(async () => {
  await server.close();
  await pool.end();
  db.drop();
});

// The sign-up limiter (10/hour per IP) is shared by the whole file; each
// sign-up test starts from a fresh budget so test order doesn't matter.
beforeEach(() => eventSignupLimiter.resetKey("127.0.0.1"));

async function makeEvent(at, { title, capacity = null, price = null, description = null, location = null, endsAt = null } = {}) {
  const t = title || `Event ${uniq()}`;
  const { rows } = await pool.query(
    "INSERT INTO events (title, description, location, starts_at, ends_at, capacity, price) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    [t, description, location, at, endsAt, capacity, price]
  );
  return { id: rows[0].id, title: t };
}
const signups = async (id) => (await pool.query("SELECT * FROM event_signups WHERE event_id = $1 ORDER BY id", [id])).rows;

// ------------------------------------------------------------------ events

test("GET /events is public and shows an event in its month, escaped, with price/going/ics link", async () => {
  const month = "2092-01";
  const ev = await makeEvent(noon(2092, 1, 14), {
    title: `<script>alert('e')</script> ${uniq()}`, price: 12.5, description: "<b>Bold</b> desc", location: "The <i>Loft</i>",
  });
  const { status, text } = await c.get(`/events?month=${month}`);
  assert.equal(status, 200);
  assert.ok(!text.includes("<script>alert('e')"));
  assert.ok(!text.includes("<b>Bold</b>"));
  assert.ok(!text.includes("The <i>Loft</i>"));
  assert.match(text, /&lt;script&gt;alert\(&#39;e&#39;\)&lt;\/script&gt;/);
  assert.match(text, /€12\.50/);
  assert.match(text, /0 going/);
  assert.match(text, new RegExp(`/events/${ev.id}/signup\\?month=${month}`));
  assert.match(text, new RegExp(`/events/${ev.id}/ics`));
  assert.match(text, /January 2092/);
  const other = await c.get("/events?month=2092-02");
  assert.ok(!other.text.includes(`/events/${ev.id}/signup`));
});

test("GET /events: free events say Free; week view shows only the chosen week; bad month falls back to now", async () => {
  const inWeek = await makeEvent(noon(2092, 3, 10));
  const outWeek = await makeEvent(noon(2092, 3, 24));
  const week = await c.get("/events?view=week&week=2092-03-10");
  assert.match(week.text, /Free/);
  assert.match(week.text, new RegExp(`/events/${inWeek.id}/signup\\?view=week&amp;week=2092-03-\\d\\d`));
  assert.ok(!week.text.includes(`/events/${outWeek.id}/signup`));
  const month = await c.get("/events?month=2092-03");
  assert.ok(month.text.includes(`/events/${outWeek.id}/signup`) && month.text.includes(`/events/${inWeek.id}/signup`));
  const bad = await c.get("/events?month=garbage");
  assert.equal(bad.status, 200);
  assert.ok(!bad.text.includes(`/events/${inWeek.id}/signup`));
});

test("GET /api/events/upcoming: CORS/cache headers, JSON shape, at most 10 entries, soonest first", async () => {
  const base = Date.now() + 3 * 3600 * 1000;
  const mine = [];
  for (let i = 0; i < 11; i++) {
    mine.push(await makeEvent(new Date(base + i * 60 * 1000), { title: `Upcoming ${uniq()}`, capacity: 7, location: "Shop" }));
  }
  await pool.query("INSERT INTO event_signups (event_id, name, email) VALUES ($1, 'A', $2)", [mine[0].id, `u-${uniq()}@example.test`]);
  const { res, text } = await c.get("/api/events/upcoming");
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("access-control-allow-origin"), "*");
  assert.equal(res.headers.get("cross-origin-resource-policy"), "cross-origin");
  assert.equal(res.headers.get("cache-control"), "public, max-age=60");
  const list = JSON.parse(text);
  assert.equal(list.length, 10, "LIMIT 10 applies (11 upcoming rows were seeded)");
  const times = list.map((e) => new Date(e.startsAt).getTime());
  assert.deepEqual(times, [...times].sort((a, b) => a - b));
  assert.ok(times.every((t) => t >= Date.now() - 5000), "no past events");
  const first = list.find((e) => e.id === mine[0].id);
  assert.ok(first, "the earliest seeded event is in the feed");
  assert.deepEqual(Object.keys(first).sort(), ["capacity", "description", "endsAt", "id", "location", "signupCount", "startsAt", "title", "url"]);
  assert.equal(first.title, mine[0].title);
  assert.equal(first.capacity, 7);
  assert.equal(Number(first.signupCount), 1);
  assert.match(first.url, /^http:\/\/127\.0\.0\.1:\d+\/events\?month=\d{4}-\d{2}$/);
});

test("GET /events/:id/ics: a real calendar file with escaped fields, UTC instants and a safe filename", async () => {
  const start = new Date(Date.UTC(2092, 5, 10, 14, 30, 0));
  const ev = await makeEvent(start, {
    title: `Poetry, Wine; "Night" ${uniq()}`, description: "Line one\nLine two, with; punctuation", location: "Rue Peyrolière, Albi",
  });
  const { res, text } = await c.get(`/events/${ev.id}/ics`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/calendar; charset=utf-8/);
  const disp = res.headers.get("content-disposition");
  assert.match(disp, new RegExp(`^attachment; filename="${ev.id}-[A-Za-z0-9-]+\\.ics"$`));
  const lines = text.split("\r\n");
  assert.equal(lines[0], "BEGIN:VCALENDAR");
  assert.equal(lines.at(-1), "END:VCALENDAR");
  assert.ok(lines.includes("DTSTART:20920610T143000Z"));
  assert.ok(lines.includes("DTEND:20920610T153000Z"), "no ends_at defaults to one hour");
  assert.ok(lines.includes(`UID:event-${ev.id}@umasbooks.org`));
  assert.ok(lines.includes("DESCRIPTION:Line one\\nLine two\\, with\\; punctuation"));
  assert.ok(lines.includes("LOCATION:Rue Peyrolière\\, Albi"));
  assert.ok(lines.includes(`SUMMARY:${ev.title.replace(/,/g, "\\,").replace(/;/g, "\\;")}`));
});

test("GET /events/:id/ics: explicit end time is used, empty description/location lines are omitted", async () => {
  const ev = await makeEvent(new Date(Date.UTC(2092, 6, 1, 9, 0, 0)), { endsAt: new Date(Date.UTC(2092, 6, 1, 11, 15, 0)) });
  const { text } = await c.get(`/events/${ev.id}/ics`);
  assert.match(text, /DTEND:20920701T111500Z/);
  assert.ok(!/DESCRIPTION:/.test(text));
  assert.ok(!/LOCATION:/.test(text));
});

test("GET /events/:id/ics: unknown id is 404, garbage id is the 404 page", async () => {
  const unknown = await c.get("/events/99999999/ics");
  assert.equal(unknown.status, 404);
  assert.match(unknown.text, /Event not found/);
  assert.equal((await c.get("/events/abc/ics")).status, 404);
});

test("event signup: stores a trimmed, lower-cased signup and redirects back to the calendar view", async () => {
  const ev = await makeEvent(noon(2092, 8, 5), { capacity: 5 });
  const email = `Guest-${uniq()}@Example.TEST`;
  const r = await c.post(`/events/${ev.id}/signup?month=2092-08`, { name: "  Marie Curie  ", email: ` ${email} ` });
  assert.equal(r.status, 302);
  assert.equal(r.location, "/events?month=2092-08");
  const rows = await signups(ev.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "Marie Curie");
  assert.equal(rows[0].email, email.toLowerCase());
  const wk = await c.post(`/events/${ev.id}/signup?view=week&week=2092-08-05`, { name: "Wk", email: `wk-${uniq()}@example.test` });
  assert.equal(wk.location, "/events?view=week&week=2092-08-05");
  const plain = await c.post(`/events/${ev.id}/signup`, { name: "P", email: `p-${uniq()}@example.test` });
  assert.equal(plain.location, "/events");
  const page = await c.get("/events?month=2092-08");
  assert.match(page.text, /3 going/);
});

test("event signup: duplicate email (any case) is a silent no-op, not a second row", async () => {
  const ev = await makeEvent(noon(2092, 8, 6), { capacity: 5 });
  const email = `dup-${uniq()}@example.test`;
  await c.post(`/events/${ev.id}/signup`, { name: "First", email });
  const again = await c.post(`/events/${ev.id}/signup`, { name: "Second", email: email.toUpperCase() });
  assert.equal(again.status, 302);
  const rows = await signups(ev.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, "First");
});

test("event signup: a full event refuses more people and the calendar shows Full", async () => {
  const ev = await makeEvent(noon(2092, 9, 7), { capacity: 2 });
  for (const n of ["a", "b", "c"]) {
    const r = await c.post(`/events/${ev.id}/signup?month=2092-09`, { name: n, email: `${n}-${uniq()}@example.test` });
    assert.equal(r.location, "/events?month=2092-09");
  }
  assert.equal((await signups(ev.id)).length, 2);
  const page = await c.get("/events?month=2092-09");
  assert.match(page.text, /<button type="submit" class="fcal-session-cta" disabled>Full<\/button>/);
  assert.match(page.text, /2 going/);
});

test("event signup: missing name, bad or multi-recipient email store nothing; over-long name is capped", async () => {
  const ev = await makeEvent(noon(2092, 10, 7));
  for (const f of [
    { name: "", email: `x-${uniq()}@example.test` },
    { name: "   ", email: `x-${uniq()}@example.test` },
    { name: "Ok", email: "not-an-email" },
    { name: "Ok", email: "a@example.test, b@example.test" },
    { name: "Ok" },
    {},
  ]) {
    const r = await c.post(`/events/${ev.id}/signup`, f);
    assert.equal(r.status, 302);
    assert.equal(r.location, "/events");
  }
  assert.equal((await signups(ev.id)).length, 0);
  await c.post(`/events/${ev.id}/signup`, { name: "N".repeat(300), email: `long-${uniq()}@example.test` });
  assert.equal((await signups(ev.id))[0].name.length, 100);
});

test("event signup: unknown event is 404 and stores nothing; garbage id 404s", async () => {
  const r = await c.post("/events/99999999/signup", { name: "Ghost", email: `g-${uniq()}@example.test` });
  assert.equal(r.status, 404);
  assert.match(r.text, /Event not found/);
  assert.equal((await c.post("/events/xyz/signup", { name: "G", email: `g-${uniq()}@example.test` })).status, 404);
});

// ---------------------------------------------------------------- sessions

async function makeClass(at, { title, capacity = null, dropinPrice = null } = {}) {
  const t = title || `Class ${uniq()}`;
  const { rows } = await pool.query(
    "INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ($1, $2, $3, $4) RETURNING id",
    [t, at, capacity, dropinPrice]
  );
  return { id: rows[0].id, title: t };
}
async function addSeats(classId, status, n) {
  for (let i = 0; i < n; i++) await pool.query("INSERT INTO class_dropin_seats (class_id, status) VALUES ($1, $2)", [classId, status]);
}
// The rendered card for one class: from its title to a bit past the seats line.
function card(text, title) {
  const i = text.indexOf(`<div class="fcal-session-title">${title}</div>`);
  assert.ok(i >= 0, `card for ${title} not rendered`);
  return text.slice(i, i + 900);
}

test("GET /sessions: public; month view shows drop-in price, 'places left' counting sold and in-cart seats", async () => {
  const month = "2093-01";
  const five = await makeClass(noon(2093, 1, 12), { capacity: 5, dropinPrice: 8 });
  await addSeats(five.id, "sold", 2);
  await addSeats(five.id, "in_cart", 1);
  const one = await makeClass(noon(2093, 1, 13), { capacity: 2, dropinPrice: 8.5 });
  await addSeats(one.id, "sold", 1);
  const open = await makeClass(noon(2093, 1, 14), { dropinPrice: 6 });
  const { status, text } = await c.get(`/sessions?month=${month}`);
  assert.equal(status, 200);
  assert.match(card(text, five.title), /€8\.00 · 2 places left/);
  assert.match(card(text, one.title), /€8\.50 · 1 place left/);
  assert.ok(!/places? left/.test(card(text, open.title).split("</summary>")[0]), "no capacity -> no seats line");
  assert.match(card(text, open.title), /€6\.00/);
  assert.match(text, new RegExp(`name="classId" value="${five.id}"`));
  assert.match(text, /name="backTo" value="\/sessions\?month=2093-01"/);
  assert.match(text, /January 2093/);
});

test("GET /sessions: a sold-out drop-in shows Full with no add-to-cart form; legacy class_signups also count", async () => {
  const full = await makeClass(noon(2093, 2, 10), { capacity: 2, dropinPrice: 9 });
  await addSeats(full.id, "sold", 1);
  await pool.query("INSERT INTO class_signups (class_id, name, email) VALUES ($1, 'Legacy', $2)", [full.id, `l-${uniq()}@example.test`]);
  const { text } = await c.get("/sessions?month=2093-02");
  const html = card(text, full.title);
  assert.match(html, /0 places left/);
  assert.match(html, /Full/);
  assert.ok(!html.includes(`value="${full.id}"`), "no add-dropin form for a full class");
});

test("GET /sessions: ?type=dropin hides info-only classes; unfiltered shows both", async () => {
  const dropin = await makeClass(noon(2093, 3, 10), { dropinPrice: 7 });
  const info = await makeClass(noon(2093, 3, 11));
  const all = await c.get("/sessions?month=2093-03");
  assert.ok(all.text.includes(dropin.title) && all.text.includes(info.title));
  assert.ok(!card(all.text, info.title).includes("Add to Cart"));
  const only = await c.get("/sessions?month=2093-03&type=dropin");
  assert.ok(only.text.includes(dropin.title));
  assert.ok(!only.text.includes(info.title));
  assert.match(only.text, /name="backTo" value="\/sessions\?month=2093-03&amp;type=dropin"/);
  assert.match(only.text, /class="is-active">Drop-ins Only/);
  assert.match(all.text, /class="is-active">All Sessions/);
});

test("GET /sessions: week view shows only that week and keeps the filter in prev/next links", async () => {
  const inWeek = await makeClass(noon(2093, 4, 14), { dropinPrice: 5 });
  const outWeek = await makeClass(noon(2093, 4, 28), { dropinPrice: 5 });
  const { text } = await c.get("/sessions?view=week&week=2093-04-14&type=dropin");
  assert.ok(text.includes(inWeek.title));
  assert.ok(!text.includes(outWeek.title));
  assert.match(text, /href="\/sessions\?view=week&amp;week=2093-04-0\d&amp;type=dropin"/);
  assert.match(text, /href="\/sessions\?view=week&amp;week=2093-04-\d\d&amp;type=dropin"/);
});

test("GET /sessions: class titles are escaped", async () => {
  const evil = await makeClass(noon(2093, 5, 12), { title: `<img src=x onerror=alert(1)> ${uniq()}`, dropinPrice: 4 });
  const { text } = await c.get("/sessions?month=2093-05");
  assert.ok(!text.includes("<img src=x onerror=alert(1)>"));
  assert.ok(text.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(evil.id);
});

test("/immersion/calendar permanently redirects to /sessions, carrying the query string", async () => {
  const bare = await c.get("/immersion/calendar");
  assert.equal(bare.status, 301);
  assert.equal(bare.location, "/sessions");
  const q = await c.get("/immersion/calendar?type=dropin&month=2093-06");
  assert.equal(q.status, 301);
  assert.equal(q.location, "/sessions?type=dropin&month=2093-06");
});
