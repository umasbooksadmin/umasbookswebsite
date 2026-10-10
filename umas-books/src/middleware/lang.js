// Per-request language. The person's choice lives in the `umasbooks_lang`
// cookie (written by assets/site.js whenever the EN/FR toggle is used). No
// cookie: fall back to the browser's Accept-Language. Sets:
//   req.lang / res.locals.lang / res.locals.htmlLang   'en' | 'fr'
//   req.langFromCookie                                 true when the cookie held a valid choice
//   req.tr(en, fr, vars?) / res.locals.tr(...)         string for the active language
//   res.locals.legalText / fillVat / socialLinks        shared legal sentences in the active language (lib/legalText.js)
//   res.locals.eur(n)                                  euro amount in the active language (lib/money.js)
//   res.locals.formatDate/formatDateTime/formatTime/formatDateLong   locale-aware
//   req.frPrefix / res.locals.frPrefix                 true when the URL started with /fr/ (src/lib/frUrls.js)
//   res.locals.langSwitch()                            { en, fr } toggle targets for this page, or null
// A /fr/ address is always French and is served by the page's unprefixed route
// (the prefix is stripped from req.url; req.originalUrl keeps it). It also writes
// the language cookie, so the POSTs and redirects that follow stay French. A
// res.redirect to a public page is sent to its /fr/ twin when the person's
// language is French. It reads headers only: no session, no database.
const { forLocale, LOCALES } = require("../lib/dates");
const { translator, normLang } = require("../lib/lang");
const { genreLabel, genresLabel } = require("../lib/genres");
const { conditionLabel } = require("../lib/inventory");
const { formatEuro } = require("../lib/money");
const { assetUrl } = require("../lib/assetUrl");
const { installFrenchRender } = require("../lib/frenchTypography");
const { legalFor, fillVat } = require("../lib/legalText");
const { SOCIAL_LINKS } = require("../lib/legal");
const { splitFr, isPublicPath, localize, switchHrefs, splitUrl } = require("../lib/frUrls");

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

// Crawlers and link-preview fetchers: no language cookie is written for them.
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|lighthouse|pingdom|uptime/i;

function detectLang(req) {
  // A /fr/ address is French whatever the cookie or the browser say.
  if (splitFr(req.originalUrl || req.url || "").prefixed) return { lang: "fr", fromCookie: true };
  const c = cookieValue(req.headers.cookie, COOKIE_NAME);
  if (c !== undefined) return { lang: c === "fr" ? "fr" : "en", fromCookie: normLang(c) !== null };
  return { lang: fromAcceptLanguage(req.headers["accept-language"]), fromCookie: false };
}

const formatters = { en: forLocale(LOCALES.en), fr: forLocale(LOCALES.fr) };

function langMiddleware(req, res, next) {
  const { lang, fromCookie } = detectLang(req);
  const fr = splitFr(req.url);
  req.frPrefix = fr.prefixed;
  res.locals.frPrefix = fr.prefixed;
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
  res.locals.genreLabel = (genre) => genreLabel(genre, lang);
  res.locals.genresLabel = (csv, storedFr) => genresLabel(csv, lang, storedFr);
  res.locals.legalText = legalFor(lang);
  res.locals.fillVat = fillVat;
  res.locals.socialLinks = SOCIAL_LINKS;
  Object.assign(res.locals, formatters[lang]);

  // French pages: no-break spaces before ; : ! ? » and curly apostrophes in the
  // text of whatever view renders (lib/frenchTypography.js). The admin panel is
  // English-only, so it is left alone.
  if (lang === "fr" && !/^\/admin(\/|$)/.test(req.path)) installFrenchRender(res);

  res.locals.langSwitch = () => switchHrefs(splitFr(req.originalUrl || req.url).rest);

  // A redirect to a public page lands on its /fr/ twin when the language is
  // French: always for a /fr/ request, and for a one-off (302/303) redirect from
  // a French visitor on an unprefixed address. A permanent redirect from an
  // unprefixed address is never language-dependent (a cache may keep it).
  const redirect = res.redirect;
  res.redirect = function (...args) {
    const k = typeof args[0] === "number" ? 1 : 0;
    const status = k ? args[0] : 302;
    if (lang === "fr" && typeof args[k] === "string" && (fr.prefixed || (status !== 301 && status !== 308))) args[k] = localize(args[k]);
    return redirect.apply(this, args);
  };

  if (fr.prefixed && (req.method === "GET" || req.method === "HEAD")) {
    const [path, tail] = splitUrl(fr.rest);
    if (splitUrl(req.url)[0] === "/fr") return res.redirect(301, "/fr/" + (tail || "")); // /fr -> /fr/ (relative links need the slash)
    if (isPublicPath(path)) {
      req.url = fr.rest; // the page's own route answers; req.originalUrl keeps /fr/
      // A person arriving on a French address is a French reader: remember it,
      // so the form posts and redirects that follow stay French.
      if (cookieValue(req.headers.cookie, COOKIE_NAME) !== "fr" && !BOT_UA.test(String(req.headers["user-agent"] || ""))) {
        res.append("Set-Cookie", `${COOKIE_NAME}=fr; Path=/; Max-Age=31536000; SameSite=Lax${req.secure ? "; Secure" : ""}`);
      }
    }
    // Any other /fr/... address (admin, cart, a typo) matches no route: a French 404.
  }

  // Any HTML page differs by language (cookie / Accept-Language), so a shared
  // cache (a CDN, a proxy) must key it on both. Cache-Control stays as each
  // route set it. Redirects do not depend on the language, and anything a route
  // marks `public` is covered too (JSON endpoints included). Static assets are
  // served before this middleware and are unaffected.
  const writeHead = res.writeHead;
  res.writeHead = function (...args) {
    const cc = this.getHeader("Cache-Control");
    const type = this.getHeader("Content-Type");
    const status = this.statusCode;
    const html = type && /^text\/html/i.test(String(type)) && !(status >= 300 && status < 400);
    if (html || (cc && /public/i.test(String(cc)))) this.vary("Accept-Language, Cookie");
    return writeHead.apply(this, args);
  };
  next();
}

module.exports = { langMiddleware, detectLang, cookieValue, COOKIE_NAME };
