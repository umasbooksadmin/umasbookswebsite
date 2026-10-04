// Language plumbing without a server: the helpers in lib/lang.js, the request
// middleware (middleware/lang.js) and the per-locale date formatters.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normLang, pickLang, emailTr, translator } = require("../../src/lib/lang");
const { langMiddleware, cookieValue } = require("../../src/middleware/lang");
const { forLocale, formatDate, formatDateTime, formatTime, formatDateLong } = require("../../src/lib/dates");

function run(headers = {}, cacheControl) {
  const resHeaders = {};
  const res = {
    locals: {},
    getHeader: (k) => resHeaders[k.toLowerCase()] ?? cacheControl,
    vary: (v) => { resHeaders.vary = v; },
    writeHead() { return this; },
  };
  const req = { headers };
  langMiddleware(req, res, () => {});
  return { req, res, resHeaders };
}

test("normLang and pickLang only accept en/fr", () => {
  assert.equal(normLang("fr"), "fr");
  assert.equal(normLang("en"), "en");
  for (const bad of ["FR", "de", "", null, undefined, 5]) assert.equal(normLang(bad), null);
  assert.equal(pickLang(null, "de", "fr", "en"), "fr");
  assert.equal(pickLang(undefined, "xx"), null);
});

test("translator picks the language, falls back to English and fills {placeholders}", () => {
  const fr = translator("fr");
  const en = translator("en");
  assert.equal(fr("Hello", "Bonjour"), "Bonjour");
  assert.equal(en("Hello", "Bonjour"), "Hello");
  assert.equal(fr("Hello", ""), "Hello");
  assert.equal(fr("Hello", undefined), "Hello");
  assert.equal(fr("Hi {name}", "Salut {name}", { name: "Ana" }), "Salut Ana");
  assert.equal(en("Hi {name}, {other}", "x", { name: "Ana" }), "Hi Ana, {other}");
  // No escaping: <%= %> in the view does that.
  assert.equal(en("Hi {name}", "x", { name: "<b>" }), "Hi <b>");
});

test("emailTr treats unknown languages as English", () => {
  assert.equal(emailTr("fr")("Hi", "Salut"), "Salut");
  assert.equal(emailTr("en")("Hi", "Salut"), "Hi");
  assert.equal(emailTr(null)("Hi", "Salut"), "Hi");
  assert.equal(emailTr("de")("Hi", "Salut"), "Hi");
});

test("cookie parsing is manual and exact", () => {
  assert.equal(cookieValue("a=1; umasbooks_lang=fr; b=2", "umasbooks_lang"), "fr");
  assert.equal(cookieValue("xumasbooks_lang=fr", "umasbooks_lang"), undefined);
  assert.equal(cookieValue(undefined, "umasbooks_lang"), undefined);
});

test("middleware: cookie wins; only exactly 'fr' is French", () => {
  assert.equal(run({ cookie: "umasbooks_lang=fr" }).req.lang, "fr");
  assert.equal(run({ cookie: "umasbooks_lang=FR" }).req.lang, "en");
  assert.equal(run({ cookie: "umasbooks_lang=fr-FR" }).req.lang, "en");
  assert.equal(run({ cookie: "umasbooks_lang=en", "accept-language": "fr-FR,fr;q=0.9" }).req.lang, "en");
  const { req, res } = run({ cookie: "umasbooks_lang=fr" });
  assert.equal(req.langFromCookie, true);
  assert.equal(res.locals.lang, "fr");
  assert.equal(res.locals.htmlLang, "fr");
  assert.equal(res.locals.tr("Yes", "Oui"), "Oui");
  assert.equal(req.tr("Yes", "Oui"), "Oui");
});

test("middleware: no cookie falls back to the first Accept-Language tag", () => {
  assert.equal(run({ "accept-language": "fr-CA,fr;q=0.9,en;q=0.8" }).req.lang, "fr");
  assert.equal(run({ "accept-language": "en-US,fr;q=0.9" }).req.lang, "en");
  assert.equal(run({}).req.lang, "en");
  assert.equal(run({ "accept-language": "fr" }).req.langFromCookie, false);
});

test("middleware: only publicly cacheable responses get Vary", () => {
  const { res, resHeaders } = run({}, "public, max-age=60");
  res.writeHead(200);
  assert.equal(resHeaders.vary, "Cookie, Accept-Language");
  const other = run({}, "no-store");
  other.res.writeHead(200);
  assert.equal(other.resHeaders.vary, undefined);
});

test("French dates use French month names in Paris time, same shape as English", () => {
  const d = new Date("2026-10-03T10:30:00Z"); // 12:30 in Paris
  const fr = forLocale("fr-FR");
  assert.equal(fr.formatDateLong(d), "3 octobre 2026");
  assert.equal(formatDateLong(d), "3 October 2026");
  assert.equal(fr.formatDate(d), "03/10/2026");
  assert.equal(formatDate(d), "03/10/2026");
  assert.equal(fr.formatTime(d), "12:30");
  assert.equal(formatTime(d), "12:30");
  assert.match(fr.formatDateTime(d), /^03\/10\/2026,? 12:30$/);
  assert.match(formatDateTime(d), /^03\/10\/2026,? 12:30$/);
  for (const [iso, month] of [["2026-01-15", "janvier"], ["2026-02-15", "février"], ["2026-03-15", "mars"], ["2026-04-15", "avril"], ["2026-05-15", "mai"], ["2026-06-15", "juin"], ["2026-07-15", "juillet"], ["2026-08-15", "août"], ["2026-09-15", "septembre"], ["2026-11-15", "novembre"], ["2026-12-15", "décembre"]]) {
    assert.ok(fr.formatDateLong(new Date(`${iso}T12:00:00Z`)).includes(month), `${iso} should say ${month}`);
  }
  // Late evening UTC is already the next day in Paris.
  assert.equal(fr.formatDateLong(new Date("2026-12-31T23:30:00Z")), "1 janvier 2027");
});

test("the middleware gives views locale-aware date helpers", () => {
  const d = new Date("2026-08-05T12:00:00Z");
  assert.equal(run({ cookie: "umasbooks_lang=fr" }).res.locals.formatDateLong(d), "5 août 2026");
  assert.equal(run({ cookie: "umasbooks_lang=en" }).res.locals.formatDateLong(d), "5 August 2026");
});
