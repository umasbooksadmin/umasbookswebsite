// Event sign-up: feedback, past events, the "you're signed up" email and its cancel link
// (src/routes/events.js, src/lib/eventSignups.js; reviews 6A L3 and 6B M4).
//
// In-process so the mailer can be stubbed and the sent mail read. Every row uses a unique title and email: in CI
// the database is shared, so this file asks for its own (isolated).

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");
const { makeClient, uniq } = require("../helpers/routeClient");

const db = prepareDatabase("event_signup_feedback", { isolated: true });
const mailer = require("../../src/mailer");
const sent = [];
mailer.sendMail = async (opts) => { sent.push(opts); };
const { pool } = require("../../src/db");
const { eventSignupLimiter } = require("../../src/middleware/rateLimits");

let server;
let c;

const noon = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
const FR = { headers: { "accept-language": "fr" } };

before(async () => {
  db.create();
  const app = buildApp([require("../../src/routes/events")]);
  app.locals.mondayFirstWeeks = require("../../src/lib/calendar").mondayFirstWeeks;
  server = await listen(app);
  c = makeClient(server.base);
});
after(async () => {
  await server.close();
  await pool.end();
  db.drop();
});
beforeEach(() => eventSignupLimiter.resetKey("127.0.0.1"));

async function makeEvent(at, { capacity = null, price = null, titleFr = null, location = null } = {}) {
  const title = `Event ${uniq()}`;
  const { rows } = await pool.query(
    "INSERT INTO events (title, title_fr, location, starts_at, capacity, price) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    [title, titleFr, location, at, capacity, price]
  );
  return { id: rows[0].id, title };
}
const signups = async (id) => (await pool.query("SELECT * FROM event_signups WHERE event_id = $1 ORDER BY id", [id])).rows;
const email = (tag) => `${tag}-${uniq()}@example.test`;
const mailTo = (to) => sent.filter((m) => m.to === to);
const linkIn = (text) => (String(text).match(/\/events\/cancel\/([a-f0-9]{64})/) || [])[1];

test("a past event, or one that has started, refuses a sign-up with a message (EN and FR) and stores nothing", async () => {
  const past = await makeEvent(noon(2020, 5, 14));
  const started = await makeEvent(new Date(Date.now() - 30 * 60 * 1000));
  for (const ev of [past, started]) {
    const to = email("past");
    const r = await c.post(`/events/${ev.id}/signup?month=2020-05`, { name: "Late", email: to });
    assert.equal(r.seeOther, "/events?month=2020-05");
    assert.match(r.text, new RegExp(`“${ev.title}” has already started or taken place, so sign-ups are closed\\.`));
    assert.equal((await signups(ev.id)).length, 0);
    assert.equal(mailTo(to).length, 0, "no email for a refused sign-up");
  }
  const fr = await c.post(`/events/${past.id}/signup`, { name: "Tard", email: email("pastfr") }, FR);
  assert.match(fr.text, /a déjà commencé ou a déjà eu lieu\u00a0: les inscriptions sont closes\./);
  assert.equal((await signups(past.id)).length, 0);
});

test("a past event shows no sign-up form on the calendar; a future one does", async () => {
  const past = await makeEvent(noon(2020, 6, 10));
  const page = await c.get("/events?month=2020-06");
  assert.ok(page.text.includes(`/events/${past.id}/ics`), "the event is listed");
  assert.ok(!page.text.includes(`/events/${past.id}/signup`), "but has no sign-up form");
  assert.match(page.text, /This event has already started or taken place: sign-ups are closed\./);
  const future = await makeEvent(noon(2093, 1, 10));
  assert.ok((await c.get("/events?month=2093-01")).text.includes(`/events/${future.id}/signup`));
});

test("a sign-up says so on the page and sends an English email with a working cancel link and the calendar file", async () => {
  const ev = await makeEvent(noon(2093, 2, 10), { capacity: 5, price: 8, location: "The Loft" });
  const to = email("ok");
  const r = await c.post(`/events/${ev.id}/signup?month=2093-02`, { name: "Ada Lovelace", email: to });
  assert.equal(r.seeOther, "/events?month=2093-02");
  assert.match(r.text, new RegExp(`You’re signed up for “${ev.title}”\\. We’ve sent a confirmation to ${to.replace(/[.]/g, "\\.")}, with a link to cancel if you need to\\.`));
  // Shown once: a reload of the calendar does not repeat it.
  assert.doesNotMatch((await c.get("/events?month=2093-02")).text, /You’re signed up for/);

  const [mail] = mailTo(to);
  assert.ok(mail, "one email to the address that was typed");
  assert.equal(mailTo(to).length, 1);
  assert.equal(mail.subject, `You're signed up: ${ev.title}`);
  assert.match(mail.text, /^Hi Ada Lovelace,/);
  assert.match(mail.text, new RegExp(`You're signed up for "${ev.title}" on 10 February 2093 at 13:00 \\(The Loft\\) at Uma's Books\\.`));
  assert.match(mail.text, /Price: €8\.00, paid on the day\./);
  assert.ok(mail.text.includes(`${server.base}/events/${ev.id}/ics`));
  assert.match(mail.text, /didn't sign up yourself\? Cancel this sign-up here/);
  const token = linkIn(mail.text);
  assert.ok(token, "the email has a cancel link");
  assert.ok(mail.text.includes(`${server.base}/events/cancel/${token}`));
  // Only the token's hash is stored, never the token; the sent mail's body is blanked in the outbox.
  const [row] = await signups(ev.id);
  assert.equal(row.cancel_token_hash, crypto.createHash("sha256").update(token).digest("hex"));
  const { rows: ob } = await pool.query("SELECT status, lang, body_text FROM email_outbox WHERE kind = 'event_signup' AND to_email = $1", [to]);
  assert.equal(ob.length, 1);
  assert.equal(ob[0].lang, "en");
  assert.equal(ob[0].status, "sent");
  assert.equal(ob[0].body_text, "");
});

test("a French sign-up gets the French page message and a French email (French title when ready)", async () => {
  const ev = await makeEvent(noon(2093, 3, 10), { titleFr: "Club de lecture" });
  const to = email("fr");
  const r = await c.post(`/events/${ev.id}/signup`, { name: "Marie", email: to }, FR);
  assert.match(r.text, /Votre inscription à «[\s\u00a0\u202f]Club de lecture[\s\u00a0\u202f]» est enregistrée\. Nous avons envoyé une confirmation à/);
  const [mail] = mailTo(to);
  assert.equal(mail.subject, "Inscription enregistrée\u00a0: Club de lecture");
  assert.match(mail.text, /^Bonjour Marie,/);
  assert.match(mail.text, /Votre inscription à «\u00a0Club de lecture\u00a0» le 10 mars 2093 à 13:00 chez Uma's Books est bien enregistrée\./);
  assert.match(mail.text, /ce n'est pas vous qui avez fait cette inscription\u00a0\? Annulez-la ici/);
  const token = linkIn(mail.text);
  assert.ok(mail.text.includes(`${server.base}/events/cancel/${token}`), "the link is intact in the French text");
  const { rows: [ob] } = await pool.query("SELECT lang FROM email_outbox WHERE kind = 'event_signup' AND to_email = $1", [to]);
  assert.equal(ob.lang, "fr");
});

test("the cancel link: GET only asks; the button deletes the sign-up; a second press and the old link say it is already cancelled", async () => {
  const ev = await makeEvent(noon(2093, 4, 10), { capacity: 3 });
  const to = email("cancel");
  await c.post(`/events/${ev.id}/signup`, { name: "Grace", email: to });
  const token = linkIn(mailTo(to)[0].text);

  const ask = await c.get(`/events/cancel/${token}`);
  assert.equal(ask.status, 200);
  assert.equal(ask.res.headers.get("cache-control"), "no-store");
  assert.equal(ask.res.headers.get("referrer-policy"), "no-referrer");
  assert.ok(ask.text.includes(ev.title));
  assert.match(ask.text, new RegExp(`action="/events/cancel/${token}"`));
  assert.equal((await signups(ev.id)).length, 1, "opening the link changes nothing (mail scanners open links)");

  const done = await c.post(`/events/cancel/${token}`, {});
  assert.equal(done.seeOther, `/events/cancel/${token}`);
  assert.match(done.text, new RegExp(`Your sign-up for “${ev.title}” is cancelled, and your name and email have been deleted from it\\.`));
  assert.equal((await signups(ev.id)).length, 0);
  assert.match((await c.get(`/events?month=2093-04`)).text, /0 going/);

  const twice = await c.post(`/events/cancel/${token}`, {});
  assert.match(twice.text, /This sign-up is already cancelled, or this link is not valid\./);
  const old = await c.get(`/events/cancel/${token}`);
  assert.equal(old.status, 404);
  assert.match(old.text, /already cancelled, or this link is not valid/);
  const frOld = await c.get(`/events/cancel/${token}`, FR);
  assert.match(frOld.text, /Cette inscription est déjà annulée, ou ce lien n’est pas valable\./);

  for (const bad of ["0".repeat(64), "not-a-token", "A".repeat(64)]) {
    assert.equal((await c.get(`/events/cancel/${bad}`)).status, 404, bad);
    assert.match((await c.post(`/events/cancel/${bad}`, {})).text, /already cancelled, or this link is not valid/);
  }
});

test("a cancel frees the place: a full event takes the next person after a cancel", async () => {
  const ev = await makeEvent(noon(2093, 5, 10), { capacity: 1 });
  const a = email("a");
  const b = email("b");
  await c.post(`/events/${ev.id}/signup`, { name: "A", email: a });
  assert.match((await c.post(`/events/${ev.id}/signup`, { name: "B", email: b })).text, /is full: your sign-up was not recorded/);
  assert.equal(mailTo(b).length, 0);
  await c.post(`/events/cancel/${linkIn(mailTo(a)[0].text)}`, {});
  assert.match((await c.post(`/events/${ev.id}/signup`, { name: "B", email: b })).text, /You’re signed up for/);
  const rows = await signups(ev.id);
  assert.deepEqual(rows.map((r) => r.email), [b]);
});

test("the person who took the last place and signs up again is told they are already signed up, not that it is full", async () => {
  const ev = await makeEvent(noon(2093, 6, 10), { capacity: 1 });
  const to = email("last");
  await c.post(`/events/${ev.id}/signup`, { name: "Last", email: to });
  const again = await c.post(`/events/${ev.id}/signup`, { name: "Last", email: to });
  assert.match(again.text, /This email address is already signed up for “.*”\. To cancel, use the link in the email we sent you\./);
  assert.equal(mailTo(to).length, 1, "no second email");
});

test("an address over its daily budget of sign-up emails is refused with 'try again later', and nothing is stored", async () => {
  const ev = await makeEvent(noon(2093, 7, 10));
  const to = email("budget");
  for (let i = 0; i < 5; i++) {
    await pool.query("INSERT INTO email_outbox (to_email, subject, body_text, kind, status) VALUES ($1, 's', '', 'event_signup', 'sent')", [to]);
  }
  const r = await c.post(`/events/${ev.id}/signup`, { name: "Spammed", email: to });
  assert.match(r.text, /We can’t take this sign-up right now\. Please try again later, or email us at admin@umasbooks\.org\./);
  assert.equal((await signups(ev.id)).length, 0, "no sign-up without its email");
  assert.equal(mailTo(to).length, 0);
  // The event's own budget is separate from the account mails: a password-reset mail to that address is not counted.
  const other = email("budget2");
  for (let i = 0; i < 5; i++) {
    await pool.query("INSERT INTO email_outbox (to_email, subject, body_text, kind, status) VALUES ($1, 's', '', 'password_reset', 'sent')", [other]);
  }
  assert.match((await c.post(`/events/${ev.id}/signup`, { name: "Fine", email: other })).text, /You’re signed up for/);
});

test("the per-connection limit still applies to sign-ups (10 an hour)", async () => {
  const ev = await makeEvent(noon(2093, 8, 10));
  const statuses = [];
  for (let i = 0; i < 11; i++) statuses.push((await c.post(`/events/${ev.id}/signup`, { name: "Bot", email: email(`ip${i}`) })).status);
  assert.deepEqual(statuses.slice(0, 10), Array(10).fill(200));
  assert.equal(statuses[10], 429);
  assert.equal((await signups(ev.id)).length, 10);
});
