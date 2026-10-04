// Server-side language support: the umasbooks_lang cookie (or Accept-Language)
// picks the language of rendered pages, <html lang>, tr(), and is remembered
// on users.lang / orders.lang for emails. Also tests the untranslated-text
// detector (test/helpers/i18nAudit.js) that follow-up translation PRs use.
// The 404 page is the proof page: it is fully translated.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");
const { visibleText, untranslated } = require("../helpers/i18nAudit");

const PORT = 3690;
const PASSWORD = "I18nCoreTest1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app;
let pool;

before(async () => {
  app = await startTestApp({ port: PORT });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});
after(async () => {
  await pool.end();
  await app.stop();
});

const uniq = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

async function page(path, headers = {}) {
  const res = await fetch(`${app.base}${path}`, { headers });
  return { res, html: await res.text() };
}

test("cookie fr: <html lang=fr> and the page is in French", async () => {
  const { res, html } = await page("/no-such-page", { cookie: "umasbooks_lang=fr" });
  assert.equal(res.status, 404);
  assert.match(html, /<html lang="fr">/);
  assert.match(html, /<h1>Page introuvable<\/h1>/);
  assert.ok(!html.includes("Page not found"));
});

test("no cookie: English, and Accept-Language fr gives French", async () => {
  const en = await page("/no-such-page");
  assert.match(en.html, /<html lang="en">/);
  assert.match(en.html, /<h1>Page not found<\/h1>/);
  const fr = await page("/no-such-page", { "accept-language": "fr-FR,fr;q=0.9,en;q=0.8" });
  assert.match(fr.html, /<html lang="fr">/);
  assert.match(fr.html, /<h1>Page introuvable<\/h1>/);
  const enFirst = await page("/no-such-page", { "accept-language": "en-US,en;q=0.9,fr;q=0.8" });
  assert.match(enFirst.html, /<html lang="en">/);
});

test("cookie en overrides Accept-Language fr", async () => {
  const { html } = await page("/no-such-page", { cookie: "umasbooks_lang=en", "accept-language": "fr-FR,fr;q=0.9" });
  assert.match(html, /<html lang="en">/);
  assert.match(html, /<h1>Page not found<\/h1>/);
});

test("the language middleware never creates a session", async () => {
  const { res } = await page("/no-such-page", { cookie: "umasbooks_lang=fr" });
  assert.equal(res.headers.getSetCookie().filter((c) => c.startsWith("umasbooks.sid")).length, 0);
});

test("the audit helper finds an untranslated node and passes a fully translated page", async () => {
  const en = (await page("/no-such-page")).html;
  const fr = (await page("/no-such-page", { cookie: "umasbooks_lang=fr" })).html;
  assert.deepEqual(untranslated(en, fr), [], "the 404 page should be fully translated");

  // A page where one paragraph was forgotten.
  const brokenFr = fr.replace("Retour à l’accueil", "Go home");
  assert.deepEqual(untranslated(en, brokenFr), ["Go home"]);

  // Allowlisted text, numbers, emails and URLs are never reported.
  assert.deepEqual(untranslated("<p>Uma's Books</p><p>12,50 €</p><p>a@b.org</p><p>https://x.org/y</p><p>Hello there</p>",
    "<p>Uma's Books</p><p>12,50 €</p><p>a@b.org</p><p>https://x.org/y</p><p>Bonjour</p>"), []);
  assert.deepEqual(untranslated("<p>Special offer</p>", "<p>Special offer</p>", ["Special offer"]), []);
  assert.deepEqual(untranslated("<p>Special offer</p>", "<p>Special offer</p>", [/^special/i]), []);

  // Text extraction: scripts/styles/comments dropped, entities decoded.
  assert.deepEqual(
    visibleText("<style>p{}</style><script>var a='Hidden words'</script><!-- note --><p>Tea &amp; Cake</p><p>  </p><b>One</b><i>Two</i>"),
    ["Tea & Cake", "One", "Two"]
  );
});

test("migration: users.lang and orders.lang only accept en, fr or NULL", async () => {
  for (const table of ["users", "orders"]) {
    const { rows } = await pool.query(
      "SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = 'lang'", [table]);
    assert.equal(rows.length, 1, `${table}.lang should exist`);
  }
  const email = `lang-check-${uniq()}@example.test`;
  await assert.rejects(
    pool.query("INSERT INTO users (email, password_hash, display_name, lang) VALUES ($1, 'x', 'T', 'de')", [email]),
    /users_lang_check/
  );
  await pool.query("INSERT INTO users (email, password_hash, display_name, lang) VALUES ($1, 'x', 'T', NULL)", [email]);
});

async function postForm(path, fields, jar, headers = {}) {
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { ...FORM, ...headers, cookie: [jar.header(), headers.cookie].filter(Boolean).join("; ") },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });
  jar.capture(res);
  await res.text();
  return res;
}

const userLang = async (email) => (await pool.query("SELECT lang FROM users WHERE email = $1", [email])).rows[0].lang;

test("signup stores the visitor's language on the new account", async () => {
  const emailFr = `signup-fr-${uniq()}@example.test`;
  const emailEn = `signup-en-${uniq()}@example.test`;
  const fields = (email) => ({ email, password: PASSWORD, displayName: "Lang Test" });
  await postForm("/signup", fields(emailFr), makeCookieJar(), { cookie: "umasbooks_lang=fr" });
  await postForm("/signup", fields(emailEn), makeCookieJar());
  assert.equal(await userLang(emailFr), "fr");
  assert.equal(await userLang(emailEn), "en");
});

test("login refreshes users.lang only when the visitor has chosen a language", async () => {
  const email = `login-lang-${uniq()}@example.test`;
  await pool.query(
    "INSERT INTO users (email, password_hash, display_name, lang) VALUES ($1, $2, 'Lang Login', 'en')",
    [email, await bcrypt.hash(PASSWORD, 12)]
  );
  const login = (headers) => postForm("/login", { email, password: PASSWORD }, makeCookieJar(), headers);

  // No cookie, even with French Accept-Language: a guess must not overwrite.
  assert.equal((await login({ "accept-language": "fr-FR" })).status, 302);
  assert.equal(await userLang(email), "en");

  assert.equal((await login({ cookie: "umasbooks_lang=fr" })).status, 302);
  assert.equal(await userLang(email), "fr");

  assert.equal((await login({ cookie: "umasbooks_lang=en" })).status, 302);
  assert.equal(await userLang(email), "en");
});

test("French dates: views calling formatDateLong()/formatDate() get the active language", async () => {
  const express = require("express");
  const ejs = require("ejs");
  const { langMiddleware } = require("../../src/middleware/lang");
  const tiny = express();
  tiny.use(langMiddleware);
  tiny.get("/d", (req, res) => {
    res.send(ejs.render("<p><%= formatDateLong(d) %></p><p><%= formatDate(d) %></p><p><%= tr('Hello {n}', 'Bonjour {n}', { n: 'Ana' }) %></p>",
      { ...res.locals, d: new Date("2026-08-05T12:00:00Z") }));
  });
  const server = await new Promise((r) => { const s = tiny.listen(0, "127.0.0.1", () => r(s)); });
  try {
    const url = `http://127.0.0.1:${server.address().port}/d`;
    const fr = await (await fetch(url, { headers: { cookie: "umasbooks_lang=fr" } })).text();
    assert.equal(fr, "<p>5 août 2026</p><p>05/08/2026</p><p>Bonjour Ana</p>");
    const en = await (await fetch(url)).text();
    assert.equal(en, "<p>5 August 2026</p><p>05/08/2026</p><p>Hello Ana</p>");
  } finally {
    server.close();
    server.closeAllConnections();
  }
});
