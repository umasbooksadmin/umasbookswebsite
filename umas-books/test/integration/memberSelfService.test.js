// Members download or delete their own data: /account/privacy (routes/accountPrivacy.js).
//
// Most tests run against the real app (real login, CSRF and sessions) on
// port 3730. The confirmation email is checked in-process, because the
// mailer can only be stubbed there (see test/helpers/inProcessApp.js).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken, withSeeOtherPage } = require("../helpers/httpClient");
const { untranslated } = require("../helpers/i18nAudit");
const { buildApp, listen } = require("../helpers/inProcessApp");

const PORT = 3730;
const PASSWORD = "SelfService1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app, pool;
const sent = [];

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  require("../../src/mailer").sendMail = async (opts) => { sent.push(opts); };
});

after(async () => {
  await pool.end();
  app.stop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function createUser({ admin = false, lang = null, name = "Self Service", verified = true } = {}) {
  const email = `self-${uniq()}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at, lang)
     VALUES ($1, $2, $3, $4, ${verified ? "now()" : "NULL"}, $5) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10), name, admin, lang]
  );
  return { id: rows[0].id, email };
}

async function loginAs(user) {
  const jar = makeCookieJar();
  const token = await fetchCsrfToken(app.base, jar);
  const login = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() },
    body: new URLSearchParams({ email: user.email, password: PASSWORD, _csrf: token }).toString(),
  });
  jar.capture(login);
  assert.equal(login.status, 302);
  return jar;
}

async function post(path, jar, fields, { lang } = {}) {
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}${path}`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: jar.header() + (lang ? `; umasbooks_lang=${lang}` : "") },
    body: new URLSearchParams({ _csrf: token, ...fields }).toString(),
  });
  // A refusal answers 303 to /account/privacy; the wrapper's text() is that page.
  return withSeeOtherPage(res, { base: app.base, jar, headers: lang ? { cookie: `umasbooks_lang=${lang}` } : {} });
}

const get = (path, jar, lang) =>
  fetch(`${app.base}${path}`, {
    redirect: "manual",
    headers: { cookie: (jar ? jar.header() : "") + (lang ? `; umasbooks_lang=${lang}` : "") },
  });

const exportAs = (jar, currentPassword, opts) => post("/account/privacy/export", jar, { currentPassword }, opts);
const deleteAs = (jar, fields, opts) => post("/account/privacy/delete", jar, { currentPassword: PASSWORD, ...fields }, opts);
const userExists = async (id) => (await pool.query("SELECT 1 FROM users WHERE id = $1", [id])).rowCount === 1;

test("the privacy page needs a login and renders for a member", async () => {
  const anon = await get("/account/privacy");
  assert.equal(anon.status, 302);
  assert.equal(anon.headers.get("location"), "/login");
  const jar = await loginAs(await createUser());
  const res = await get("/account/privacy", jar);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /action="\/account\/privacy\/export"/);
  assert.match(html, /action="\/account\/privacy\/delete"/);
});

test("the account page links to the privacy page", async () => {
  const jar = await loginAs(await createUser());
  assert.match(await (await get("/account", jar)).text(), /href="\/account\/privacy"/);
});

test("download: wrong password gives no JSON", async () => {
  const jar = await loginAs(await createUser());
  const res = await exportAs(jar, "not-the-password");
  assert.equal(res.status, 303);
  assert.doesNotMatch(res.headers.get("content-type"), /json/);
  assert.equal(res.headers.get("content-disposition"), null);
  assert.match(await res.text(), /Current password is incorrect/);
});

test("download: wrong password is throttled after 5 tries, even with the right password", async () => {
  const jar = await loginAs(await createUser());
  for (let i = 0; i < 5; i++) assert.equal((await exportAs(jar, "nope")).status, 303);
  assert.equal((await exportAs(jar, PASSWORD)).status, 429);
  // The delete form shares the same throttle.
  assert.equal((await deleteAs(jar, { confirmation: "DELETE" })).status, 429);
});

test("download: right password returns only the member's own data, with no secrets", async () => {
  const me = await createUser();
  const other = await createUser();
  await pool.query(
    "INSERT INTO orders (buyer_name, buyer_email, status, total_amount) VALUES ('Me', $1, 'paid', 7)",
    [me.email.toUpperCase()]
  );
  await pool.query(
    "INSERT INTO orders (buyer_name, buyer_email, status, total_amount) VALUES ('Other', $1, 'paid', 9)",
    [other.email]
  );
  await pool.query("INSERT INTO forum_threads (title, body, author_id) VALUES ('Mine', 'my words', $1)", [me.id]);
  await pool.query("INSERT INTO forum_threads (title, body, author_id) VALUES ('Theirs', 'their words', $1)", [other.id]);

  const jar = await loginAs(me);
  const res = await exportAs(jar, PASSWORD);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /attachment; filename="umasbooks-my-data\.json"/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const text = await res.text();
  const data = JSON.parse(text);
  assert.equal(data.user.email, me.email);
  assert.equal(data.orders.length, 1);
  assert.equal(data.orders[0].buyer_name, "Me");
  assert.deepEqual(data.forum_threads.map((t) => t.title), ["Mine"]);
  assert.ok(!("password_hash" in data.user));
  assert.doesNotMatch(text, /\$2[aby]\$/); // no bcrypt hash anywhere
  assert.ok(!text.includes(other.email));
  assert.ok(!text.includes("their words"));
});

test("download: audit row has the member id and no email or name", async () => {
  const me = await createUser({ name: "Audit Name" });
  const jar = await loginAs(me);
  assert.equal((await exportAs(jar, PASSWORD)).status, 200);
  const { rows } = await pool.query(
    "SELECT * FROM admin_audit_log WHERE action = 'member.self_export' AND actor_user_id = $1", [me.id]
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].target_id, me.id);
  assert.equal(rows[0].target_type, "user");
  assert.equal(rows[0].actor_label, "self");
  assert.doesNotMatch(JSON.stringify(rows[0]), new RegExp(`${me.email}|Audit Name`));
});

test("delete: wrong password or wrong confirmation word changes nothing", async () => {
  const me = await createUser();
  const jar = await loginAs(me);
  assert.equal((await deleteAs(jar, { currentPassword: "nope", confirmation: "DELETE" })).status, 303);
  const noWord = await deleteAs(jar, { confirmation: "yes please" });
  assert.equal(noWord.status, 303);
  assert.match(await noWord.text(), /Type DELETE/);
  assert.equal((await deleteAs(jar, {})).status, 303);
  assert.ok(await userExists(me.id));
  assert.equal((await get("/account", jar)).status, 200);
});

test("delete: the right flow erases the account, anonymises paid orders and logs the member out", async () => {
  const me = await createUser();
  const { rows: ev } = await pool.query("INSERT INTO events (title, starts_at) VALUES ('Quiz', now()) RETURNING id");
  await pool.query("INSERT INTO event_signups (event_id, name, email) VALUES ($1, 'Me', $2)", [ev[0].id, me.email]);
  const { rows: ord } = await pool.query(
    "INSERT INTO orders (buyer_name, buyer_email, status, total_amount) VALUES ('Me', $1, 'paid', 7) RETURNING id",
    [me.email]
  );
  const jar = await loginAs(me);
  assert.equal((await get("/account", jar)).status, 200);

  const res = await deleteAs(jar, { confirmation: " delete " }); // case-insensitive
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/account/deleted");
  assert.match(res.headers.getSetCookie().join("\n"), /umasbooks\.sid=;[^\n]*Expires=Thu, 01 Jan 1970/);
  jar.capture(res);

  assert.equal(await userExists(me.id), false);
  assert.equal((await pool.query("SELECT 1 FROM event_signups WHERE lower(email) = $1", [me.email])).rowCount, 0);
  const { rows: o } = await pool.query("SELECT buyer_name, buyer_email, status FROM orders WHERE id = $1", [ord[0].id]);
  assert.equal(o[0].status, "paid");
  assert.equal(o[0].buyer_name, "Erased");
  assert.match(o[0].buyer_email, /@erased\.invalid$/);

  // The old cookie is useless now.
  const after = await get("/account", jar);
  assert.equal(after.status, 302);
  assert.equal(after.headers.get("location"), "/login");

  // The goodbye page is public.
  const bye = await get("/account/deleted");
  assert.equal(bye.status, 200);
  assert.match(await bye.text(), /Your account has been deleted/);

  const { rows: log } = await pool.query(
    "SELECT * FROM admin_audit_log WHERE action = 'member.self_erase' AND actor_user_id = $1", [me.id]
  );
  assert.equal(log.length, 1);
  assert.equal(log[0].target_id, me.id);
  assert.equal(log[0].actor_label, "self");
  assert.doesNotMatch(JSON.stringify(log[0]), new RegExp(me.email));
});

test("delete: SUPPRIMER works too", async () => {
  const me = await createUser();
  const jar = await loginAs(me);
  assert.equal((await deleteAs(jar, { confirmation: "supprimer" }, { lang: "fr" })).status, 303);
  assert.equal(await userExists(me.id), false);
});

test("delete: administrators are refused (another admin exists)", async () => {
  const admin = await createUser({ admin: true });
  await createUser({ admin: true });
  const jar = await loginAs(admin);
  const res = await deleteAs(jar, { confirmation: "DELETE" });
  assert.equal(res.status, 303);
  assert.match(await res.text(), /Administrators can(&#39;|')t delete their own account here: ask another administrator/);
  assert.ok(await userExists(admin.id));
});

test("delete: the last administrator is refused", async () => {
  // Needs a database where this admin really is the only one, so it gets its
  // own throwaway database (other test files share the main one in CI).
  const solo = await startTestApp({ port: 3731, isolated: true });
  const { Client } = require("pg");
  const db = new Client({ connectionString: solo.databaseUrl, ssl: process.env.PGSSLMODE === "disable" ? false : undefined });
  await db.connect();
  try {
    const email = `solo-${uniq()}@example.test`;
    const { rows } = await db.query(
      `INSERT INTO users (email, password_hash, display_name, is_admin, email_verified_at)
       VALUES ($1, $2, 'Solo', TRUE, now()) RETURNING id`,
      [email, await bcrypt.hash(PASSWORD, 10)]
    );
    await db.query("UPDATE users SET is_admin = FALSE WHERE id <> $1", [rows[0].id]);
    const jar = makeCookieJar();
    let token = await fetchCsrfToken(solo.base, jar);
    const login = await fetch(`${solo.base}/login`, {
      method: "POST", redirect: "manual",
      headers: { ...FORM, cookie: jar.header() },
      body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }).toString(),
    });
    jar.capture(login);
    assert.equal(login.status, 302);
    token = await fetchCsrfToken(solo.base, jar);
    const res = await fetch(`${solo.base}/account/privacy/delete`, {
      method: "POST", redirect: "manual",
      headers: { ...FORM, cookie: jar.header() },
      body: new URLSearchParams({ currentPassword: PASSWORD, confirmation: "DELETE", _csrf: token }).toString(),
    });
    assert.equal(res.status, 303);
    const shown = await withSeeOtherPage(res, { base: solo.base, jar });
    assert.match(await shown.text(), /last administrator/);
    assert.equal((await db.query("SELECT 1 FROM users WHERE id = $1", [rows[0].id])).rowCount, 1);
  } finally {
    await db.end();
    solo.stop();
  }
});

test("wrong password is answered in French with the fr cookie", async () => {
  const jar = await loginAs(await createUser());
  const res = await exportAs(jar, "nope", { lang: "fr" });
  assert.equal(res.status, 303);
  assert.match(await res.text(), /Le mot de passe actuel est incorrect/);
});

test("the privacy page is fully translated (signed in, admin and member views)", async () => {
  for (const user of [await createUser(), await createUser({ admin: true })]) {
    const jar = await loginAs(user);
    const en = await (await get("/account/privacy", jar, "en")).text();
    const fr = await (await get("/account/privacy", jar, "fr")).text();
    assert.match(fr, /<html lang="fr"/);
    assert.deepEqual(untranslated(en, fr, []), []);
  }
});

// ---- confirmation email (in-process, mailer stubbed) ----

async function deleteInProcess(user, { mailFails = false } = {}) {
  sent.length = 0;
  const mailer = require("../../src/mailer");
  const original = mailer.sendMail;
  if (mailFails) mailer.sendMail = async () => { throw new Error("smtp down"); };
  const server = await listen(buildApp([require("../../src/routes/accountPrivacy")]));
  try {
    const res = await fetch(`${server.base}/account/privacy/delete`, {
      method: "POST", redirect: "manual",
      headers: { ...FORM, "x-test-user": JSON.stringify({ id: user.id, email: user.email }) },
      body: new URLSearchParams({ currentPassword: PASSWORD, confirmation: "DELETE" }).toString(),
    });
    return res;
  } finally {
    mailer.sendMail = original;
    await server.close();
  }
}

test("confirmation email is sent in French to a French member, before the deletion", async () => {
  const me = await createUser({ lang: "fr", name: "Marie" });
  const res = await deleteInProcess(me);
  assert.equal(res.status, 303);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, me.email);
  assert.match(sent[0].subject, /supprimé/);
  assert.match(sent[0].text, /Bonjour Marie/);
  assert.match(sent[0].text, /anonymisées/);
  assert.equal(await userExists(me.id), false);
});

test("confirmation email is in English by default", async () => {
  const me = await createUser({ lang: null });
  await deleteInProcess(me);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /has been deleted/);
  assert.match(sent[0].text, /anonymised/);
});

test("a failed confirmation email does not block the deletion", async () => {
  const me = await createUser();
  const res = await deleteInProcess(me, { mailFails: true });
  assert.equal(res.status, 303);
  assert.equal(await userExists(me.id), false);
});

// ---- unverified email: nothing is handed out or erased ----
// Orders, reservations, sign-ups and book requests are matched to an account
// by email address only, and signup does not prove the address is the
// signer's own. An unverified account could belong to someone who typed a
// victim's address.

async function victimData(email) {
  const { rows: ord } = await pool.query(
    "INSERT INTO orders (buyer_name, buyer_email, status, total_amount) VALUES ('Victim Buyer', $1, 'paid', 7) RETURNING id",
    [email]
  );
  const { rows: ev } = await pool.query("INSERT INTO events (title, starts_at) VALUES ('Victim Quiz', now()) RETURNING id");
  await pool.query("INSERT INTO event_signups (event_id, name, email) VALUES ($1, 'Victim', $2)", [ev[0].id, email]);
  return ord[0].id;
}

const tokenCount = async (id) => (await pool.query("SELECT COUNT(*)::int AS n FROM email_verification_tokens WHERE user_id = $1", [id])).rows[0].n;

test("unverified: the download is refused (403), no file, nothing logged", async () => {
  const me = await createUser({ verified: false });
  await victimData(me.email);
  const jar = await loginAs(me);
  const res = await exportAs(jar, PASSWORD); // even with the right password
  assert.equal(res.status, 303);
  assert.doesNotMatch(res.headers.get("content-type"), /json/);
  assert.equal(res.headers.get("content-disposition"), null);
  const html = await res.text();
  assert.match(html, /Confirm your email address first/);
  assert.doesNotMatch(html, /Victim Buyer/);
  const { rows } = await pool.query("SELECT 1 FROM admin_audit_log WHERE action = 'member.self_export' AND target_id = $1", [me.id]);
  assert.equal(rows.length, 0);
});

test("unverified: the deletion is refused (403) and the account, orders and sign-ups are untouched", async () => {
  sent.length = 0;
  const me = await createUser({ verified: false });
  const orderId = await victimData(me.email);
  const jar = await loginAs(me);
  const res = await deleteAs(jar, { confirmation: "DELETE" });
  assert.equal(res.status, 303);
  assert.match(await res.text(), /Confirm your email address first/);
  assert.equal(await userExists(me.id), true);
  const { rows: o } = await pool.query("SELECT buyer_name, buyer_email FROM orders WHERE id = $1", [orderId]);
  assert.equal(o[0].buyer_name, "Victim Buyer");
  assert.equal(o[0].buyer_email, me.email);
  assert.equal((await pool.query("SELECT 1 FROM event_signups WHERE lower(email) = $1", [me.email])).rowCount, 1);
  assert.equal(sent.filter((m) => m.to === me.email).length, 0, "no goodbye email either");
  const { rows } = await pool.query("SELECT 1 FROM admin_audit_log WHERE action = 'member.self_erase' AND target_id = $1", [me.id]);
  assert.equal(rows.length, 0);
});

test("unverified: the refusal does not reveal whether the password was right, and does not count as a wrong password", async () => {
  const jar = await loginAs(await createUser({ verified: false }));
  for (let i = 0; i < 7; i++) assert.equal((await exportAs(jar, "nope")).status, 303);
});

test("unverified: the page explains why, offers the resend button and hides both forms (EN and FR)", async () => {
  const me = await createUser({ verified: false });
  const jar = await loginAs(me);
  const res = await get("/account/privacy", jar);
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Confirm your email address first/);
  assert.ok(html.includes(me.email));
  assert.match(html, /action="\/account\/privacy\/resend-verification"/);
  assert.doesNotMatch(html, /action="\/account\/privacy\/export"/);
  assert.doesNotMatch(html, /action="\/account\/privacy\/delete"/);
  const fr = await (await get("/account/privacy", jar, "fr")).text();
  assert.match(fr, /Confirmez d’abord votre adresse e-mail/);
  assert.match(fr, /Renvoyer l’e-mail de confirmation/);
  assert.deepEqual(untranslated(html, fr, []), []);
});

test("verified: the page still shows both forms and no resend button", async () => {
  const html = await (await get("/account/privacy", await loginAs(await createUser()))).text();
  assert.match(html, /action="\/account\/privacy\/export"/);
  assert.match(html, /action="\/account\/privacy\/delete"/);
  assert.doesNotMatch(html, /resend-verification/);
});

test("unverified: once the address is confirmed the download works", async () => {
  const me = await createUser({ verified: false });
  const jar = await loginAs(me);
  assert.equal((await exportAs(jar, PASSWORD)).status, 303);
  await pool.query("UPDATE users SET email_verified_at = now() WHERE id = $1", [me.id]);
  const res = await exportAs(jar, PASSWORD);
  assert.equal(res.status, 200);
  assert.equal(JSON.parse(await res.text()).user.email, me.email);
});

test("resend: sends one new link, then waits 2 minutes, and never repeats for a verified account", async () => {
  const me = await createUser({ verified: false });
  const jar = await loginAs(me);
  assert.equal(await tokenCount(me.id), 0);
  const first = await post("/account/privacy/resend-verification", jar, {});
  assert.equal(first.status, 303);
  assert.equal(first.headers.get("location"), "/account/privacy?sent=1");
  assert.equal(await tokenCount(me.id), 1);
  assert.match(await (await get("/account/privacy?sent=1", jar)).text(), /We sent a new confirmation link/);
  const again = await post("/account/privacy/resend-verification", jar, {});
  assert.equal(again.headers.get("location"), "/account/privacy?sent=wait");
  assert.equal(await tokenCount(me.id), 1, "the cooldown stops a second link");
  assert.match(await (await get("/account/privacy?sent=wait", jar)).text(), /sent a moment ago/);

  const verified = await loginAs(await createUser());
  const res = await post("/account/privacy/resend-verification", verified, {});
  assert.equal(res.status, 303);
  assert.equal(res.headers.get("location"), "/account/privacy");
});

test("resend: needs a login and is capped at 3 an hour per account", async () => {
  const anon = await post("/account/privacy/resend-verification", makeCookieJar(), {});
  assert.notEqual(anon.status, 200);
  assert.equal(anon.headers.get("location"), "/login");
  const me = await createUser({ verified: false });
  const jar = await loginAs(me);
  for (let i = 0; i < 3; i++) {
    await pool.query("DELETE FROM email_verification_tokens WHERE user_id = $1", [me.id]); // skip the 2-minute cooldown
    assert.equal((await post("/account/privacy/resend-verification", jar, {})).status, 303);
  }
  await pool.query("DELETE FROM email_verification_tokens WHERE user_id = $1", [me.id]);
  const res = await post("/account/privacy/resend-verification", jar, {});
  assert.equal(res.status, 429);
  assert.equal(await tokenCount(me.id), 0);
});

test("resend: the email goes to the account's own address, in the account's language", async () => {
  sent.length = 0;
  const me = await createUser({ verified: false, lang: "fr" });
  const mailer = require("../../src/mailer");
  const original = mailer.sendMail;
  mailer.sendMail = async (opts) => { sent.push(opts); };
  const server = await listen(buildApp([require("../../src/routes/accountPrivacy")]));
  try {
    const res = await fetch(`${server.base}/account/privacy/resend-verification`, {
      method: "POST", redirect: "manual",
      headers: { ...FORM, "x-test-user": JSON.stringify({ id: me.id, email: "someone-else@example.test" }) },
      body: new URLSearchParams({ to: "attacker@example.test", email: "attacker@example.test" }).toString(),
    });
    assert.equal(res.status, 303);
  } finally {
    mailer.sendMail = original;
    await server.close();
  }
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, me.email);
  assert.match(sent[0].subject, /Confirmez votre adresse e-mail/);
  assert.match(sent[0].text, /\/verify-email\//);
});

test("the data file's explanatory note follows the language (the field names do not), and an admin address refuses a customer in their language", async () => {
  const jar = await loginAs(await createUser());
  const fr = await exportAs(jar, PASSWORD, { lang: "fr" });
  assert.equal(fr.status, 200);
  const frData = JSON.parse(await fr.text());
  assert.match(frData.note, /^Données personnelles détenues par Uma's Books sur ce compte\./);
  assert.ok(frData.user && frData.exported_at, "the field names stay the database's");
  const en = JSON.parse(await (await exportAs(jar, PASSWORD, { lang: "en" })).text());
  assert.match(en.note, /^Personal data held by Uma's Books about this account\./);

  const frAdmin = await get("/admin", jar, "fr");
  assert.equal(frAdmin.status, 403);
  assert.equal(await frAdmin.text(), "Réservé aux administrateurs.");
  const enAdmin = await get("/admin", jar, "en");
  assert.equal(await enAdmin.text(), "Admins only.");
});
