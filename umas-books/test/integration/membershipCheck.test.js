// "Check my membership" (POST /membership/check) and the pay-first / confirm-
// after path (src/routes/auth.js, src/lib/membership.js):
//
//  - login required (a guest is sent to log in, HelloAsso is not asked);
//  - runs the verified sync for THIS account's confirmed email only, then the
//    page says "Membership found" (with the end date) or "not found yet" (with
//    the email to use), or that it could not check;
//  - rate limited per account; an unconfirmed account is told to confirm;
//  - nobody else's payment is ever attached to the account that pressed it;
//  - a person who joined on the membership page, paid, THEN confirms the
//    email and chooses a password is attached to the membership by the sync
//    that follows the password choice.
//
// In-process: HelloAsso and the mailer are stubbed, and the REAL auth routes
// run. The membership page is mounted with the same state function and view as
// src/index.js uses (the real handler is covered over HTTP in
// membershipAccount.test.js).

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");
const { makeCookieJar } = require("../helpers/httpClient");
const { createAccount } = require("../helpers/accounts");

const db = prepareDatabase("membership_check");

const mailer = require("../../src/mailer");
const sentEmails = [];
mailer.sendMail = async (opts) => { sentEmails.push(opts); };

const helloasso = require("../../src/lib/helloasso");
let configured = true;
helloasso.isConfigured = () => configured;
// HelloAsso "orders" by payer email, like the real lookup (which filters by the exact payer email).
const paid = new Map(); // lower-case email -> [{ id, date }]
const lookups = []; // emails the sync asked HelloAsso about
let failLookup = false;
helloasso.findMembershipOrdersByEmail = async (email) => {
  lookups.push(email.toLowerCase());
  if (failLookup) throw new Error("HelloAsso down");
  return (paid.get(email.toLowerCase()) || []).map((o) => ({ id: o.id, date: o.date, payer: { email }, amount: { total: 1500 }, payments: [{ state: "Authorized" }] }));
};

const realFetch = global.fetch;
global.fetch = (url, ...rest) => (String(url).includes("pwnedpasswords.com")
  ? Promise.resolve(new Response("", { status: 200 }))
  : realFetch(url, ...rest));

const { pool } = require("../../src/db");

let server;
before(async () => {
  db.create();
  const express = require("express");
  const { membershipPageState } = require("../../src/lib/membershipPage");
  const page = express.Router();
  page.get("/membership.html", async (req, res) => {
    res.locals.preview = false;
    res.locals.siteUrl = "http://localhost";
    res.locals.canonicalPath = "/membership.html";
    Object.assign(res.locals, await membershipPageState(pool, req.session));
    res.render("marketing/membership");
  });
  const app = buildApp([page, require("../../src/routes/auth")]);
  app.set("trust proxy", true);
  server = await listen(app);
});
after(async () => {
  global.fetch = realFetch;
  await server.close();
  await pool.end();
  db.drop();
});
beforeEach(() => {
  sentEmails.length = 0;
  paid.clear();
  lookups.length = 0;
  failLookup = false;
  configured = true;
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let ipSeq = Math.floor(Math.random() * 200) * 250;
const nextIp = () => { ipSeq += 1; return `10.${(ipSeq >> 16) & 255}.${(ipSeq >> 8) & 255}.${ipSeq & 255}`; };

function visitor(lang) {
  const jar = makeCookieJar();
  const ip = nextIp();
  const send = async (path, { method = "GET", form } = {}) => {
    const res = await fetch(`${server.base}${path}`, {
      method, redirect: "manual",
      headers: {
        "x-forwarded-for": ip,
        cookie: [jar.header(), lang ? `umasbooks_lang=${lang}` : ""].filter(Boolean).join("; "),
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    jar.capture(res);
    return { res, text: await res.text(), location: res.headers.get("location") };
  };
  return {
    get: (p) => send(p),
    post: (p, form) => send(p, { method: "POST", form }),
    login: async (account) => assert.equal((await send("/login", { method: "POST", form: { email: account.email, password: account.password } })).res.status, 302),
  };
}
const member = async (email) => (await pool.query("SELECT is_member, member_expires_at FROM users WHERE email = $1", [email.toLowerCase()])).rows[0];
const press = async (v) => {
  const r = await v.post("/membership/check");
  assert.equal(r.res.status, 303, "redirects back to the page");
  assert.equal(r.location, "/membership.html");
  return (await v.get("/membership.html")).text;
};
async function waitFor(fn, what) {
  for (let i = 0; i < 120; i++) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 25)); }
  throw new Error(`timed out: ${what}`);
}

test("a guest pressing the button is sent to log in and HelloAsso is not asked", async () => {
  const v = visitor();
  const r = await v.post("/membership/check");
  assert.equal(r.res.status, 303);
  assert.equal(r.location, "/login?returnTo=%2Fmembership.html");
  assert.equal(lookups.length, 0);
});

test("payment found: the account becomes a member and the page says so, with the end date", async () => {
  const account = await createAccount(pool, { email: `found-${uniq()}@example.test` });
  const paidAt = new Date(Date.now() - 3 * 86400000);
  paid.set(account.email, [{ id: 910001 + Math.floor(Math.random() * 1e6), date: paidAt.toISOString() }]);
  const v = visitor();
  await v.login(account);
  const html = await press(v);
  const expected = new Date(paidAt.getTime() + 365 * 86400000).toISOString().slice(0, 10);
  assert.ok(html.includes(`<span data-i18n="mem.check.found">Membership found: you are a member until</span> <strong>${expected}</strong>`));
  assert.equal((await member(account.email)).is_member, true);
  assert.deepEqual(lookups, [account.email], "only this account's own email was looked up");
  assert.ok(html.includes('data-i18n="mem.member.h">You are a member</div>'), "the page now shows the status");
});

test("payment not found yet: a clear message naming the email to use (EN and FR), no membership", async () => {
  const account = await createAccount(pool, { email: `notyet-${uniq()}@example.test` });
  const v = visitor();
  await v.login(account);
  const html = await press(v);
  assert.ok(html.includes(`<span data-i18n="mem.check.notFoundA">We have not found your payment yet. It can take a few minutes. Make sure you used the email</span> <strong>${account.email}</strong> <span data-i18n="mem.check.notFoundB">on the payment form.</span>`));
  assert.equal((await member(account.email)).is_member, false);
  assert.match(html, /<iframe id="haWidget"/, "the form stays available");

  const fr = visitor("fr");
  await fr.login(account);
  const frHtml = await press(fr);
  assert.ok(frHtml.includes("Nous n’avons pas encore trouvé votre paiement. Cela peut prendre quelques minutes. Vérifiez que vous avez utilisé l’adresse e-mail"));
  assert.ok(frHtml.includes("sur le formulaire de paiement."));
});

test("the message is shown once (a refresh no longer shows it)", async () => {
  const account = await createAccount(pool, { email: `once-${uniq()}@example.test` });
  const v = visitor();
  await v.login(account);
  await press(v);
  await new Promise((r) => setTimeout(r, 100)); // the session write finishes just after the response
  assert.ok(!(await v.get("/membership.html")).text.includes('<div role="status" class="notice-box"><span data-i18n="mem.check.notFoundA"'));
});

test("nobody else's payment is attached: another person's payment under another email changes nothing for either account", async () => {
  const a = await createAccount(pool, { email: `acc-a-${uniq()}@example.test` });
  const b = await createAccount(pool, { email: `acc-b-${uniq()}@example.test` });
  paid.set(b.email, [{ id: 920001 + Math.floor(Math.random() * 1e6), date: new Date().toISOString() }]);
  const v = visitor();
  await v.login(a);
  const html = await press(v);
  assert.ok(html.includes('data-i18n="mem.check.notFoundA"'));
  assert.equal((await member(a.email)).is_member, false);
  assert.equal((await member(b.email)).is_member, false, "B was not touched by A pressing the button");
  assert.deepEqual(lookups, [a.email]);
  // A cannot ask for B's email: the request carries none (anything posted is ignored).
  await v.post("/membership/check", { email: b.email });
  assert.ok(lookups.every((e) => e === a.email));
  assert.equal((await member(b.email)).is_member, false);
});

test("rate limited: 5 presses per 10 minutes per account, then 429; another account is unaffected", async () => {
  const a = await createAccount(pool, { email: `rate-a-${uniq()}@example.test` });
  const b = await createAccount(pool, { email: `rate-b-${uniq()}@example.test` });
  const va = visitor();
  await va.login(a);
  const statuses = [];
  for (let i = 0; i < 6; i++) statuses.push((await va.post("/membership/check")).res.status);
  assert.deepEqual(statuses, [303, 303, 303, 303, 303, 429]);
  assert.equal(lookups.length, 5, "the sixth press never reached HelloAsso");
  // The same IP, a different account: its own budget.
  const vb = visitor();
  await vb.login(b);
  assert.equal((await vb.post("/membership/check")).res.status, 303);
});

test("an account whose email is not confirmed is told to confirm; HelloAsso is not asked", async () => {
  const account = await createAccount(pool, { email: `uncheck-${uniq()}@example.test`, confirmed: false });
  const v = visitor();
  await v.login(account);
  const html = await press(v);
  assert.ok(html.includes('data-i18n="mem.check.unconfirmed"'));
  assert.equal(lookups.length, 0);
});

test("when HelloAsso cannot be reached the page says it could not check (not 'not found')", async () => {
  const account = await createAccount(pool, { email: `down-${uniq()}@example.test` });
  const v = visitor();
  await v.login(account);
  failLookup = true;
  const html = await press(v);
  assert.ok(html.includes('data-i18n="mem.check.error"'));
  assert.ok(!html.includes('data-i18n="mem.check.notFoundA">We'));
  configured = false;
  assert.ok((await press(v)).includes('data-i18n="mem.check.error"'));
});

// ---------- pay first, confirm after ----------

test("join -> pay on HelloAsso -> confirm email -> choose password: the membership attaches after the password choice", async () => {
  const email = `payfirst-${uniq()}@example.test`;
  const v = visitor();
  const join = await v.post("/membership/join", { displayName: "Pay First", email });
  assert.equal(join.res.status, 303);
  assert.equal(join.location, "/membership.html");
  assert.ok((await v.get("/membership.html")).text.includes(`<strong>${email}</strong>`), "the payment step shows the email to use");

  const mail = await waitFor(() => sentEmails.find((e) => e.to === email), "the confirmation email");
  assert.equal(mail.subject, "Confirm your email to finish becoming a member of Uma's Books");
  assert.match(mail.text, /your membership is attached to your account as soon as you confirm/);

  // They pay on HelloAsso BEFORE confirming (nothing can attach yet: no confirmed account).
  paid.set(email, [{ id: 930001 + Math.floor(Math.random() * 1e6), date: new Date().toISOString() }]);
  assert.equal((await member(email)).is_member, false);

  const confirmPath = new URL(mail.text.match(/https?:\/\/[^\s]+\/verify-email\/[0-9a-f]+/)[0]).pathname;
  const confirm = await v.get(confirmPath);
  assert.match(confirm.location, /^\/reset-password\/[0-9a-f]+\?confirmed=1$/);
  assert.equal((await member(email)).is_member, false, "confirming alone is not enough: the password is chosen first");
  const choose = await v.post(confirm.location, { newPassword: "Correct-Horse-9!x" });
  assert.equal(choose.location, "/login?reset=confirmed&returnTo=%2Fmembership.html");

  await waitFor(async () => (await member(email)).is_member, "the membership sync after the password choice");
  assert.ok(lookups.includes(email));
  // And logging in lands on the membership page, now showing the status.
  const done = await v.post("/login", { email, password: "Correct-Horse-9!x", returnTo: "/membership.html" });
  assert.equal(done.location, "/membership.html");
  assert.ok((await v.get("/membership.html")).text.includes('data-i18n="mem.member.h">You are a member</div>'));
});

test("a membership join leaves an unconfirmed account that cannot log in before the email is confirmed (pre-hijack rules unchanged)", async () => {
  const email = `hijack-${uniq()}@example.test`;
  await visitor().post("/membership/join", { displayName: "Attacker", email });
  const mail = await waitFor(() => sentEmails.find((e) => e.to === email), "mail");
  const row = (await pool.query("SELECT password_hash, first_verification_pending FROM users WHERE email = $1", [email])).rows[0];
  assert.equal(row.first_verification_pending, true);
  // Nobody can log in with anything before confirming: the password is random and unknown.
  const v = visitor();
  const r = await v.post("/login", { email, password: "Correct-Horse-9!x" });
  assert.equal(r.res.status, 401);
  assert.ok(mail.text.includes("/verify-email/"));
});
