// Per-request language. The person's choice lives in the `umasbooks_lang`
// cookie (written by assets/site.js whenever the EN/FR toggle is used). No
// cookie: fall back to the browser's Accept-Language. Sets:
//   req.lang / res.locals.lang / res.locals.htmlLang   'en' | 'fr'
//   req.langFromCookie                                 true when the cookie held a valid choice
//   req.tr(en, fr, vars?) / res.locals.tr(...)         string for the active language
//   res.locals.eur(n)                                  euro amount in the active language (lib/money.js)
//   res.locals.formatDate/formatDateTime/formatTime/formatDateLong   locale-aware
// It reads headers only: no session, no database.
const { forLocale, LOCALES } = require("../lib/dates");
const { translator, normLang } = require("../lib/lang");
const { conditionLabel } = require("../lib/inventory");
const { formatEuro } = require("../lib/money");
const { assetUrl } = require("../lib/assetUrl");
const { installFrenchRender } = require("../lib/frenchTypography");

const COOKIE_NAME = "umasbooks_lang";

function cookieValue(header, name) {
  if (!header) return undefined;
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

function fromAcceptLanguage(header) {
  const first = String(header || "").split(",")[0].trim().toLowerCase();
  return /^fr(\b|$)/.test(first) ? "fr" : "en";
}

function detectLang(req) {
  const c = cookieValue(req.headers.cookie, COOKIE_NAME);
  if (c !== undefined) return { lang: c === "fr" ? "fr" : "en", fromCookie: normLang(c) !== null };
  return { lang: fromAcceptLanguage(req.headers["accept-language"]), fromCookie: false };
}

const formatters = { en: forLocale(LOCALES.en), fr: forLocale(LOCALES.fr) };

function langMiddleware(req, res, next) {
  const { lang, fromCookie } = detectLang(req);
  const tr = translator(lang);
  req.lang = lang;
  req.langFromCookie = fromCookie;
  req.tr = tr;
  res.locals.lang = lang;
  res.locals.htmlLang = lang;
  res.locals.tr = tr;
  res.locals.assetUrl = assetUrl; // versioned /assets, /style.css ... URLs (lib/assetUrl.js)
  res.locals.eur = (n) => formatEuro(n, lang);
  res.locals.conditionLabel = (value) => conditionLabel(value, lang);
  Object.assign(res.locals, formatters[lang]);

  // French pages: no-break spaces before ; : ! ? » and curly apostrophes in the
  // text of whatever view renders (lib/frenchTypography.js). The admin panel is
  // English-only, so it is left alone.
  if (lang === "fr" && !/^\/admin(\/|$)/.test(req.path)) installFrenchRender(res);

  // A page cacheable by a shared cache (routes set `public, max-age`) now
  // differs by language, so it must be cached per cookie / Accept-Language.
  // Static assets are served before this middleware and are unaffected.
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    const cc = this.getHeader("Cache-Control");
    if (cc && /public/i.test(String(cc))) this.vary("Cookie, Accept-Language");
    return writeHead.apply(this, args);
  };
  next();
}

module.exports = { langMiddleware, detectLang, cookieValue, COOKIE_NAME };
