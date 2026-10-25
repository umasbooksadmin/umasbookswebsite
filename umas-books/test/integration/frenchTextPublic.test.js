// The French versions of events, sessions, announcements and charities on the customer side (lib/frenchText.js):
// a French page shows the French text when it is READY, else the English text inside lang="en" with a small EN tag
// and a note; an English page never shows French; /api/events/upcoming?lang=fr and the .ics file follow the same rule;
// French text is escaped (or sanitised, for an announcement's content) exactly like the English.
// In-process routes + real views on an own throwaway database (the dashboard and the vote read "the" live rows).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");
const { makeClient, makeUser, uniq } = require("../helpers/routeClient");

const db = prepareDatabase("french_text_public", { isolated: true });
const { pool } = require("../../src/db");

let server;
let c;
let member;
const FR = { cookie: "umasbooks_lang=fr" };
const EN = { cookie: "umasbooks_lang=en" };
const noon = (y, m, d) => new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;").replace(/"/g, "&#34;");

before(async () => {
  db.create();
  const app = buildApp([require("../../src/routes/events"), require("../../src/routes/sessions"), require("../../src/routes/dashboard"), require("../../src/routes/charity")]);
  app.locals.mondayFirstWeeks = require("../../src/lib/calendar").mondayFirstWeeks;
  server = await listen(app);
  c = makeClient(server.base);
  member = await makeUser(pool, { member: true });
});
after(async () => {
  await server.close();
  await pool.end();
  db.drop();
});

async function makeEvent(at, fields = {}) {
  const t = fields.title || `Event ${uniq()}`;
  const { rows } = await pool.query(
    "INSERT INTO events (title, description, location, starts_at, title_fr, description_fr, location_fr) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    [t, fields.description === undefined ? "English description" : fields.description, fields.location === undefined ? "English place" : fields.location, at,
      fields.title_fr ?? null, fields.description_fr ?? null, fields.location_fr ?? null]
  );
  return { id: rows[0].id, title: t };
}
// The event's own <details> block on a calendar page.
const block = (html, title) => {
  const at = html.indexOf(esc(title));
  assert.ok(at > 0, `${title} is on the page`);
  return html.slice(html.lastIndexOf("<details", at), html.indexOf("</details>", at));
};

// ---------------------------------------------------------------- events

test("events: a French page shows the ready French title, description and place; an English page the English ones", async () => {
  const ev = await makeEvent(noon(2091, 5, 14), { title_fr: `Titre ${uniq()}`, description_fr: "Description française", location_fr: "La librairie" });
  const fr = block((await c.get("/events?month=2091-05", { headers: FR })).text, (await pool.query("SELECT title_fr FROM events WHERE id = $1", [ev.id])).rows[0].title_fr);
  assert.ok(fr.includes("Description française") && fr.includes("La librairie"));
  assert.ok(!fr.includes("English description") && !fr.includes("English place"));
  assert.ok(!fr.includes('lang="en"') && !fr.includes("fcal-lang"), "French text has no English marker");
  const en = (await c.get("/events?month=2091-05", { headers: EN })).text;
  assert.ok(en.includes(esc(ev.title)) && en.includes("English description"));
  assert.ok(!en.includes("Description française") && !en.includes("La librairie"), "an English page never shows French");
});

test("events: with no French, or French that is not ready, a French page shows the English text in lang=en with the EN tag and a note", async () => {
  const none = await makeEvent(noon(2091, 6, 14));
  const partial = await makeEvent(noon(2091, 6, 15), { title_fr: "Titre seul" }); // the English has a description, the French has none: not ready
  const page = (await c.get("/events?month=2091-06", { headers: FR })).text;
  for (const ev of [none, partial]) {
    const b = block(page, ev.title);
    assert.match(b, new RegExp(`<div class="fcal-session-title" lang="en">${esc(ev.title)} <span class="fcal-lang"><span aria-hidden="true">EN</span>`));
    assert.match(b, /<p class="fcal-notice small" role="note">Cet événement n’est décrit qu’en anglais\.<\/p>/);
    assert.match(b, /<p class="muted small" lang="en">English description<\/p>/);
    assert.match(b, /<span lang="en">English place<\/span>/);
  }
  assert.ok(!block(page, partial.title).includes("Titre seul"), "a half-written French title is not shown");
  const en = block((await c.get("/events?month=2091-06", { headers: EN })).text, none.title);
  assert.ok(!en.includes("fcal-lang") && !en.includes("fcal-notice"), "no marker on an English page");
});

test("events: an event whose English has no description needs only a French title; a French place is optional", async () => {
  const ev = await makeEvent(noon(2091, 7, 14), { description: null, location: "English place", title_fr: `Seulement ${uniq()}` });
  const t = (await pool.query("SELECT title_fr FROM events WHERE id = $1", [ev.id])).rows[0].title_fr;
  const b = block((await c.get("/events?month=2091-07", { headers: FR })).text, t);
  assert.ok(!b.includes("fcal-lang"), "ready");
  assert.ok(b.includes("English place"), "no French place: the English one is shown");
});

test("events: French text is escaped like the English (markup never reaches the page)", async () => {
  const bad = `<script>alert('x')</script>${uniq()}`;
  await makeEvent(noon(2091, 8, 14), { title_fr: bad, description_fr: '<img src=x onerror="alert(1)">', location_fr: "<b>Loft</b>" });
  const text = (await c.get("/events?month=2091-08", { headers: FR })).text;
  assert.ok(!text.includes("<script>alert('x')") && !text.includes("<img src=x onerror") && !text.includes("<b>Loft</b>"));
  assert.ok(text.includes("&lt;script&gt;") && text.includes("&lt;b&gt;Loft&lt;/b&gt;"));
});

test("GET /api/events/upcoming?lang=fr: language-aware title, description and place, with the language of the text; default and ?lang=en are English", async () => {
  const soon = new Date(Date.now() + 3 * 86400000);
  await pool.query("DELETE FROM events");
  const ready = await makeEvent(soon, { title_fr: "Prêt", description_fr: "Description prête", location_fr: "Ici" });
  const notReady = await makeEvent(new Date(soon.getTime() + 3600000), { title_fr: "Pas prêt" });
  const get = async (q) => JSON.parse((await c.get(`/api/events/upcoming${q}`)).text);
  const fr = await get("?lang=fr");
  const a = fr.find((e) => e.id === ready.id);
  assert.deepEqual([a.title, a.description, a.location, a.lang], ["Prêt", "Description prête", "Ici", "fr"]);
  const b = fr.find((e) => e.id === notReady.id);
  assert.deepEqual([b.title, b.description, b.location, b.lang], [notReady.title, "English description", "English place", "en"], "not ready: all English, and it says so");
  for (const q of ["", "?lang=en", "?lang=de", "?lang[]=fr"]) {
    const list = await get(q);
    const e = list.find((x) => x.id === ready.id);
    assert.deepEqual([e.title, e.description, e.location, e.lang], [ready.title, "English description", "English place", "en"], q || "(none)");
  }
});

test("the .ics file follows the visitor's language: French text when ready, else English", async () => {
  const ev = await makeEvent(noon(2091, 9, 14), { title_fr: "Titre ICS", description_fr: "Desc ICS", location_fr: "Lieu ICS" });
  const fr = await c.get(`/events/${ev.id}/ics`, { headers: FR });
  assert.match(fr.text, /SUMMARY:Titre ICS/);
  assert.match(fr.text, /DESCRIPTION:Desc ICS/);
  assert.match(fr.text, /LOCATION:Lieu ICS/);
  const en = await c.get(`/events/${ev.id}/ics`, { headers: EN });
  assert.match(en.text, new RegExp(`SUMMARY:${ev.title}`));
  assert.ok(!en.text.includes("ICS"));
  const half = await makeEvent(noon(2091, 9, 15), { title_fr: "Titre seul" });
  assert.match((await c.get(`/events/${half.id}/ics`, { headers: FR })).text, new RegExp(`SUMMARY:${half.title}`), "not ready: English");
});

// ---------------------------------------------------------------- sessions

async function makeSession(at, title, titleFr, dropin = null) {
  const { rows } = await pool.query("INSERT INTO classes (title, title_fr, starts_at, capacity, dropin_price) VALUES ($1, $2, $3, 5, $4) RETURNING id", [title, titleFr, at, dropin]);
  return rows[0].id;
}

test("sessions: a French page shows the French title; without one, the English title in lang=en with the EN tag; the colour still follows the English title", async () => {
  const withFr = `Little Explorers ${uniq()}`;
  const without = `Teen Literature ${uniq()}`;
  await makeSession(noon(2091, 10, 14), withFr, "Petits Explorateurs matin");
  await makeSession(noon(2091, 10, 15), without, null, 8);
  const fr = (await c.get("/sessions?month=2091-10", { headers: FR })).text;
  assert.match(fr, /<div class="fcal-session tone-a">\s*<div class="fcal-session-title">Petits Explorateurs matin<\/div>/, "French title, colour from 'Little Explorers'");
  assert.ok(!fr.includes(withFr), "the English title is not shown next to the French one");
  assert.match(fr, new RegExp(`tone-e">\\s*<summary>\\s*<div class="fcal-session-title" lang="en">${without} <span class="fcal-lang"><span aria-hidden="true">EN</span>`));
  const en = (await c.get("/sessions?month=2091-10", { headers: EN })).text;
  assert.ok(en.includes(withFr) && !en.includes("Petits Explorateurs matin") && !en.includes("fcal-lang"));
});

test("sessions: a French title is escaped", async () => {
  await makeSession(noon(2091, 11, 14), `Esc ${uniq()}`, "<script>alert(3)</script>");
  const text = (await c.get("/sessions?month=2091-11", { headers: FR })).text;
  assert.ok(!text.includes("<script>alert(3)") && text.includes("&lt;script&gt;alert(3)&lt;/script&gt;"));
});

// ---------------------------------------------------------------- announcements

async function makeAnnouncement(fields) {
  const title = fields.title || `Ann ${uniq()}`;
  await pool.query(
    `INSERT INTO announcements (title, excerpt, body, status, published_at, is_pinned, title_fr, excerpt_fr, body_fr)
     VALUES ($1, $2, $3, 'published', now() - interval '1 minute', $4, $5, $6, $7)`,
    [title, fields.excerpt ?? null, fields.body || "<p>English body</p>", fields.pinned || false, fields.title_fr ?? null, fields.excerpt_fr ?? null, fields.body_fr ?? null]
  );
  return title;
}

test("announcements (member home and /announcements): French when ready, else English with lang=en and the EN tag; English pages never show French", async () => {
  await pool.query("DELETE FROM announcements");
  const ready = await makeAnnouncement({ title: "Ready one", excerpt: "Eng summary", title_fr: "Prête", excerpt_fr: "Résumé prêt", body_fr: "<p>Corps <b>prêt</b></p>", pinned: true });
  const plain = await makeAnnouncement({ title: "Plain one" });
  for (const path of ["/dashboard", "/announcements"]) {
    const fr = (await c.get(path, { as: member, headers: FR })).text;
    assert.ok(fr.includes("Prête") && fr.includes("Résumé prêt"), `${path}: French shown`);
    assert.ok(!fr.includes(">Ready one") && !fr.includes("Eng summary"), `${path}: no English next to it`);
    assert.match(fr, /<h[23] lang="en">Plain one <span class="dash-lang"><span aria-hidden="true">EN<\/span>/, `${path}: fallback marked`);
    assert.match(fr, /class="rich-content" lang="en"><p>English body<\/p>|<p lang="en">/, `${path}: fallback text is lang=en`);
    const en = (await c.get(path, { as: member, headers: EN })).text;
    assert.ok(en.includes(ready) && en.includes("Plain one") && !en.includes("Prête") && !en.includes("dash-lang"), `${path}: English page`);
  }
  const full = (await c.get("/announcements", { as: member, headers: FR })).text;
  assert.ok(full.includes("<p>Corps <b>prêt</b></p>"), "the French content is shown (formatting kept)");
});

test("announcements: a French content row that got into the table unsanitised is cleaned when served", async () => {
  await pool.query("DELETE FROM announcements");
  await makeAnnouncement({ title: "Evil", title_fr: "Mal", body_fr: '<p onclick="alert(1)">F</p><script>alert(2)</script><img src=x onerror=alert(3)><a href="javascript:alert(4)">l</a><b>ok</b>' });
  for (const path of ["/dashboard", "/announcements"]) {
    const text = (await c.get(path, { as: member, headers: FR })).text;
    assert.ok(!/<script>alert\(2\)|onclick=|onerror=|javascript:alert/i.test(text), path);
    assert.ok(text.includes("<b>ok</b>"), path);
  }
});

test("announcements: a French title with markup is escaped", async () => {
  await pool.query("DELETE FROM announcements");
  await makeAnnouncement({ title: "Esc", excerpt: "e", title_fr: "<script>alert(7)</script>", excerpt_fr: "<i>x</i>", body_fr: "<p>ok</p>" });
  const text = (await c.get("/announcements", { as: member, headers: FR })).text;
  assert.ok(!text.includes("<script>alert(7)") && !text.includes("<i>x</i>"));
  assert.ok(text.includes("&lt;script&gt;alert(7)&lt;/script&gt;"));
});

// ---------------------------------------------------------------- charity vote

test("charity vote: French question and descriptions when written; else English with lang=en and the EN tag", async () => {
  await pool.query("DELETE FROM charity_rounds");
  const { rows: ch } = await pool.query(
    `INSERT INTO charities (name, description, description_fr) VALUES ('Charity A', 'English A', 'Française A'), ('Charity B', 'English B', NULL) RETURNING id`
  );
  const { rows: r } = await pool.query("INSERT INTO charity_rounds (title, title_fr, visible_to, is_active) VALUES ('Which charity?', 'Quelle association ?', 'everyone', TRUE) RETURNING id");
  for (const x of ch) await pool.query("INSERT INTO charity_options (round_id, charity_id, name) VALUES ($1, $2, 'x')", [r[0].id, x.id]);
  const fr = (await c.get("/charity", { headers: FR })).text;
  assert.match(fr, /Quelle association[\s\u00a0\u202f]\?/, "the French typography puts a no-break space before the ?");
  assert.ok(fr.includes("Française A"));
  assert.ok(!fr.includes("Which charity") && !fr.includes("English A"));
  assert.match(fr, /<div class="muted small" lang="en">English B <span class="charity-lang"><span aria-hidden="true">EN<\/span>/);
  assert.ok(fr.includes("Charity A") && fr.includes("Charity B"), "names stay as they are");
  const en = (await c.get("/charity", { headers: EN })).text;
  assert.ok(en.includes("Which charity?") && en.includes("English A") && !en.includes("Française A") && !en.includes("charity-lang"));
  await pool.query("UPDATE charity_rounds SET title_fr = NULL");
  const noTitle = (await c.get("/charity", { headers: FR })).text;
  assert.match(noTitle, /<span lang="en">Which charity[\s\u00a0\u202f]?\?<\/span> <span class="charity-lang">/);
});

test("charity vote: French text is escaped", async () => {
  await pool.query("DELETE FROM charity_rounds");
  const { rows: ch } = await pool.query("INSERT INTO charities (name, description, description_fr) VALUES ('C', 'e', '<script>alert(8)</script>') RETURNING id");
  const { rows: r } = await pool.query("INSERT INTO charity_rounds (title, title_fr, visible_to, is_active) VALUES ('T', '<img src=x onerror=alert(9)>', 'everyone', TRUE) RETURNING id");
  await pool.query("INSERT INTO charity_options (round_id, charity_id, name) VALUES ($1, $2, 'x')", [r[0].id, ch[0].id]);
  const text = (await c.get("/charity", { headers: FR })).text;
  assert.ok(!text.includes("<script>alert(8)") && !text.includes("<img src=x onerror"));
  assert.ok(text.includes("&lt;script&gt;alert(8)&lt;/script&gt;"));
});
