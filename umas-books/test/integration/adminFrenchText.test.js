// The optional French version in the admin editors of events, sessions, announcements and charities (the blog has its
// own, adminBlogFrench.test.js): the French fields are saved (blank = NULL), sanitised like the English ones, shown again
// in the editor with a "French: missing / draft / ready" status, escaped everywhere; and "Translate to French"
// (lib/frenchTranslate.js, routes/admin/frenchText.js) fills the form only: AI mocked, failures explained, nothing
// saved by itself, one call of the shared cap per press, admins only, counts-only audit entry.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { adminHarness } = require("../helpers/adminHarness");
const anthropic = require("../../src/lib/anthropic");

const h = adminHarness("adminfrenchtext", ["events", "sessions", "announcements", "charity", "frenchText"], { isolated: true });
before(h.start);
after(h.stop);

const realAsk = anthropic.askText;
let calls;
let reply;
beforeEach(() => {
  calls = [];
  reply = { text: null, reason: "no_key" };
  anthropic.askText = async (prompt, opts) => { calls.push({ prompt, opts }); return typeof reply === "function" ? reply(prompt) : reply; };
});
after(() => { anthropic.askText = realAsk; });

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/'/g, "&#39;").replace(/"/g, "&#34;");
const MONTH = "2093-03";
// The little "French: <status>" flag under an event, a session or a charity, and the one in the editor's legend.
const pill = (state) => new RegExp(`French(?: title)?: <span class="status-pill (?:published|scheduled|draft)">${state}</span>`);
const legend = (state) => new RegExp(`<span class="status-pill (?:published|scheduled|draft)">French: ${state}</span>`);

async function newEvent(extra = {}) {
  const title = extra.title || `Event ${h.uniq()}`;
  const [{ id }] = await h.q(
    "INSERT INTO events (title, description, location, starts_at, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    [title, extra.description === undefined ? "An English description" : extra.description, extra.location === undefined ? "The shop" : extra.location, "2093-03-10T10:00:00Z", h.admin.id]
  );
  return { id, title };
}
const editEvent = (e, fields) => h.post(`/admin/events/${e.id}?month=${MONTH}`, { title: e.title, startsAt: "2093-03-10T10:00", ...fields });
const eventRow = async (id) => (await h.q("SELECT * FROM events WHERE id = $1", [id]))[0];

// ---------------------------------------------------------------- events

test("events: the French title, description and place are saved, shown again in the editor, and blank means NULL", async () => {
  const e = await newEvent();
  await editEvent(e, { description: "An English description", location: "The shop", title_fr: "Titre", description_fr: "Une description", location_fr: "La boutique" });
  let r = await eventRow(e.id);
  assert.deepEqual([r.title_fr, r.description_fr, r.location_fr], ["Titre", "Une description", "La boutique"]);
  assert.equal(r.title, e.title, "the English columns are untouched");
  const page = (await h.get(`/admin/events?month=${MONTH}`)).text;
  assert.ok(page.includes('name="title_fr"') && page.includes('value="Titre"') && page.includes("Une description") && page.includes('value="La boutique"'));
  assert.match(page, /French version/);
  await editEvent(e, { description: "An English description", title_fr: "  ", description_fr: "", location_fr: "" });
  r = await eventRow(e.id);
  assert.deepEqual([r.title_fr, r.description_fr, r.location_fr], [null, null, null]);
});

test("events: the French status is missing, draft (some French, not enough) or ready (title, and description when the English has one)", async () => {
  const cases = [
    ["missing", {}, "missing"],
    ["place only", { location_fr: "Ici" }, "draft"],
    ["title only, English has a description", { title_fr: "T" }, "draft"],
    ["title and description", { title_fr: "T", description_fr: "D" }, "ready"],
  ];
  for (const [name, fields, want] of cases) {
    const e = await newEvent({ title: `FR status ${name} ${h.uniq()}` });
    await editEvent(e, { description: "An English description", ...fields });
    const page = (await h.get(`/admin/events?month=${MONTH}`)).text;
    const at = page.indexOf(esc(e.title));
    assert.ok(at > 0, name);
    const block = page.slice(at, page.indexOf("Delete event", at));
    assert.match(block, pill(want), name);
  }
  const noDesc = await newEvent({ description: null });
  await editEvent(noDesc, { description: "", title_fr: "T" });
  const page = (await h.get(`/admin/events?month=${MONTH}`)).text;
  const block = page.slice(page.indexOf(esc(noDesc.title)));
  assert.match(block.slice(0, block.indexOf("Delete event")), pill("ready"), "an event with no English description needs only a French title");
});

test("events: French text with markup is escaped in the admin page (stored as typed, never printed raw)", async () => {
  const e = await newEvent();
  await editEvent(e, { title_fr: '"><script>alert(1)</script>', description_fr: "</textarea><script>alert(2)</script>", location_fr: "<img src=x onerror=alert(3)>" });
  const page = (await h.get(`/admin/events?month=${MONTH}`)).text;
  assert.ok(!page.includes("<script>alert(1)") && !page.includes("<script>alert(2)") && !page.includes("<img src=x onerror"));
  assert.ok(page.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
});

test("events: a non-admin cannot save French text", async () => {
  const e = await newEvent();
  await h.post(`/admin/events/${e.id}`, { title: e.title, startsAt: "2093-03-10T10:00", title_fr: "Pirate" }, { user: h.member });
  assert.equal((await eventRow(e.id)).title_fr, null);
});

// ---------------------------------------------------------------- sessions

async function newSession(title = `Session ${h.uniq()}`) {
  const [{ id }] = await h.q(
    "INSERT INTO classes (title, starts_at, capacity, created_by) VALUES ($1, $2, 5, $3) RETURNING id", [title, "2093-03-11T10:00:00Z", h.admin.id]
  );
  return { id, title };
}
const editSession = (c, fields) => h.post(`/admin/sessions/${c.id}?month=${MONTH}`, { title: c.title, startsAt: "2093-03-11T10:00", capacity: "5", ...fields });

test("sessions: the French title is saved, blank means NULL, the status is shown, a refused save keeps the typed French title", async () => {
  const c = await newSession();
  let page = (await h.get(`/admin/sessions?month=${MONTH}`)).text;
  assert.match(page.slice(page.indexOf(esc(c.title))), pill("missing"));
  await editSession(c, { title_fr: "Séance du matin" });
  assert.equal((await h.q("SELECT title_fr, title FROM classes WHERE id = $1", [c.id]))[0].title_fr, "Séance du matin");
  page = (await h.get(`/admin/sessions?month=${MONTH}`)).text;
  assert.ok(page.includes('value="Séance du matin"'));
  assert.match(page.slice(page.indexOf(esc(c.title))), pill("ready"));
  const refused = await editSession(c, { title_fr: "Titre gardé", capacity: "abc" });
  assert.match(refused.text, /Capacity/);
  assert.ok(refused.text.includes("Titre gardé"), "the French title typed in a refused form is kept");
  assert.equal((await h.q("SELECT title_fr FROM classes WHERE id = $1", [c.id]))[0].title_fr, "Séance du matin", "and nothing was saved");
  await editSession(c, { title_fr: "" });
  assert.equal((await h.q("SELECT title_fr FROM classes WHERE id = $1", [c.id]))[0].title_fr, null);
});

test("sessions: a French title with markup is escaped in the admin page", async () => {
  const c = await newSession();
  await editSession(c, { title_fr: '<script>alert(5)</script>' });
  const page = (await h.get(`/admin/sessions?month=${MONTH}`)).text;
  assert.ok(!page.includes("<script>alert(5)") && page.includes("&lt;script&gt;alert(5)&lt;/script&gt;"));
});

// ---------------------------------------------------------------- announcements

const annRow = async (title) => (await h.q("SELECT * FROM announcements WHERE title = $1", [title]))[0];
const EVIL = '<p onclick="alert(1)">F</p><script>alert(2)</script><img src=x onerror=alert(3)><a href="javascript:alert(4)">l</a><iframe src="//e"></iframe><b>ok</b>';

test("announcements: the French title, summary and content are saved with a new announcement and with an edit; blank means NULL", async () => {
  const title = `Ann ${h.uniq()}`;
  await h.post("/admin/announcements", { title, excerpt: "Summary", body: "<p>English</p>", category: "General", statusAction: "publish", title_fr: "Annonce", excerpt_fr: "Résumé", body_fr: "<p>Français <strong>gras</strong></p>" });
  let r = await annRow(title);
  assert.deepEqual([r.title_fr, r.excerpt_fr, r.body_fr], ["Annonce", "Résumé", "<p>Français <strong>gras</strong></p>"]);
  const form = (await h.get(`/admin/announcements?edit=${r.id}`)).text;
  assert.ok(form.includes('name="title_fr"') && form.includes('value="Annonce"') && form.includes("Français <strong>gras</strong>"));
  await h.post(`/admin/announcements/${r.id}`, { title, excerpt: "Summary", body: "<p>English</p>", category: "General", statusAction: "publish", title_fr: "", excerpt_fr: " ", body_fr: "<p><br></p><div>&nbsp;</div>" });
  r = await annRow(title);
  assert.deepEqual([r.title_fr, r.excerpt_fr, r.body_fr], [null, null, null]);
  assert.equal(r.title, title);
});

test("announcements: the French content passes the same sanitising as the English; the French summary is capped like the English one", async () => {
  const title = `Ann xss ${h.uniq()}`;
  await h.post("/admin/announcements", { title, body: EVIL, category: "General", statusAction: "publish", title_fr: "T", body_fr: EVIL, excerpt_fr: "x".repeat(500) });
  const r = await annRow(title);
  for (const field of ["body", "body_fr"]) {
    assert.ok(!/<script|onclick|onerror|javascript:|<iframe|<img/i.test(r[field]), `${field}: ${r[field]}`);
    assert.ok(r[field].includes("<b>ok</b>"));
  }
  assert.equal(r.body, r.body_fr, "the same rules for both languages");
  assert.equal(r.excerpt_fr.length, 200);
});

test("announcements: the status (missing / draft / ready) is in the editor and the list; a French title with markup is escaped", async () => {
  const mk = async (name, fields, extra = {}) => {
    const title = `Ann status ${name} ${h.uniq()}`;
    await h.post("/admin/announcements", { title, body: "<p>English</p>", category: "General", statusAction: "publish", ...extra, ...fields });
    return { title, r: await annRow(title) };
  };
  const cases = [
    ["missing", {}, {}, "missing"],
    ["title only", { title_fr: "T" }, {}, "draft"],
    ["title and body", { title_fr: "T", body_fr: "<p>B</p>" }, {}, "ready"],
    ["English summary but no French one", { title_fr: "T", body_fr: "<p>B</p>" }, { excerpt: "Summary" }, "draft"],
    ["all three", { title_fr: "T", body_fr: "<p>B</p>", excerpt_fr: "R" }, { excerpt: "Summary" }, "ready"],
  ];
  for (const [name, fields, extra, want] of cases) {
    const { title, r } = await mk(name, fields, extra);
    const page = (await h.get(`/admin/announcements?edit=${r.id}&q=${encodeURIComponent(title)}`)).text;
    assert.match(page, legend(want), `${name}: editor`);
    assert.match(page, new RegExp(`${esc(title)}[\\s\\S]*?<td><span class="status-pill (?:published|scheduled|draft)">${want}</span></td>`), `${name}: list`);
  }
  const { r } = await mk("esc", { title_fr: '"><script>alert(7)</script>' });
  const page = (await h.get(`/admin/announcements?edit=${r.id}`)).text;
  assert.ok(!page.includes("<script>alert(7)") && page.includes("&lt;script&gt;alert(7)&lt;/script&gt;"));
});

// ---------------------------------------------------------------- charities

test("charities: the French description is saved from the library editor, the French question from the vote settings; blank means NULL", async () => {
  const name = `Charity ${h.uniq()}`;
  const [{ id }] = await h.q("INSERT INTO charities (name, description, created_by) VALUES ($1, 'English text', $2) RETURNING id", [name, h.admin.id]);
  await h.post(`/admin/charities/${id}`, { name, description: "English text", returnTab: "library", description_fr: "Texte français" });
  assert.equal((await h.q("SELECT description_fr FROM charities WHERE id = $1", [id]))[0].description_fr, "Texte français");
  const lib = (await h.get("/admin/charity?tab=library")).text;
  assert.ok(lib.includes("Texte français"));
  assert.match(lib.slice(lib.indexOf(esc(name))), /French: <span class="status-pill (?:published|scheduled|draft)">ready<\/span>/);
  await h.post(`/admin/charities/${id}`, { name, description: "English text", returnTab: "library", description_fr: "" });
  assert.equal((await h.q("SELECT description_fr FROM charities WHERE id = $1", [id]))[0].description_fr, null);

  const title = `Round ${h.uniq()}`;
  await h.post("/admin/charity-rounds", { title });
  const [round] = await h.q("SELECT * FROM charity_rounds WHERE title = $1", [title]);
  await h.post(`/admin/charity-rounds/${round.id}/settings`, { title, title_fr: "Quelle association ?" });
  assert.equal((await h.q("SELECT title_fr FROM charity_rounds WHERE id = $1", [round.id]))[0].title_fr, "Quelle association ?");
  assert.ok((await h.get("/admin/charity?tab=current")).text.includes("Quelle association ?"));
  await h.post(`/admin/charity-rounds/${round.id}/settings`, { title, title_fr: "<script>alert(6)</script>" });
  const page = (await h.get("/admin/charity?tab=current")).text;
  assert.ok(!page.includes("<script>alert(6)") && page.includes("&lt;script&gt;alert(6)&lt;/script&gt;"));
});

// ---------------------------------------------------------------- translate

const translate = async (kind, fields, opts) => {
  const user = opts && opts.user ? opts.user : await h.makeUser({ admin: true });
  const { res, text } = await h.post(`/admin/translate-french/${kind}`, fields, { user });
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { res, json, text };
};

test("Translate to French (event) returns the French WITHOUT saving it, with one call of the AI per press", async () => {
  const e = await newEvent();
  const before = await eventRow(e.id);
  reply = { text: "===TITLE===\nUn titre\n===DESCRIPTION===\nUne description\n===LOCATION===\nLa boutique", reason: null };
  const { res, json } = await translate("event", { title: e.title, description: "Hello <b>there</b>", location: "The shop" });
  assert.equal(res.status, 200);
  assert.deepEqual(json.values, { title_fr: "Un titre", description_fr: "Une description", location_fr: "La boutique" });
  assert.deepEqual(json.filled.sort(), ["description_fr", "location_fr", "title_fr"]);
  assert.match(json.notice, /nothing is saved until you do/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.feature, "translation");
  assert.ok(calls[0].prompt.includes("Hello <b>there</b>") && calls[0].prompt.includes("Uma's Books and Adventures"));
  assert.deepEqual(await eventRow(e.id), before, "nothing in the database changed");
});

test("Translate to French works for a session title, an announcement (HTML kept and sanitised), a charity description and a vote question", async () => {
  reply = { text: "===TITLE===\n\"Séance\"", reason: null };
  const s = await translate("session", { title: "Morning session" });
  assert.deepEqual(s.json.values, { title_fr: "Séance" }, "quotes removed");

  reply = { text: '===TITLE===\nAnnonce\n===EXCERPT===\nRésumé\n===BODY===\n```html\n<p onclick="x()">Corps <b>gras</b></p><script>alert(1)</script>\n```', reason: null };
  const a = await translate("announcement", { title: "Ann", excerpt: "Sum", body: "<p>Body <b>bold</b></p>" });
  assert.deepEqual(a.json.values, { title_fr: "Annonce", excerpt_fr: "Résumé", body_fr: "<p>Corps <b>gras</b></p>" }, "code fence removed, body sanitised");
  assert.match(calls[calls.length - 1].prompt, /HTML: keep every HTML tag/);

  reply = { text: "===DESCRIPTION===\nUne cause", reason: null };
  const c = await translate("charity", { description: "A cause" });
  assert.deepEqual(c.json.values, { description_fr: "Une cause" });
  reply = { text: "===TITLE===\nQuelle association ?", reason: null };
  const r = await translate("round", { title: "Which charity?" });
  assert.deepEqual(r.json.values, { title_fr: "Quelle association ?" });
});

test("only empty French fields are filled unless the admin chose to replace; text that already has French is not sent", async () => {
  reply = (prompt) => ({ text: prompt.includes("===DESCRIPTION===") ? "===TITLE===\nNouveau\n===DESCRIPTION===\nNouvelle description" : "===TITLE===\nNouveau", reason: null });
  const keep = await translate("event", { title: "T", description: "D", title_fr: "Mon titre" });
  assert.deepEqual(keep.json.filled, ["description_fr"]);
  assert.equal(keep.json.values.title_fr, "Mon titre");
  assert.ok(!calls[0].prompt.includes("===TITLE==="), "the title already has French and is not sent");
  const over = await translate("event", { title: "T", description: "D", title_fr: "Mon titre", overwrite: "1" });
  assert.deepEqual(over.json.filled.sort(), ["description_fr", "title_fr"]);
  assert.equal(over.json.values.title_fr, "Nouveau");
});

test("when there is nothing to translate the AI is not called", async () => {
  const none = await translate("event", { title: "", description: "" });
  assert.equal(none.res.status, 400);
  assert.match(none.json.error, /Write the English text first/);
  const full = await translate("session", { title: "T", title_fr: "Déjà" });
  assert.equal(full.res.status, 400);
  assert.match(full.json.error, /already filled in/);
  const long = await translate("announcement", { title: "T", body: `<p>${"x".repeat(25000)}</p>` });
  assert.equal(long.res.status, 400);
  assert.match(long.json.error, /too long to translate in one go/);
  const unknown = await translate("nothing", { title: "T" });
  assert.equal(unknown.res.status, 404);
  assert.equal(calls.length, 0);
});

test("each way the AI can fail gives the admin a sentence and changes nothing", async () => {
  const cases = [
    [{ text: null, reason: "no_key" }, 502, /no Anthropic API key/],
    [{ text: null, reason: "cap", message: "The daily AI limit has been reached (600 calls)." }, 429, /daily AI limit has been reached/],
    [{ text: null, reason: "credit" }, 502, /no credit left/],
    [{ text: null, reason: "rate" }, 502, /busy right now/],
    [{ text: null, reason: "timeout" }, 502, /took too long/],
    [{ text: null, reason: "error" }, 502, /did not give a usable answer/],
    [{ text: "I am sorry, I cannot do that.", reason: null }, 502, /did not give a usable answer/],
  ];
  for (const [r, status, re] of cases) {
    reply = r;
    const { res, json } = await translate("event", { title: "T", description: "D" });
    assert.equal(res.status, status, JSON.stringify(r));
    assert.match(json.error, re);
    assert.ok(!/no suggestions/.test(json.error));
  }
});

test("a partly usable answer fills what it can and says so", async () => {
  reply = { text: "===TITLE===\nSeul le titre", reason: null };
  const { json } = await translate("event", { title: "T", description: "D" });
  assert.deepEqual(json.filled, ["title_fr"]);
  assert.match(json.notice, /Part of it could not be translated/);
});

test("only an admin can translate; a member or a visitor gets no AI call", async () => {
  reply = { text: "===TITLE===\nUn titre", reason: null };
  for (const user of [h.member, null]) {
    const { res, text } = await h.post("/admin/translate-french/event", { title: "T" }, { user });
    assert.ok(res.status !== 200 || !text.includes("Un titre"));
  }
  assert.equal(calls.length, 0);
});

test("the button is limited to 10 presses a minute per admin, with the AI not called after that", async () => {
  reply = { text: "===TITLE===\nUn titre", reason: null };
  const admin = await h.makeUser({ admin: true });
  let last;
  for (let i = 0; i < 11; i++) last = await translate("session", { title: "T" }, { user: admin });
  assert.equal(last.res.status, 429);
  assert.equal(calls.length, 10);
});

test("translating leaves an entry in the admin activity log with counts only", async () => {
  await h.q("DELETE FROM admin_audit_log");
  reply = { text: "===TITLE===\nUn titre", reason: null };
  const { res } = await translate("event", { title: "Secret title text" });
  assert.equal(res.status, 200);
  const log = await h.q("SELECT action, detail FROM admin_audit_log WHERE action = 'french.translate'");
  assert.equal(log.length, 1);
  assert.match(log[0].detail, /^\d+ filled$/);
  assert.ok(!JSON.stringify(log).includes("Secret"));
});

// ---------------------------------------------------------------- markup

test("every editor has the French section with the Translate button and field names that match its handler; no inline script", () => {
  const view = (n) => fs.readFileSync(path.join(__dirname, "..", "..", "views", "admin", `${n}.ejs`), "utf8");
  const partial = fs.readFileSync(path.join(__dirname, "..", "..", "views", "partials", "admin_french_fields.ejs"), "utf8");
  for (const needle of ["French version", "Translate to French", "fr-translate-btn", "/admin/translate-french/<%= kind %>", 'name="<%= f.name %>_fr"', "data-fr-field"]) assert.ok(partial.includes(needle), needle);
  for (const n of ["events", "sessions", "announcements", "charity"]) {
    const v = view(n);
    assert.ok(v.includes("admin_french_fields") && v.includes("french-translate.js"), n);
    assert.doesNotMatch(v, /<script(?![^>]*\ssrc=)/i, `${n}: no inline script (the CSP blocks it)`);
  }
  assert.doesNotMatch(partial, /<script(?![^>]*\ssrc=)/i);
  const code = fs.readFileSync(path.join(__dirname, "..", "..", "public", "french-translate.js"), "utf8");
  assert.match(code, /data-translate-url/);
});
