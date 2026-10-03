// Generic "is this page fully translated?" check. Each page in PAGES is
// rendered in English and in French by the real app, and untranslated()
// (test/helpers/i18nAudit.js) must find no text that is identical in both.
//
// HOW TO USE (follow-up translation PRs): once a customer-facing GET page is
// translated, append its path to PAGES below. Pages that need a login or
// special data are not covered here; test those in their own file with the
// same untranslated() helper. Text that is legitimately the same in both
// languages (a brand name, a legal identifier) goes in EXTRA_ALLOWLIST (exact
// string or RegExp); keep that list short and justified, the shared one is
// ALLOWLIST in the helper.
//
// Port 3691 is reserved for this file (3690 is i18nCore.test.js).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { startTestApp } = require("../helpers/testApp");
const { untranslated } = require("../helpers/i18nAudit");

const PORT = 3691;

// Append translated customer-facing pages here.
const PAGES = [
  "/this-page-does-not-exist", // views/404.ejs
  "/events", // views/events.ejs + calendar partials (seeded calendars: i18nCommunity.test.js)
  "/events?view=week",
  "/sessions", // views/sessions.ejs
  "/sessions?view=week&type=dropin",
  "/contact", // views/contact.ejs
  "/contact?sent=1",
];

// "Éveil" is a program name, French in both languages.
const EXTRA_ALLOWLIST = [/^[ÉE]veil$/, "Message"]; // same word in French

let app;
before(async () => {
  app = await startTestApp({ port: PORT });
});
after(async () => {
  await app.stop();
});

const render = async (path, cookie) => (await fetch(`${app.base}${path}`, { headers: { cookie } })).text();

for (const path of PAGES) {
  test(`${path} is fully translated`, async () => {
    const en = await render(path, "umasbooks_lang=en");
    const fr = await render(path, "umasbooks_lang=fr");
    assert.match(fr, /<html lang="fr"/);
    assert.deepEqual(untranslated(en, fr, EXTRA_ALLOWLIST), [], `${path}: same text in English and French`);
  });
}
