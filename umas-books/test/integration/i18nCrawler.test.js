// The French completeness crawler as a permanent test (test/helpers/i18nCrawl.js).
//
// Boots the real app on its own database, seeds one of everything a customer can see,
// then walks every customer page as a guest, an account holder, a member and a
// volunteer, plus the refused and successful form posts, the JSON APIs and the
// error pages, each in English and in French (cookie `umasbooks_lang`). The test
// fails when the French render still holds English text:
//   - text identical to the English page, or
//   - text with English function words (the, your, please...), or
//   - text equal to an English string written in the source as tr("English", "Français").
// Anything legitimately the same in both languages (a brand, a legal identifier, a
// program name, a word spelled alike) goes in test/i18n-allowlist.js WITH A REASON.
//
// To fix a failure: wrap the text in tr('English', 'Français') (views and routes),
// or add the key to both dictionaries (marketing pages, assets/site.js). See
// docs/i18n-audit.md ("Definition of done").
//
// Port 3698 is reserved for this file (3697 is the manual audit script).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { crawl, findEnglish, captureEnv } = require("../helpers/i18nCrawl");
const { ALLOW } = require("../i18n-allowlist");

const PORT = 3698;
let app;
let result;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true, env: captureEnv() });
  result = await crawl(app, { allow: ALLOW });
});
after(async () => {
  await app.stop();
});

test("the crawl covers every persona, the main pages, the form posts and the emails", () => {
  const personas = new Set(result.pages.map((p) => p.persona));
  for (const p of ["guest", "account", "member", "volunteer", "email"]) assert.ok(personas.has(p), `persona ${p} was crawled`);
  assert.ok(result.pages.length >= 150, `only ${result.pages.length} pages crawled`);
  const paths = result.pages.map((p) => p.path);
  for (const needle of ["/books/", "/cart", "/account", "/forum", "/volunteer", "/membership.html", "POST login: wrong password", "POST contact: ok", "EMAIL cart: reserve"]) {
    assert.ok(paths.some((x) => x.includes(needle)), `${needle} was crawled`);
  }
});

test("no customer page, message or email is left in English on the French render", () => {
  const bad = [];
  for (const p of result.pages) for (const i of p.items) if (!i.allowed) bad.push(`${p.persona} ${p.path}: (${i.reason}) ${i.text.slice(0, 140)}`);
  assert.deepEqual(bad, [], "untranslated text: use tr('English', 'Français') or the page dictionary, or allow-list it with a reason in test/i18n-allowlist.js");
});

test("every French HTML page says lang=\"fr\"", () => {
  const wrong = result.pages.filter((p) => p.htmlLang !== null && p.htmlLang !== "fr").map((p) => `${p.path}: lang=${p.htmlLang}`);
  assert.deepEqual(wrong, []);
});

test("the refused form posts really were refused (the scenarios still test what they say)", () => {
  const by = (name) => result.pages.find((p) => p.path === `POST ${name}`);
  for (const name of ["login: wrong password", "signup: no name", "contact: empty", "request a book: empty", "change password: wrong current", "forum: new without text"]) {
    const p = by(name);
    assert.ok(p, `${name} ran`);
    assert.equal(p.status, 200, `${name} ends on a page`);
    assert.ok(p.texts.length > 10, `${name} rendered a page`);
  }
  const frTexts = (name) => by(name).texts.join("\n");
  assert.match(frTexts("login: wrong password"), /E-mail ou mot de passe incorrect/);
  assert.match(frTexts("contact: empty"), /Veuillez indiquer votre nom/);
  assert.match(frTexts("change password: wrong current"), /mot de passe actuel est incorrect/);
  assert.equal(by("admin page as a customer").status, 403);
  assert.match(by("CSRF refused").texts.join("\n"), /session a expiré/);
});

test("the English heuristics catch English and leave French and brand names alone", () => {
  const page = "<p>Please check your basket and continue to the checkout.</p><p>Uma's Books and Adventures</p>";
  // identical in both languages: the English sentence is caught, the brand name is allowed
  const same = findEnglish(page, page, ALLOW).filter((i) => !i.allowed).map((i) => i.text);
  assert.deepEqual(same, ["Please check your basket and continue to the checkout."]);
  // English words in a page that differs from the English one are caught too
  const frOnly = findEnglish("<p>Mon panier</p>", "<p>Click here to continue with your order</p>", ALLOW);
  assert.equal(frOnly.length, 1);
  assert.equal(findEnglish("<p>My basket</p>", "<p>Votre panier est vide, cliquez ici pour continuer</p>", ALLOW).length, 0);
  // a title ending with the brand is not English because of the "and" in it
  assert.equal(findEnglish("<title>Books — Uma's Books and Adventures</title>", "<title>Livres — Uma's Books and Adventures</title>", ALLOW).length, 0);
});

test("every allow-list entry gives its reason", () => {
  for (const a of ALLOW) assert.ok(a.reason && a.reason.length >= 10, `allow-list entry ${String(a.match)} needs a reason`);
});
