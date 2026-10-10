// French coverage for the community, events, sessions and contact pages
// (forum, charity vote, meetings, volunteer shifts, dashboard, announcements,
// events and sessions calendars, contact form, 4xx error page), rendered with
// real data. Each page is rendered in English and in French by the real app
// (cookie `umasbooks_lang`) and untranslated() must find nothing: user data
// (titles, names, locations) is the same in both languages, so every seeded
// string carries the marker MARK and is allowlisted by it.
//
// Own throwaway database (isolated): the "active charity round" and "latest
// announcements" are global queries. Port range 3720-3729 is reserved for the
// i18n community tests; this file uses 3720.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const express = require("express");
const path = require("node:path");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");
const { untranslated } = require("../helpers/i18nAudit");

const PORT = 3720;
const PASSWORD = "I18nCommunity1!";
const MARK = "Zorblat";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const MONTH = "2092-05";
const HOUR = 3600 * 1000;

// Program name that is French in both languages; vote counts ("1 vote");
// "and Adventures" is part of the brand lockup on the dashboard.
const ALLOW = [new RegExp(MARK), /^[ÉE]veil$/, "Message", /^\d+ votes?$/, "and Adventures"];

let app;
let pool;
let member;
let volunteer;
let threadId;
let eventId;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  member = await makeUser({ member: true });
  volunteer = await makeUser({ member: true, volunteer: true });
  await seed();
});
after(async () => {
  await pool.end();
  await app.stop();
});

async function makeUser({ member: isMember = false, volunteer: isVolunteer = false }) {
  const email = `i18n-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_member, is_volunteer, email_verified_at)
     VALUES ($1, $2, $3, $4, $5, now()) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10), `${MARK} Member`, isMember, isVolunteer]
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

const noon = (d) => new Date(Date.UTC(2092, 4, d, 12, 0, 0));

async function seed() {
  // Forum: a thread with one reply, plus a thread with none.
  const t = await pool.query("INSERT INTO forum_threads (title, body, author_id) VALUES ($1, $2, $3) RETURNING id", [`${MARK} thread`, `${MARK} body`, member.id]);
  threadId = t.rows[0].id;
  await pool.query("INSERT INTO forum_replies (thread_id, body, author_id) VALUES ($1, $2, $3)", [threadId, `${MARK} reply`, member.id]);
  await pool.query("INSERT INTO forum_threads (title, body, author_id) VALUES ($1, $2, $3)", [`${MARK} lonely`, `${MARK} body`, null]);
  // Events: priced with a capacity, and a free full one.
  const e = await pool.query("INSERT INTO events (title, description, location, starts_at, capacity, price) VALUES ($1, $2, $3, $4, 10, 12.5) RETURNING id", [`${MARK} event`, `${MARK} desc`, `${MARK} place`, noon(14)]);
  eventId = e.rows[0].id;
  const full = await pool.query("INSERT INTO events (title, starts_at, capacity) VALUES ($1, $2, 1) RETURNING id", [`${MARK} full event`, noon(15)]);
  await pool.query("INSERT INTO event_signups (event_id, name, email) VALUES ($1, 'A', 'a@example.test')", [full.rows[0].id]);
  // Sessions: bookable with seats, bookable without a cap, and a plain one.
  await pool.query("INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ($1, $2, 6, 15)", [`${MARK} dropin`, noon(14)]);
  await pool.query("INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ($1, $2, 1, 15)", [`${MARK} lastseat`, noon(16)]);
  await pool.query("INSERT INTO classes (title, starts_at) VALUES ($1, $2)", [`${MARK} regular`, noon(17)]);
  // Meetings: an upcoming one (agenda, RSVP'd by the member), past ones with and without minutes.
  const m = await pool.query("INSERT INTO meetings (title, scheduled_at, location, agenda) VALUES ($1, $2, $3, $4) RETURNING id", [`${MARK} meeting`, noon(14), `${MARK} room`, `${MARK} agenda`]);
  await pool.query("INSERT INTO meeting_rsvps (meeting_id, user_id) VALUES ($1, $2)", [m.rows[0].id, member.id]);
  await pool.query("INSERT INTO meetings (title, scheduled_at, location, agenda) VALUES ($1, $2, $3, NULL)", [`${MARK} meeting other`, noon(20), `${MARK} room`]);
  await pool.query("INSERT INTO meetings (title, scheduled_at, location, minutes) VALUES ($1, '2020-01-10T10:00:00Z', $2, $3)", [`${MARK} past with minutes`, `${MARK} room`, `${MARK} minutes`]);
  await pool.query("INSERT INTO meetings (title, scheduled_at, location) VALUES ($1, '2020-02-10T10:00:00Z', $2)", [`${MARK} past without minutes`, `${MARK} room`]);
  // Volunteer shifts: open, full and one the volunteer already holds (upcoming, so "My upcoming shifts" shows).
  const open = await pool.query("INSERT INTO volunteer_shifts (role, starts_at, ends_at, capacity, notes) VALUES ($1, $2, $3, 3, $4) RETURNING id", [`${MARK} shop floor`, noon(14), new Date(noon(14).getTime() + 2 * HOUR), `${MARK} notes`]);
  const taken = await pool.query("INSERT INTO volunteer_shifts (role, starts_at, ends_at, capacity) VALUES ($1, $2, $3, 1) RETURNING id", [`${MARK} sorting`, noon(15), new Date(noon(15).getTime() + 2 * HOUR)]);
  await pool.query("INSERT INTO volunteer_signups (shift_id, user_id) VALUES ($1, $2)", [taken.rows[0].id, member.id]);
  const soon = await pool.query("INSERT INTO volunteer_shifts (role, starts_at, ends_at, capacity) VALUES ($1, now() + interval '2 days', now() + interval '2 days 2 hours', 3) RETURNING id", [`${MARK} soon`]);
  await pool.query("INSERT INTO volunteer_signups (shift_id, user_id) VALUES ($1, $2)", [soon.rows[0].id, volunteer.id]);
  assert.ok(open.rows[0].id);
  // Announcements (one pinned) and an active charity round with votes and ideas.
  await pool.query("INSERT INTO announcements (title, body, status, published_at, is_pinned, excerpt) VALUES ($1, '<p>x</p>', 'published', now() - interval '1 hour', true, $2)", [`${MARK} announcement`, `${MARK} excerpt`]);
  const r = await pool.query("INSERT INTO charity_rounds (title, opens_at, closes_at, is_active, allow_multiple, visible_to, show_results_during_vote) VALUES ($1, now() - interval '1 hour', now() + interval '3 days', true, true, 'everyone', true) RETURNING id", [`${MARK} round`]);
  const o1 = await pool.query("INSERT INTO charity_options (round_id, name, description) VALUES ($1, $2, $3) RETURNING id", [r.rows[0].id, `${MARK} option one`, `${MARK} desc`]);
  await pool.query("INSERT INTO charity_options (round_id, name, description) VALUES ($1, $2, $3)", [r.rows[0].id, `${MARK} option two`, `${MARK} desc`]);
  await pool.query("INSERT INTO charity_votes (round_id, option_id, user_id) VALUES ($1, $2, $3)", [r.rows[0].id, o1.rows[0].id, member.id]);
  await pool.query("INSERT INTO charity_votes (round_id, option_id, user_id) VALUES ($1, $2, $3)", [r.rows[0].id, o1.rows[0].id, volunteer.id]);
  for (const status of ["pending", "approved", "rejected"]) {
    await pool.query("INSERT INTO charity_ideas (name, status, submitted_by) VALUES ($1, $2, $3)", [`${MARK} idea ${status}`, status, member.id]);
  }
}

const langCookie = (who, lang) => [who ? who.jar.header() : "", `umasbooks_lang=${lang}`].filter(Boolean).join("; ");
async function render(who, p, lang) {
  const res = await fetch(`${app.base}${p}`, { redirect: "manual", headers: { cookie: langCookie(who, lang) } });
  return { status: res.status, text: await res.text() };
}
async function post(who, p, fields, lang) {
  const jar = who ? who.jar : makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}${p}`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: langCookie({ jar }, lang) },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });
  // A refused form answers 303 to a GET page (Post/Redirect/Get). Like a browser, follow it with
  // the same session: `status` stays the POST's own, `text` is the page it leads to.
  if (res.status === 303) {
    jar.capture(res);
    const location = res.headers.get("location");
    const page = await fetch(`${app.base}${location}`, { redirect: "manual", headers: { cookie: langCookie({ jar }, lang) } });
    return { status: 303, location, pageStatus: page.status, text: await page.text() };
  }
  return { status: res.status, text: await res.text() };
}

const PAGES = [
  ["anon", "/events"],
  ["anon", `/events?month=${MONTH}`],
  ["anon", "/events?view=week&week=2092-05-14"],
  ["anon", `/sessions?month=${MONTH}`],
  ["anon", "/sessions?view=week&week=2092-05-14"],
  ["anon", `/sessions?month=${MONTH}&type=dropin`],
  ["anon", "/contact"],
  ["anon", "/contact?sent=1"],
  ["anon", "/charity"], // round is visible to everyone: logged-out view with "Log in as a member"
  ["member", "/dashboard"],
  ["member", "/announcements"],
  ["member", "/forum"],
  ["member", "/forum/new"],
  ["member", "/forum/THREAD"],
  ["member", "/forum/THREAD?reported=1"],
  ["member", "/charity"],
  ["member", `/meetings?month=${MONTH}`],
  ["member", "/meetings?view=week&week=2092-05-14"],
  ["volunteer", "/dashboard"],
  ["volunteer", `/volunteer?month=${MONTH}`],
  ["volunteer", "/volunteer?view=week&week=2092-05-14"],
];

for (const [who, p] of PAGES) {
  test(`${who} ${p} is fully translated`, async () => {
    const user = who === "member" ? member : who === "volunteer" ? volunteer : null;
    const url = p.replace("THREAD", String(threadId));
    const en = await render(user, url, "en");
    const fr = await render(user, url, "fr");
    assert.equal(en.status, 200, `${url} (en)`);
    assert.equal(fr.status, 200, `${url} (fr)`);
    assert.match(fr.text, /<html lang="fr"/);
    assert.deepEqual(untranslated(en.text, fr.text, ALLOW), [], `${url}: same text in English and French`);
  });
}

test("calendar headings, weekdays, prices and seat counts are French with the fr cookie", async () => {
  const fr = (await render(null, `/events?month=${MONTH}`, "fr")).text;
  assert.match(fr, /Mai 2092/);
  assert.match(fr, />Lun</);
  assert.match(fr, /12,50\u00a0€/);
  assert.match(fr, /Gratuit/);
  assert.match(fr, /0 inscrit/);
  assert.match(fr, /Complet/);
  const week = (await render(null, "/events?view=week&week=2092-05-14", "fr")).text;
  assert.match(week, /12–18 mai 2092/);
  const sessions = (await render(null, `/sessions?month=${MONTH}`, "fr")).text;
  assert.match(sessions, /6 places restantes/);
  assert.match(sessions, /1 place restante/);
  assert.match(sessions, /Ajouter au panier/);
  const en = (await render(null, `/sessions?month=${MONTH}`, "en")).text;
  assert.match(en, /May 2092/);
  assert.match(en, /6 places left/);
});

test("French counts of 0 and 1 are singular (0 vote, 0 participant, 0 inscrit, 1 place restante), English is unchanged", async () => {
  const charity = (await render(member, "/charity", "fr")).text;
  assert.match(charity, />0 vote</);
  assert.match(charity, />2 votes</);
  assert.doesNotMatch(charity, />[01] votes</);
  const meetings = (await render(member, `/meetings?month=${MONTH}`, "fr")).text;
  assert.doesNotMatch(meetings, /\b[01] participants/);
  assert.match(meetings, /\b[01] participant\b/);
  const sessions = (await render(null, `/sessions?month=${MONTH}`, "fr")).text;
  assert.doesNotMatch(sessions, /\b[01] places restantes/);
  const en = (await render(member, "/charity", "en")).text;
  assert.match(en, />0 votes</);
});

test("the .ics download is event data and stays as stored", async () => {
  const res = await fetch(`${app.base}/events/${eventId}/ics`, { headers: { cookie: "umasbooks_lang=fr" } });
  const text = await res.text();
  assert.equal(res.status, 200);
  assert.match(text, new RegExp(`SUMMARY:${MARK} event`));
});

test("server messages are French with the fr cookie and English without", async () => {
  // Contact form validation.
  const bad = { name: "", email: "nope", message: "", topic: "Events" };
  const fr = await post(null, "/contact", bad, "fr");
  assert.equal(fr.status, 303);
  assert.equal(fr.location, "/fr/contact", "a French visitor lands on the French address of the page");
  assert.match(fr.text, /Veuillez indiquer votre nom, une adresse e-mail valide et votre message\./);
  assert.match(fr.text, /<option value="Events"[^>]*>Événements<\/option>/);
  const en = await post(null, "/contact", bad, "en");
  assert.match(en.text, /Please fill in your name, a valid email address and your message\./);
  // Forum new-thread validation (members only).
  const frForum = await post(member, "/forum/new", { title: "", body: "" }, "fr");
  assert.equal(frForum.status, 303);
  assert.equal(frForum.location, "/forum/new");
  assert.match(frForum.text, /Le titre et le message sont tous deux obligatoires\./);
  const enForum = await post(member, "/forum/new", { title: "", body: "" }, "en");
  assert.match(enForum.text, /Title and message are both required\./);
  // Report without a reason: plain-text message.
  const noReason = await post(member, "/forum/report", { kind: "thread", id: String(threadId), reason: "bogus" }, "fr");
  assert.equal(noReason.status, 303);
  assert.equal(noReason.location, `/forum/${threadId}`);
  assert.match(noReason.text, /Veuillez choisir un motif/);
  // The report confirmation notice.
  const notice = await render(member, `/forum/${threadId}?reported=1`, "fr");
  assert.match(notice.text, /Merci, nous allons l’examiner\./);
  // Missing thread / event / shift responses.
  assert.match((await render(member, "/forum/99999999", "fr")).text, /Discussion introuvable\./);
  assert.match((await render(null, "/events/99999999/ics", "fr")).text, /Événement introuvable\./);
});

test("the 4xx error page is translated", async () => {
  const { errorHandler } = require("../../src/lib/errorHandler");
  const { langMiddleware } = require("../../src/middleware/lang");
  const server = express();
  server.set("view engine", "ejs");
  server.set("views", path.join(__dirname, "..", "..", "views"));
  server.use(langMiddleware);
  server.use((req, res, next) => { res.locals.user = null; res.locals.cartCount = 0; next(); });
  server.get("/boom", () => { const err = new Error("bad"); err.status = 400; throw err; });
  server.use(errorHandler);
  const listener = await new Promise((resolve) => { const s = server.listen(0, "127.0.0.1", () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${listener.address().port}`;
    const get = async (lang) => (await fetch(`${base}/boom`, { headers: { cookie: `umasbooks_lang=${lang}` } })).text();
    const en = await get("en");
    const fr = await get("fr");
    assert.match(fr, /Cela n’a pas fonctionné/);
    assert.match(fr, /Cette demande n’a pas pu être comprise/);
    assert.match(en, /That request couldn&#39;t be understood/);
    assert.deepEqual(untranslated(en, fr, ALLOW), []);
  } finally {
    listener.close();
  }
});
