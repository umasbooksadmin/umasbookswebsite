// French for the account and login flow: pages that need a login or a token
// (the public ones are in i18nCoverage.test.js), server messages, the language
// chosen at signup and the inactivity-warning email.
// Port 3710 (3691 is i18nCoverage, 3690 i18nCore).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");
const { untranslated } = require("../helpers/i18nAudit");

process.env.SESSION_SECRET = "test-session-secret-not-for-production"; // same as the app under test
const totp = require("../../src/lib/totp");

const PORT = 3710;
const PASSWORD = "AccountsFr1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
// "Code" is the same word in both languages; the other is the TOTP key.
const ALLOW = ["Code", /^[A-Z2-7]{16,}$/, "Emma", /^&middot;/]; // + a book title from the seeded order and an entity the helper does not decode

let app, pool, privacy, mailer;
const sent = [];

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  privacy = require("../../src/lib/privacy");
  mailer = require("../../src/mailer");
  mailer.sendMail = async (opts) => { sent.push(opts); };
});
after(async () => {
  await pool.end();
  app.stop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function createUser({ verified = true, yearsAgo = null, lang = null } = {}) {
  const email = `afr-${uniq()}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, email_verified_at, lang, last_login_at, created_at)
     VALUES ($1, $2, 'Ana Test', CASE WHEN $3 THEN now() END, $4,
             CASE WHEN $5::int IS NULL THEN now() ELSE now() - make_interval(years => $5::int) END,
             CASE WHEN $5::int IS NULL THEN now() ELSE now() - make_interval(years => $5::int) END)
     RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10), verified, lang, yearsAgo]
  );
  return { id: rows[0].id, email };
}

const cookieFor = (jar, lang) => `${jar.header()}; umasbooks_lang=${lang}`;
async function get(jar, p, lang) {
  const res = await fetch(`${app.base}${p}`, { redirect: "manual", headers: { cookie: cookieFor(jar, lang) } });
  jar.capture(res);
  return { res, text: await res.text() };
}
async function post(jar, p, fields, lang) {
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}${p}`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: cookieFor(jar, lang) },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });
  jar.capture(res);
  return { res, text: await res.text() };
}
async function loginJar(email, lang = "en") {
  const jar = makeCookieJar();
  const r = await post(jar, "/login", { email, password: PASSWORD }, lang);
  assert.equal(r.res.status, 302, "login should succeed");
  return jar;
}
async function assertTranslated(jar, p, { status = 200 } = {}) {
  const en = await get(jar, p, "en");
  const fr = await get(jar, p, "fr");
  assert.equal(en.res.status, status, `${p} EN status`);
  assert.equal(fr.res.status, status, `${p} FR status`);
  assert.match(fr.text, /<html lang="fr"/);
  assert.deepEqual(untranslated(en.text, fr.text, ALLOW), [], `${p}: same text in English and French`);
  return { en: en.text, fr: fr.text };
}

test("/account (unverified and with an order) is fully translated", async () => {
  const unverified = await createUser({ verified: false });
  await assertTranslated(await loginJar(unverified.email), "/account");

  const u = await createUser();
  const { rows } = await pool.query(
    "INSERT INTO orders (buyer_email, buyer_name, total_amount, status) VALUES ($1, 'Ana', 12.5, 'paid') RETURNING id",
    [u.email]
  );
  const { rows: b } = await pool.query("INSERT INTO books (title, authors) VALUES ('Emma', 'A') RETURNING id");
  const { rows: c } = await pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'sold', 12.5) RETURNING id", [b[0].id]);
  await pool.query(
    "INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, 'Emma', 12.5)",
    [rows[0].id, c[0].id]
  );
  const pages = await assertTranslated(await loginJar(u.email), "/account");
  assert.match(pages.fr, /Payée/);
  assert.match(pages.fr, /Total\u00a0: 12,50/);
  assert.match(pages.en, /Total: €12\.50/);
  const none = await createUser();
  const empty = await assertTranslated(await loginJar(none.email), "/account");
  assert.match(empty.fr, /Aucune commande pour le moment/);
});

test("/account/password and the 2FA pages are fully translated", async () => {
  const u = await createUser();
  const jar = await loginJar(u.email);
  await assertTranslated(jar, "/account/password");
  const setup = await assertTranslated(jar, "/account/2fa"); // setup screen
  assert.match(setup.fr, /Activer la vérification en deux étapes/);

  const secret = totp.decryptSecret((await pool.query("SELECT totp_secret_enc FROM users WHERE id=$1", [u.id])).rows[0].totp_secret_enc);
  const bad = await post(jar, "/account/2fa/enable", { password: "wrong", code: "000000" }, "fr");
  assert.equal(bad.res.status, 400);
  assert.match(bad.text, /Votre mot de passe ne correspond pas/);
  const wrongCode = await post(jar, "/account/2fa/enable", { password: PASSWORD, code: "000000" }, "fr");
  assert.match(wrongCode.text, /Ce code ne correspond pas/);

  const ok = await post(jar, "/account/2fa/enable", { password: PASSWORD, code: totp.hotp(secret, totp.currentStep()) }, "fr");
  assert.equal(ok.res.status, 200);
  assert.match(ok.text, /Enregistrez dès maintenant ces codes de récupération/);
  assert.doesNotMatch(ok.text, /Save these recovery codes/);

  const status = await assertTranslated(jar, "/account/2fa"); // enrolled: status screen
  assert.match(status.fr, /Il vous reste 10 codes de récupération inutilisés/);
  assert.match(status.en, /You have 10 unused recovery codes/);

  const wrong = await post(jar, "/account/2fa/disable", { code: "000000" }, "fr");
  assert.equal(wrong.res.status, 400);
  assert.match(wrong.text, /Ce code ne correspond pas\./);

  // Login with 2FA: the code page and its French error.
  const jar2 = makeCookieJar();
  const r = await post(jar2, "/login", { email: u.email, password: PASSWORD }, "fr");
  assert.equal(r.res.headers.get("location"), "/login/2fa");
  await assertTranslated(jar2, "/login/2fa");
  const fail = await post(jar2, "/login/2fa", { code: "123456" }, "fr");
  assert.equal(fail.res.status, 401);
  assert.match(fail.text, /Ce code n’a pas fonctionné\. Veuillez réessayer\./);
});

test("/reset-password with a live token is fully translated, weak passwords get French messages", async () => {
  const u = await createUser();
  const raw = `fr-reset-token-${uniq()}`;
  await pool.query(
    "INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, now() + interval '1 hour')",
    [u.id, crypto.createHash("sha256").update(raw).digest("hex")]
  );
  const jar = makeCookieJar();
  const pages = await assertTranslated(jar, `/reset-password/${raw}`);
  assert.match(pages.fr, /Choisir un nouveau mot de passe/);
  assert.match(pages.fr, /8 caractères minimum, avec une majuscule/);

  const weak = await post(jar, `/reset-password/${raw}`, { newPassword: "abcdefghij" }, "fr");
  assert.equal(weak.res.status, 400);
  assert.match(weak.text, /Le mot de passe doit contenir une lettre majuscule, un chiffre, un symbole\./);
  const weakEn = await post(jar, `/reset-password/${raw}`, { newPassword: "abcdefghij" }, "en");
  assert.match(weakEn.text, /Password must include an uppercase letter, a number, a symbol\./);
});

test("French server messages: wrong password, notices, forgot-password, change password", async () => {
  const u = await createUser();
  const jar = makeCookieJar();
  const wrong = await post(jar, "/login", { email: u.email, password: "Nope-Nope-1" }, "fr");
  assert.equal(wrong.res.status, 401);
  assert.match(wrong.text, /E-mail ou mot de passe incorrect\./);
  assert.doesNotMatch(wrong.text, /Incorrect email or password/);
  const wrongEn = await post(makeCookieJar(), "/login", { email: u.email, password: "Nope-Nope-1" }, "en");
  assert.match(wrongEn.text, /Incorrect email or password\./);

  assert.match((await get(jar, "/login?reset=success", "fr")).text, /Mot de passe mis à jour\u00a0: connectez-vous/);
  assert.match((await get(jar, "/login?verified=success", "fr")).text, /Adresse e-mail confirmée, merci/);
  assert.match((await get(jar, "/login?verified=invalid", "fr")).text, /Ce lien de confirmation est invalide ou a expiré\./);
  await assertTranslated(jar, "/login?verified=success");

  const forgot = await post(makeCookieJar(), "/forgot-password", { email: "nobody@example.test" }, "fr");
  assert.match(forgot.text, /Si un compte existe pour cette adresse e-mail/);

  const bad = await get(makeCookieJar(), "/reset-password/not-a-token", "fr");
  assert.equal(bad.res.status, 400);
  assert.match(bad.text, /Ce lien de réinitialisation est invalide ou a expiré\./);

  const li = await loginJar(u.email, "fr");
  const wrongCurrent = await post(li, "/account/password", { currentPassword: "Nope-Nope-1", newPassword: "Another-Good-9" }, "fr");
  assert.equal(wrongCurrent.res.status, 401);
  assert.match(wrongCurrent.text, /Le mot de passe actuel est incorrect\./);
  const done = await post(li, "/account/password", { currentPassword: PASSWORD, newPassword: "Another-Good-9" }, "fr");
  assert.match(done.text, /Mot de passe mis à jour\./);
});

test("signup in French: French notice and form copy, the account keeps the chosen language", async () => {
  const jar = makeCookieJar();
  const missing = await post(jar, "/signup", { email: "", password: "", displayName: "" }, "fr");
  assert.equal(missing.res.status, 400);
  assert.match(missing.text, /Tous les champs sont obligatoires\./);
  const form = await post(jar, "/signup", { email: "", displayName: "" }, "fr");
  assert.match(form.text, /Nous vous enverrons par e-mail un lien pour confirmer votre adresse et choisir votre mot de passe\./);

  const email = `afr-signup-${uniq()}@example.test`;
  const ok = await post(jar, "/signup", { email, password: "Correct-Horse-1", displayName: "Ana" }, "fr");
  assert.equal(ok.res.status, 200);
  assert.match(ok.text, /Merci\u00a0! Consultez votre boîte de réception/);
  const { rows } = await pool.query("SELECT lang FROM users WHERE email = $1", [email]);
  assert.equal(rows[0].lang, "fr");

  // The mail built for that row is the French one.
  const { sendVerificationEmail } = require("../../src/lib/emailVerification");
  const before = sent.length;
  const created = (await pool.query("SELECT id, email, display_name, lang FROM users WHERE email = $1", [email])).rows[0];
  await sendVerificationEmail(created, "https://shop.test", { throttle: "off" }); // the signup above already mailed this address
  assert.match(sent[before].subject, /^Confirmez votre adresse e-mail/);
  await sendVerificationEmail(created, "https://shop.test", { choosePassword: true, throttle: "off" });
  assert.match(sent[before + 1].subject, /^Confirmez votre adresse e-mail et choisissez votre mot de passe/);
});

test("inactivity warning is sent in the account's language", async () => {
  const fr = await createUser({ yearsAgo: 4, lang: "fr" });
  const en = await createUser({ yearsAgo: 4, lang: "en" });
  const none = await createUser({ yearsAgo: 4, lang: null });
  sent.length = 0;
  await privacy.purgeExpiredPersonalData(pool);
  const to = (u) => sent.find((m) => m.to === u.email);
  assert.match(to(fr).subject, /^Votre compte Uma's Books sera supprimé dans 30 jours/);
  assert.match(to(fr).text, /^Bonjour Ana Test,/);
  assert.match(to(en).subject, /^Your Uma's Books account will be deleted/);
  assert.match(to(none).text, /^Hi Ana Test,/);
});

test("the Show/Hide password toggle has French labels keyed on <html lang>", () => {
  const js = fs.readFileSync(path.join(__dirname, "../../public/app.js"), "utf8");
  assert.match(js, /document\.documentElement\.lang === "fr"/);
  for (const s of ["Afficher", "Masquer", "Afficher le mot de passe", "Masquer le mot de passe", '"Show"', '"Hide"']) {
    assert.ok(js.includes(s), `app.js lacks ${s}`);
  }
});
