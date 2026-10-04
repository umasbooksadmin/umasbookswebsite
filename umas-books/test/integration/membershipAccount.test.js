// Becoming a member needs an account, created in ONE step on the membership
// page (src/lib/membershipPage.js, views/marketing/membership.ejs):
//
//  - a guest sees a short name + email form, NOT the HelloAsso widget;
//  - submitting it creates the account exactly like /signup (unusable
//    password, confirmation email whose link returns to this page) and shows
//    the payment step; that next page is IDENTICAL for an address that already
//    has an account (no existence oracle);
//  - a logged-in account holder sees ONLY the payment form (never a signup
//    form, never a second account), with their account email;
//  - a current member sees their status; inside the 30-day renewal window the
//    form is back;
//  - preview mode keeps everything off.
//
// Real app (startTestApp): this exercises the real /membership.html handler,
// CSRF and sessions. Ports 3955 (normal) and 3956 (preview) are reserved here.
// Each request carries its own client IP so the per-IP signup limiter is never
// shared with other files.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");
const { createAccount, loginOverHttp } = require("../helpers/accounts");

const PORT = 3955;
const PREVIEW_PORT = 3956;
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app, preview, pool;
before(async () => {
  app = await startTestApp({ port: PORT });
  preview = await startTestApp({ port: PREVIEW_PORT, isolated: true, env: { PREVIEW_MODE: "true" } });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});
after(async () => {
  await pool.end();
  await app.stop();
  await preview.stop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let ipSeq = Math.floor(Math.random() * 200) * 250;
const nextIp = () => { ipSeq += 1; return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`; };

function visitor(base = app.base, lang) {
  const jar = makeCookieJar();
  const ip = nextIp();
  const headers = (extra = {}) => ({
    "x-forwarded-for": ip,
    cookie: [jar.header(), lang ? `umasbooks_lang=${lang}` : ""].filter(Boolean).join("; "),
    ...extra,
  });
  return {
    jar, ip,
    async page(path = "/membership.html") {
      const res = await fetch(`${base}${path}`, { headers: headers(), redirect: "manual" });
      jar.capture(res);
      return { res, html: await res.text() };
    },
    async post(path, fields = {}) {
      const token = await fetchCsrfToken(base, jar, { "x-forwarded-for": ip });
      const res = await fetch(`${base}${path}`, {
        method: "POST", redirect: "manual", headers: headers(FORM),
        body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
      });
      jar.capture(res);
      return { res, location: res.headers.get("location"), text: await res.text() };
    },
    async logIn(account) {
      const res = await loginOverHttp(base, jar, account, { "x-forwarded-for": ip });
      assert.equal(res.status, 302);
    },
  };
}

const userRows = async (email) => (await pool.query("SELECT * FROM users WHERE email = $1", [email.toLowerCase()])).rows;
async function waitForToken(email) {
  for (let i = 0; i < 80; i++) {
    const { rows } = await pool.query("SELECT t.return_to FROM email_verification_tokens t JOIN users u ON u.id = t.user_id WHERE u.email = $1", [email.toLowerCase()]);
    if (rows.length) return rows;
    await new Promise((r) => setTimeout(r, 50));
  }
  return [];
}

const NO_WIDGET = (html) => { assert.ok(!html.includes("<iframe"), "no iframe"); assert.ok(!html.includes("haWidget"), "no widget element"); };

test("a guest gets the name + email form and NO payment widget (EN and FR)", async () => {
  for (const [lang, heading, button] of [["en", "Become a member", "Continue to payment"], ["fr", "Devenir membre", "Continuer vers le paiement"]]) {
    const { res, html } = await visitor(app.base, lang).page();
    assert.equal(res.status, 200);
    assert.match(res.headers.get("cache-control"), /no-store/, "personal page, never cached");
    assert.ok(html.includes(heading) && html.includes(button), lang);
    assert.match(html, /<form class="mem-form" method="post" action="\/membership\/join">/);
    assert.match(html, /name="displayName"/);
    assert.match(html, /name="email"/);
    assert.match(html, /name="_csrf"/);
    NO_WIDGET(html);
  }
  const fr = (await visitor(app.base, "fr").page()).html;
  assert.ok(fr.includes("Vous avez déjà un compte ?"));
  assert.ok(fr.includes("conditions d’adhésion"));
});

test("joining: one step creates the account (unconfirmed, no password) + confirmation email token back to this page, then the payment step shows", async () => {
  const email = `Join-${uniq()}@Example.TEST`;
  const v = visitor();
  const r = await v.post("/membership/join", { displayName: "Join Person", email });
  assert.equal(r.res.status, 303);
  assert.equal(r.location, "/membership.html", "the typed email is never put in a URL");

  const [u] = await userRows(email);
  assert.ok(u, "account created");
  assert.equal(u.display_name, "Join Person");
  assert.equal(u.email_verified_at, null);
  assert.equal(u.first_verification_pending, true);
  assert.equal(u.is_member, false);
  assert.deepEqual((await waitForToken(email)).map((t) => t.return_to), ["/membership.html"], "the confirmation link returns here");

  const { html } = await v.page();
  assert.match(html, /<iframe id="haWidget" title="HelloAsso membership form"/);
  assert.ok(html.includes(email.toLowerCase()), "the address to use on the payment form is shown");
  assert.ok(html.includes("Use this same email on the payment form:"));
  assert.ok(html.includes("We have emailed you a link: click it after paying to confirm your address and choose your password."));
  assert.ok(html.includes("Your membership is attached to your account when you confirm."));
  assert.doesNotMatch(html, /action="\/membership\/join"/, "no second form once joined");
  assert.match(html, /href="\/login\?returnTo=%2Fmembership\.html"/, "an existing account holder is pointed to log in first");

  // Another browser knows nothing of it.
  assert.doesNotMatch((await visitor().page()).html, /haWidget/);

  // "Use a different email" forgets it.
  const reset = await v.post("/membership/join/reset");
  assert.equal(reset.location, "/membership.html");
  const again = (await v.page()).html;
  NO_WIDGET(again);
  assert.ok(!again.includes(email.toLowerCase()));
  assert.equal((await userRows(email)).length, 1, "the account itself stays");
});

test("French payment step", async () => {
  const email = `join-fr-${uniq()}@example.test`;
  const v = visitor(app.base, "fr");
  await v.post("/membership/join", { displayName: "Marie", email });
  const { html } = await v.page();
  assert.ok(html.includes("Étape suivante : réglez votre adhésion"));
  assert.ok(html.includes("Nous vous avons envoyé un lien par e-mail"));
  assert.ok(html.includes("Utilisez cette même adresse e-mail sur le formulaire de paiement :"));
  assert.ok(html.includes("Utiliser une autre adresse e-mail"));
  const [u] = await userRows(email);
  assert.equal(u.lang, "fr", "the confirmation email will be French");
});

test("an address that already has an account gets the IDENTICAL next page (no existence oracle) and no second account", async () => {
  const existing = await createAccount(pool, { email: `taken-${uniq()}@example.test`, displayName: "Real Owner" });
  const fresh = `fresh-${uniq()}@example.test`;

  const a = visitor();
  await a.post("/membership/join", { displayName: "Someone Else", email: existing.email });
  const b = visitor();
  await b.post("/membership/join", { displayName: "Someone Else", email: fresh });
  const pageA = (await a.page()).html;
  const pageB = (await b.page()).html;
  const norm = (html, email) => html.split(email).join("EMAIL").replace(/name="_csrf" value="[^"]+"/g, "CSRF");
  assert.equal(norm(pageA, existing.email), norm(pageB, fresh), "same page for a new and an existing address");

  const rows = await userRows(existing.email);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].display_name, "Real Owner", "the existing account is untouched");
  assert.equal(rows[0].first_verification_pending, false);
});

test("a badly formed address creates nothing and says so; names are required", async () => {
  const v = visitor();
  const r = await v.post("/membership/join", { displayName: "Multi", email: "a@x.com, b@y.com" });
  assert.equal(r.location, "/membership.html");
  const { html } = await v.page();
  assert.ok(html.includes('<div role="alert" class="error-box" data-i18n="mem.err.fields">Please enter your name and a valid email address.</div>'));
  NO_WIDGET(html);
  assert.equal((await userRows("a@x.com, b@y.com")).length, 0);
  assert.equal((await pool.query("SELECT 1 FROM users WHERE email LIKE '%a@x.com%'")).rowCount, 0);

  const n = visitor();
  await n.post("/membership/join", { displayName: "", email: `noname-${uniq()}@example.test` });
  assert.ok((await n.page()).html.includes('<div role="alert" class="error-box" data-i18n="mem.err.fields">'));
  await new Promise((r) => setTimeout(r, 150)); // the session write finishes just after the response
  assert.ok(!(await n.page()).html.includes('<div role="alert" class="error-box"'), "shown once");
});

test("a logged-in account holder sees ONLY the payment form with their email, never a signup form; joining again creates no second account", async () => {
  const account = await createAccount(pool, { email: `holder-${uniq()}@example.test`, displayName: "Holder" });
  const v = visitor();
  await v.logIn(account);
  const { html } = await v.page();
  assert.match(html, /<iframe id="haWidget"/);
  assert.ok(html.includes(account.email), "their email is shown");
  assert.ok(html.includes("Use the same email as your account ("));
  assert.ok(html.includes("so your membership is linked to it."));
  assert.doesNotMatch(html, /action="\/membership\/join"/);
  assert.doesNotMatch(html, /name="displayName"/);
  assert.match(html, /action="\/membership\/check"/, "and the check button");

  const before = (await pool.query("SELECT count(*)::int AS n FROM users")).rows[0].n;
  const post = await v.post("/membership/join", { displayName: "Another", email: `second-${uniq()}@example.test` });
  assert.equal(post.res.status, 303);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM users")).rows[0].n, before, "no account created for a logged-in person");

  const fr = visitor(app.base, "fr");
  await fr.logIn(account);
  const frHtml = (await fr.page()).html;
  assert.ok(frHtml.includes("Utilisez la même adresse e-mail que votre compte ("));
  assert.ok(frHtml.includes("Vérifier mon adhésion"));
});

test("a current member sees their status (until <date> or no end date), not the form; in the last 30 days the form returns", async () => {
  const day = 86400000;
  const cases = [
    { name: "far", expires: new Date(Date.now() + 200 * day), state: "member" },
    { name: "noend", expires: null, state: "member" },
    { name: "soon", expires: new Date(Date.now() + 10 * day), state: "form" },
    { name: "lapsed", expires: new Date(Date.now() - 5 * day), state: "form", isMember: false },
  ];
  for (const c of cases) {
    const account = await createAccount(pool, {
      email: `mem-${c.name}-${uniq()}@example.test`, isMember: c.isMember === undefined ? true : c.isMember, memberExpiresAt: c.expires,
    });
    const v = visitor();
    await v.logIn(account);
    const { html } = await v.page();
    if (c.state === "member") {
      NO_WIDGET(html);
      assert.ok(html.includes('data-i18n="mem.member.h">You are a member</div>'), c.name);
      if (c.expires) {
        assert.ok(html.includes('<span data-i18n="mem.member.until">You are a member until</span>'), c.name);
        assert.ok(html.includes(c.expires.toISOString().slice(0, 10)), `${c.name}: the end date`);
      } else {
        assert.ok(html.includes('data-i18n="mem.member.noend">You are a member, with no end date.</p>'), c.name);
      }
    } else {
      assert.match(html, /<iframe id="haWidget"/, `${c.name}: renewal shows the form`);
      assert.ok(!html.includes('data-i18n="mem.member.h"'), `${c.name}: no member status block`);
    }
  }
  const frAccount = await createAccount(pool, { email: `mem-fr-${uniq()}@example.test`, isMember: true, memberExpiresAt: new Date(Date.now() + 200 * day) });
  const v = visitor(app.base, "fr");
  await v.logIn(frAccount);
  assert.ok((await v.page()).html.includes('<span data-i18n="mem.member.until">Vous êtes membre jusqu’au</span>'));
});

test("preview mode: no join form, no widget, joining creates nothing", async () => {
  const email = `preview-join-${uniq()}@example.test`;
  const v = visitor(preview.base);
  const { html } = await v.page();
  assert.ok(html.includes("Membership opens at launch"));
  NO_WIDGET(html);
  assert.doesNotMatch(html, /action="\/membership\/join"/);
  const r = await v.post("/membership/join", { displayName: "Preview", email });
  assert.equal(r.res.status, 303);
  const { Client } = require("pg");
  const c = new Client({ connectionString: preview.databaseUrl });
  await c.connect();
  try {
    assert.equal((await c.query("SELECT 1 FROM users WHERE email = $1", [email])).rowCount, 0, "nothing created in preview");
  } finally {
    await c.end();
  }
  NO_WIDGET((await v.page()).html);
});

test("the login and signup pages keep a membership returnTo, and only local ones", async () => {
  const ok = (await visitor().page("/login?returnTo=%2Fmembership.html")).html;
  assert.match(ok, /<input type="hidden" name="returnTo" value="\/membership\.html">/);
  assert.ok(ok.includes("Log in or create an account to become a member."));
  const evil = (await visitor().page("/login?returnTo=%2F%2Fevil.example")).html;
  assert.doesNotMatch(evil, /name="returnTo"/);
});
