// "/" is the public Home page for everyone: a signed-in member, volunteer or
// admin sees it too (no redirect to /dashboard), in their language, with
// Member's Access / Admin links in the header. Logging in still lands on the
// dashboard. Port 4902 is reserved for this file.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 4902;
const PASSWORD = "HomeSigned1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app;
let pool;
const users = {};

async function login(email) {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }).toString(),
  });
  jar.capture(res);
  return { res, jar };
}

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const hash = await bcrypt.hash(PASSWORD, 10);
  for (const [key, flags] of Object.entries({ member: [true, false, false], volunteer: [true, true, false], admin: [false, false, true], plain: [false, false, false] })) {
    const email = `home-${key}-${Date.now()}@example.test`;
    await pool.query(
      `INSERT INTO users (email, password_hash, display_name, is_member, is_volunteer, is_admin, email_verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())`,
      [email, hash, `Home ${key}`, ...flags]
    );
    users[key] = { email };
  }
});
after(async () => {
  await pool.end();
  await app.stop();
});

const header = (html) => html.slice(html.indexOf('<header class="mkt-header">'), html.indexOf("</header>"));
const getHome = (jar, lang) => fetch(`${app.base}/`, {
  redirect: "manual",
  headers: { cookie: [jar && jar.header(), lang && `umasbooks_lang=${lang}`].filter(Boolean).join("; ") },
});

const anon = async () => (await (await getHome(null)).text());

for (const key of ["member", "volunteer", "admin"]) {
  test(`signed-in ${key}: GET / is the public Home page (200, no redirect), never cached`, async () => {
    const { res: loginRes, jar } = await login(users[key].email);
    assert.equal(loginRes.status, 302, "login works");
    assert.equal(loginRes.headers.get("location"), key === "admin" ? "/admin" : "/dashboard", "login still lands on the dashboard");
    const res = await getHome(jar);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control") || "", /no-store/);
    const html = await res.text();
    assert.doesNotMatch(html, /Welcome back/, "not the Member's Access page");
    // Same body as the visitor's page, apart from the header's signed-in links.
    const body = (h) => h.slice(h.indexOf("</header>"));
    assert.equal(body(html), body(await anon()), "same Home content as a guest sees");
    const head = header(html);
    assert.match(head, /href="\/dashboard"[^>]*>.*Member’s Access/s);
    assert.match(head, /action="\/logout"/);
    if (key === "admin") assert.match(head, /href="\/admin"[^>]*>.*Admin/s);
    else assert.doesNotMatch(head, /href="\/admin"/);
    const fr = header(await (await getHome(jar, "fr")).text());
    assert.match(fr, /href="\/dashboard"[^>]*>.*Espace membres/s);
    assert.match(fr, /Accueil/);
  });
}

test("a visitor and a plain account holder still get the Home page, with no Member's Access link", async () => {
  const visitor = await getHome(null);
  assert.equal(visitor.status, 200);
  assert.doesNotMatch(header(await visitor.text()), /href="\/dashboard"/);
  const { jar } = await login(users.plain.email);
  const res = await getHome(jar);
  assert.equal(res.status, 200);
  assert.doesNotMatch(header(await res.text()), /href="\/dashboard"/);
});
