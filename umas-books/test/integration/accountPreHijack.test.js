// Account pre-hijack: someone signs up with a VICTIM's email and their own
// password, hoping the victim clicks "confirm your email" and so verifies the
// attacker's account (which then inherits the victim's HelloAsso membership
// and data). Defence, see routes/auth.js:
//   - a self-signup account can't log in before its email is confirmed;
//   - the first confirmation destroys the signup password, kills sessions,
//     and sends the person to choose a new one (the reset flow).
// In-process (mailer and HelloAsso stubbed, so the real links are captured).

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { prepareDatabase, buildApp, listen, waitFor } = require("../helpers/inProcessApp");

const db = prepareDatabase("prehijack", { isolated: true });

const mailer = require("../../src/mailer");
const sent = [];
mailer.sendMail = async (opts) => { sent.push(opts); };
// No HaveIBeenPwned call from tests: a stand-in that still rejects short passwords,
// so we can see the reset page applies the policy (the real rules have unit tests).
require("../../src/lib/passwordPolicy").validateNewPassword = async (pw) => (pw.length < 8 ? "Password must be at least 8 characters." : null);
const helloasso = require("../../src/lib/helloasso");
let orders = [];
helloasso.isConfigured = () => true;
helloasso.findMembershipOrdersByEmail = async (email) =>
  orders.filter((o) => o.payer.email.toLowerCase() === email.toLowerCase());

const { pool } = require("../../src/db");
const { attachUser } = require("../../src/middleware/auth");
const express = require("express");

let server;
before(async () => {
  db.create();
  const probe = express.Router();
  probe.get("/whoami", (req, res) => res.json({ user: req.session.user ? req.session.user.email : null }));
  server = await listen(buildApp([
    // attachUser is what ends sessions older than the last password change.
    (req, res, next) => {
      if (req.get("x-stale-session")) req.session.user = JSON.parse(req.get("x-stale-session"));
      next();
    },
    attachUser(pool),
    require("../../src/routes/auth"),
    probe,
  ]));
});
after(async () => {
  await server.close();
  await pool.end();
  db.drop();
});
beforeEach(() => { sent.length = 0; orders = []; });

const uniq = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const ATTACKER_PW = "Attacker-Pass-1!";
const VICTIM_PW = "Victim-Chosen-2@";

function request(path, { method = "GET", body, lang, jar } = {}) {
  return fetch(`${server.base}${path}`, {
    method,
    redirect: "manual",
    headers: {
      ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      ...(lang ? { cookie: `umasbooks_lang=${lang}` } : {}),
      ...(jar || {}),
    },
    body: body ? new URLSearchParams(body).toString() : undefined,
  });
}
// What pressing "Confirm my email" on the page behind the emailed link does
// (the link itself only shows the button; see routes/auth.js). CSRF is not
// checked by this in-process harness.
const pressConfirm = (path, opts = {}) => request(path, { ...opts, method: "POST", body: { confirm: "1" } });
// Signup collects no password: a "password" sent anyway is ignored.
const signup = (email, password, lang) => request("/signup", { method: "POST", body: { email, ...(password ? { password } : {}), displayName: "Test Person" }, lang });
// An account as the previous signup form created it (attacker's own password,
// still waiting for its first confirmation): same rules must still hold.
async function legacyPendingSignup(email, password) {
  await pool.query(
    "INSERT INTO users (email, password_hash, display_name, first_verification_pending) VALUES ($1, $2, 'Legacy', TRUE)",
    [email, await bcrypt.hash(password, 4)]
  );
  const { rows } = await pool.query("SELECT id FROM users WHERE email = $1", [email]);
  const raw = require("crypto").randomBytes(16).toString("hex");
  await pool.query("INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [rows[0].id, require("crypto").createHash("sha256").update(raw).digest("hex")]);
  sent.push({ to: email, text: `https://x.test/verify-email/${raw}` });
}
const login = (email, password, lang) => request("/login", { method: "POST", body: { email, password }, lang });

// The link in the most recent mail to `email` (the mailer is stubbed).
async function linkFor(email, kind) {
  const re = new RegExp(`https?://[^\\s]+/${kind}/[0-9a-f]+`);
  const mail = await waitFor(() => sent.filter((m) => m.to === email && re.test(m.text)).pop(), { message: `${kind} mail to ${email}` });
  return mail.text.match(re)[0].replace(/^https?:\/\/[^/]+/, "");
}
const userRow = async (email) => (await pool.query("SELECT * FROM users WHERE email = $1", [email])).rows[0];

test("account created by the old signup form (attacker's own password): no session before verification, password dies when the victim verifies", async () => {
  const victim = `victim-${uniq()}@example.test`;

  // 1. Attacker signed up with the victim's email and their own password.
  await legacyPendingSignup(victim, ATTACKER_PW);
  const verifyPath = await linkFor(victim, "verify-email");
  const before = await userRow(victim);
  assert.equal(before.email_verified_at, null);

  // 2. The attacker cannot log in: no redirect, no session cookie.
  const early = await login(victim, ATTACKER_PW);
  assert.equal(early.status, 403);
  assert.equal(early.headers.get("set-cookie"), null, "no session may be issued before verification");
  assert.match(await early.text(), /confirm your email first/i);

  // 3. The victim clicks the link: sent to choose a password, not to the login.
  const click = await pressConfirm(verifyPath);
  assert.equal(click.status, 302);
  const resetPath = click.headers.get("location");
  assert.match(resetPath, /^\/reset-password\/[0-9a-f]+\?confirmed=1$/);

  // The attacker's password is already useless, though the victim hasn't chosen one yet.
  const afterClick = await userRow(victim);
  assert.ok(afterClick.email_verified_at);
  assert.ok(afterClick.password_changed_at > before.password_changed_at, "every existing session must be invalidated");
  assert.equal(await bcrypt.compare(ATTACKER_PW, afterClick.password_hash), false);
  assert.equal((await login(victim, ATTACKER_PW)).status, 401);

  // A session the attacker somehow held from before is dead too.
  const stale = JSON.stringify({ id: before.id, email: victim, passwordChangedAt: before.password_changed_at.getTime() });
  const who = await (await fetch(`${server.base}/whoami`, { headers: { "x-stale-session": stale } })).json();
  assert.equal(who.user, null);

  // 4. The victim chooses their own password.
  const page = await (await request(resetPath)).text();
  assert.match(page, /Email confirmed: now choose your password/);
  const set = await request(resetPath.split("?")[0] + "?confirmed=1", { method: "POST", body: { newPassword: VICTIM_PW } });
  assert.equal(set.status, 302);
  assert.equal(set.headers.get("location"), "/login?reset=confirmed");

  // 5. Only the victim's new password works.
  assert.equal((await login(victim, ATTACKER_PW)).status, 401);
  const ok = await login(victim, VICTIM_PW);
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get("location"), "/");
  // The link is single use.
  assert.equal((await pressConfirm(verifyPath)).status, 400);
  assert.equal((await request(resetPath.split("?")[0], { method: "POST", body: { newPassword: "Another-One-3#" } })).status, 400);
});

test("attacker scenario with the new signup: the attacker can set no password before the mailbox owner clicks", async () => {
  const victim = `victim-new-${uniq()}@example.test`;
  const page = await (await request("/signup")).text();
  assert.ok(!/name="password"/.test(page), "the signup form asks for no password");

  // Attacker tries anyway, sending a password field.
  assert.equal((await signup(victim, ATTACKER_PW)).status, 200);
  const verifyPath = await linkFor(victim, "verify-email");
  const row = await userRow(victim);
  assert.equal(row.email_verified_at, null);
  assert.equal(row.first_verification_pending, true);
  assert.equal(await bcrypt.compare(ATTACKER_PW, row.password_hash), false, "the sent password was never stored");
  const early = await login(victim, ATTACKER_PW);
  assert.equal(early.status, 401);
  assert.equal(early.headers.get("set-cookie"), null);

  // The mailbox owner confirms and chooses; only then does a password exist.
  const resetPath = (await pressConfirm(verifyPath)).headers.get("location");
  assert.equal((await login(victim, ATTACKER_PW)).status, 401);
  assert.equal((await request(resetPath, { method: "POST", body: { newPassword: VICTIM_PW } })).status, 302);
  assert.equal((await login(victim, ATTACKER_PW)).status, 401);
  assert.equal((await login(victim, VICTIM_PW)).status, 302);
});

test("the password chosen after confirming still goes through the password policy", async () => {
  const email = `policy-${uniq()}@example.test`;
  await signup(email);
  const resetPath = (await pressConfirm(await linkFor(email, "verify-email"))).headers.get("location");
  const weak = await request(resetPath, { method: "POST", body: { newPassword: "abc" } });
  assert.equal(weak.status, 400);
  assert.match(await weak.text(), /at least 8 characters/);
  assert.equal((await login(email, "abc")).status, 401);
  // A rejected password doesn't burn the link.
  assert.equal((await request(resetPath, { method: "POST", body: { newPassword: VICTIM_PW } })).status, 302);
});

test("membership attaches only after the victim has chosen the password", async () => {
  const victim = `member-victim-${uniq()}@example.test`;
  orders = [{ id: Math.floor(Math.random() * 1e9), payer: { email: victim }, payments: [{ state: "Authorized" }], amount: { total: 3000 }, date: new Date().toISOString() }];
  await signup(victim, ATTACKER_PW);
  const verifyPath = await linkFor(victim, "verify-email");

  const click = await pressConfirm(verifyPath);
  const resetPath = click.headers.get("location");
  await new Promise((r) => setTimeout(r, 400));
  assert.equal((await userRow(victim)).is_member, false, "no membership while the attacker's password is the only one");

  await request(resetPath.split("?")[0] + "?confirmed=1", { method: "POST", body: { newPassword: VICTIM_PW } });
  await waitFor(async () => (await userRow(victim)).is_member, { message: "membership sync after the password was set" });
});

test("legitimate signup works in English and French: confirm, choose a password, log in", async () => {
  for (const lang of ["en", "fr"]) {
    const email = `legit-${lang}-${uniq()}@example.test`;
    assert.equal((await signup(email, ATTACKER_PW, lang)).status, 200);
    // No password exists yet; the login page offers the link again, in the person's language.
    assert.equal((await login(email, ATTACKER_PW, lang)).status, 401);
    const loginPage = await (await request("/login", { lang })).text();
    assert.match(loginPage, /action="\/resend-verification"/);
    assert.match(loginPage, lang === "fr" ? /Renvoyer le lien de confirmation/ : /Send me the confirmation link again/);
    // The signup mail says what the link is for.
    const mail = await waitFor(() => sent.filter((m) => m.to === email).pop(), { message: `signup mail to ${email}` });
    assert.match(mail.subject, lang === "fr" ? /Confirmez votre adresse e-mail et choisissez votre mot de passe/ : /Confirm your email and choose your password/);
    assert.match(mail.text, lang === "fr" ? /confirmer votre adresse e-mail et choisir votre mot de passe/ : /confirm your email address and choose your password/);

    const verifyPath = await linkFor(email, "verify-email");
    const click = await pressConfirm(verifyPath, { lang });
    const resetPath = click.headers.get("location");
    const page = await (await request(resetPath, { lang })).text();
    assert.match(page, lang === "fr" ? /Adresse confirmée\u00a0: choisissez maintenant votre mot de passe/ : /Email confirmed: now choose your password/);
    const set = await request(resetPath, { method: "POST", body: { newPassword: VICTIM_PW }, lang });
    assert.equal(set.headers.get("location"), "/login?reset=confirmed");
    const notice = await (await request("/login?reset=confirmed", { lang })).text();
    assert.match(notice, lang === "fr" ? /Mot de passe enregistré/ : /Password saved/);
    const ok = await login(email, VICTIM_PW, lang);
    assert.equal(ok.status, 302);
  }
});

test("admin-created and grandfathered (already verified) accounts are unaffected", async () => {
  const hash = await bcrypt.hash(ATTACKER_PW, 4);
  const email = `grandfathered-${uniq()}@example.test`;
  // Created like an admin invite / a pre-032 account: verified, flag off.
  await pool.query("INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, $2, 'Old Timer', now())", [email, hash]);
  assert.equal((await login(email, ATTACKER_PW)).status, 302);

  // Unverified but NOT a self-signup (e.g. an admin changed the email): can
  // log in, and verifying keeps the password and just marks it verified.
  const changed = `admin-changed-${uniq()}@example.test`;
  const { rows } = await pool.query("INSERT INTO users (email, password_hash, display_name) VALUES ($1, $2, 'Moved') RETURNING id", [changed, hash]);
  assert.equal((await login(changed, ATTACKER_PW)).status, 302);
  const raw = "plain-verify-" + uniq().replace(/[^0-9a-f]/g, "a");
  await pool.query("INSERT INTO email_verification_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [rows[0].id, require("crypto").createHash("sha256").update(raw).digest("hex")]);
  const before = await userRow(changed);
  const click = await pressConfirm(`/verify-email/${raw}`);
  assert.equal(click.headers.get("location"), "/login?verified=success");
  const after = await userRow(changed);
  assert.ok(after.email_verified_at);
  assert.equal(after.password_hash, before.password_hash, "password untouched");
  assert.equal((await login(changed, ATTACKER_PW)).status, 302);
});

test("password reset still verifies the email and lifts the sign-in block", async () => {
  const email = `reset-verifies-${uniq()}@example.test`;
  await signup(email);
  assert.equal((await login(email, ATTACKER_PW)).status, 401);
  await request("/forgot-password", { method: "POST", body: { email } });
  const resetPath = await linkFor(email, "reset-password");
  assert.equal((await request(resetPath, { method: "POST", body: { newPassword: VICTIM_PW } })).status, 302);
  const row = await userRow(email);
  assert.ok(row.email_verified_at);
  assert.equal(row.first_verification_pending, false);
  assert.equal((await login(email, ATTACKER_PW)).status, 401);
  assert.equal((await login(email, VICTIM_PW)).status, 302);
});

test("resend: sends a link for a waiting account, rate limited per account, neutral for everything else", async () => {
  const waiting = `resend-${uniq()}@example.test`;
  await signup(waiting, ATTACKER_PW);
  await waitFor(() => sent.some((m) => m.to === waiting), { message: "first link" });
  sent.length = 0;

  // Inside the cooldown: no second mail, same answer.
  const cooled = await request("/resend-verification", { method: "POST", body: { email: waiting } });
  const cooledBody = await cooled.text();
  assert.equal(cooled.status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent.length, 0, "no second link inside the cooldown");

  // Cooldown over: sends.
  await pool.query("UPDATE email_verification_tokens SET created_at = now() - interval '10 minutes' WHERE user_id = $1", [(await userRow(waiting)).id]);
  const again = await request("/resend-verification", { method: "POST", body: { email: waiting } });
  assert.equal(await again.text(), cooledBody, "identical response whether or not a mail went out");
  await waitFor(() => sent.some((m) => m.to === waiting), { message: "resent link" });

  // Unknown, verified and malformed addresses: same page, no mail.
  sent.length = 0;
  const verified = `resend-verified-${uniq()}@example.test`;
  await pool.query("INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, 'x', 'V', now())", [verified]);
  for (const email of [`nobody-${uniq()}@example.test`, verified, "", "garbage"]) {
    const r = await request("/resend-verification", { method: "POST", body: { email } });
    assert.equal(r.status, 200);
    assert.equal(await r.text(), cooledBody);
  }
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent.length, 0);

  // The per-IP cap (6 / 15 min) eventually answers 429.
  const statuses = [];
  for (let i = 0; i < 8; i++) statuses.push((await request("/resend-verification", { method: "POST", body: { email: `x${i}@example.test` } })).status);
  assert.ok(statuses.includes(429), "resend must be rate limited per IP");
});

test("login stays enumeration-neutral: unknown email and wrong password look the same, only the right password learns about the pending confirmation", async () => {
  const email = `enum-${uniq()}@example.test`;
  await signup(email, ATTACKER_PW);
  const wrong = await login(email, "Wrong-Pass-9!");
  const unknown = await login(`nobody-${uniq()}@example.test`, "Wrong-Pass-9!");
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  assert.equal(await wrong.text(), await unknown.text());
});
