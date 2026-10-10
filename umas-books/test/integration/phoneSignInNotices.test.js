// PH-11 and PH-31 against the real app.
//   PH-11: a members-only page used to send an account holder to the home page and a guest to the
//          log-in page without a word. Now: a guest is sent to log in (returnTo, with a reason on
//          the log-in page); an account holder who is not a member gets a short page, HTTP 403,
//          with a button to the membership page (volunteer calendar: the volunteer sign-up form).
//   PH-31: after a refused log-in the e-mail is still typed (never the password) and the
//          password box is the focused one.
// Own throwaway database (isolated:true): it creates its own accounts.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3992;
const PASSWORD = "PhoneNotice1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app, pool;
const who = {};

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  who.plain = await makeUser({});
  who.member = await makeUser({ member: true });
  who.volunteer = await makeUser({ member: true, volunteer: true });
  who.admin = await makeUser({ admin: true });
});
after(async () => {
  await pool.end();
  app.stop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function makeUser({ member = false, volunteer = false, admin = false }) {
  const email = `pn-${uniq()}@example.test`;
  await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_member, is_volunteer, is_admin, email_verified_at)
     VALUES ($1, $2, 'PN', $3, $4, $5, now())`,
    [email, await bcrypt.hash(PASSWORD, 10), member, volunteer, admin]
  );
  const jar = makeCookieJar();
  const res = await send(jar, "/login", { email, password: PASSWORD });
  assert.equal(res.status, 302, "test user can log in");
  return { email, jar };
}

async function send(jar, path, fields) {
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });
  jar.capture(res);
  return res;
}
async function get(jar, path, lang = "en") {
  const cookie = [jar && jar.header(), `umasbooks_lang=${lang}`].filter(Boolean).join("; ");
  const res = await fetch(`${app.base}${path}`, { redirect: "manual", headers: { cookie } });
  if (jar) jar.capture(res);
  return { res, status: res.status, location: res.headers.get("location"), text: await res.text() };
}

const MEMBER_PAGES = ["/forum", "/forum/1", "/forum/new", "/meetings", "/announcements", "/charity"];

test("guest: every members page sends to log in with returnTo (dashboard keeps the membership page)", async () => {
  for (const p of MEMBER_PAGES) {
    const r = await get(null, p);
    assert.equal(r.status, 302, p);
    assert.equal(r.location, `/login?returnTo=${encodeURIComponent(p)}`, p);
  }
  const vol = await get(null, "/volunteer");
  assert.equal(vol.location, "/login?returnTo=%2Fvolunteer");
  const q = await get(null, "/meetings?month=2091-05");
  assert.equal(q.location, `/login?returnTo=${encodeURIComponent("/meetings?month=2091-05")}`, "the query survives");
  assert.equal((await get(null, "/dashboard")).location, "/membership.html");
});

test("the log-in page says why (EN and FR), and logging in lands back on the page", async () => {
  const en = await get(null, "/login?returnTo=%2Fforum");
  assert.match(en.text, /Log in to open the members.? area\. You will come back to this page afterwards\./);
  const fr = await get(null, "/login?returnTo=%2Fforum", "fr");
  assert.match(fr.text, /Connectez-vous pour accéder à l’espace membres\. Vous reviendrez ensuite sur cette page\./);
  const jar = makeCookieJar();
  const res = await send(jar, "/login", { email: who.member.email, password: PASSWORD, returnTo: "/forum" });
  assert.equal(res.headers.get("location"), "/forum");
});

test("account holder (not a member): a 403 page with a membership button, EN and FR, never member content", async () => {
  for (const p of [...MEMBER_PAGES, "/dashboard"]) {
    const r = await get(who.plain.jar, p);
    assert.equal(r.status, 403, p);
    assert.match(r.text, /<h1>This area is for members<\/h1>/, p);
    assert.match(r.text, /Become a member to join the forum, meetings and more\./);
    assert.match(r.text, /<a class="btn" href="\/membership\.html">Become a member<\/a>/);
    assert.match(r.text, /<div role="status" class="notice-box">/, "announced to screen readers");
    assert.match(r.text, /name="robots" content="noindex"/);
    assert.match(r.res.headers.get("cache-control"), /no-store/);
    assert.doesNotMatch(r.text, /Start a thread|Submit My Votes|Welcome back/);
    // still signed in
    assert.match(r.text, /action="\/logout"/, `${p}: still logged in`);
  }
  const fr = await get(who.plain.jar, "/forum", "fr");
  assert.equal(fr.status, 403);
  assert.match(fr.text, /<h1>Cet espace est réservé aux membres<\/h1>/);
  assert.match(fr.text, /Devenez membre pour rejoindre le forum, les réunions et bien plus\./);
  assert.match(fr.text, /href="\/membership\.html">Devenir membre<\/a>/);
  assert.match(fr.text, /<html lang="fr"/);
});

test("account holder on the volunteer calendar: told it is for volunteers, button to the volunteer form", async () => {
  const en = await get(who.plain.jar, "/volunteer");
  assert.equal(en.status, 403);
  assert.match(en.text, /<h1>This area is for volunteers<\/h1>/);
  assert.match(en.text, /href="\/volunteer\.html">Volunteer with us<\/a>/);
  const fr = await get(who.member.jar, "/volunteer", "fr");
  assert.equal(fr.status, 403, "a plain member is not a volunteer either");
  assert.match(fr.text, /<h1>Cet espace est réservé aux bénévoles<\/h1>/);
  assert.match(fr.text, /Devenir bénévole<\/a>/);
});

test("members, volunteers and admins still get the real pages", async () => {
  for (const p of ["/forum", "/meetings", "/announcements", "/charity", "/dashboard"]) {
    assert.equal((await get(who.member.jar, p)).status, 200, `member ${p}`);
  }
  assert.equal((await get(who.volunteer.jar, "/volunteer")).status, 200);
  assert.equal((await get(who.admin.jar, "/volunteer")).status, 200);
  assert.equal((await get(who.member.jar, "/volunteer")).status, 403);
});

test("a form post to a members page by a non-member keeps the quiet redirect (nothing is done)", async () => {
  const res = await send(who.plain.jar, "/forum/new", { title: "x", body: "y" });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get("location"), "/");
  const guest = await send(makeCookieJar(), "/forum/new", { title: "x", body: "y" });
  assert.equal(guest.headers.get("location"), "/login");
});

test("PH-31: a refused log-in keeps the typed e-mail, never the password, and focuses the password box", async () => {
  for (const lang of ["en", "fr"]) {
    const jar = makeCookieJar();
    const token = await fetchCsrfToken(app.base, jar);
    const bad = await fetch(`${app.base}/login`, {
      method: "POST", redirect: "manual",
      headers: { ...FORM, cookie: `${jar.header()}; umasbooks_lang=${lang}` },
      body: new URLSearchParams({ email: who.plain.email, password: "Wrong-Secret-9", _csrf: token }).toString(),
    });
    jar.capture(bad);
    assert.equal(bad.status, 303);
    const page = await get(jar, "/login", lang);
    assert.match(page.text, lang === "fr" ? /E-mail ou mot de passe incorrect\./ : /Incorrect email or password\./);
    assert.match(page.text, /<div role="alert" class="error-box" id="login-error">/);
    const email = page.text.match(/<input id="email"[^>]*>/)[0];
    const pw = page.text.match(/<input id="password"[^>]*>/)[0];
    assert.ok(email.includes(`value="${who.plain.email}"`), "typed e-mail is back");
    assert.doesNotMatch(email, /autofocus/);
    assert.match(pw, /autofocus/, "focus goes to the password box");
    assert.match(pw, /aria-invalid="true"/);
    assert.match(pw, /aria-describedby="login-error"/);
    assert.doesNotMatch(page.text, /Wrong-Secret-9/, "the password is never echoed");
    assert.doesNotMatch(pw, /value=/);
    // the message is shown once: a reload is a clean form
    const again = await get(jar, "/login", lang);
    assert.doesNotMatch(again.text, /id="login-error"/);
    assert.doesNotMatch(again.text, /autofocus/);
  }
});

test("PH-31: an unknown-e-mail refusal with no e-mail typed focuses the e-mail box", async () => {
  const jar = makeCookieJar();
  const res = await send(jar, "/login", { email: "", password: "x" });
  assert.equal(res.status, 303);
  const page = await get(jar, "/login");
  assert.match(page.text.match(/<input id="email"[^>]*>/)[0], /autofocus/);
  assert.doesNotMatch(page.text.match(/<input id="password"[^>]*>/)[0], /autofocus/);
});
