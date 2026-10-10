// The French site lives under /fr/: the SAME public pages, rendered in French
// whatever the cookie or Accept-Language says, so a search engine (which sends
// neither) can index them. Everything else (forms, /api/..., the cart, login,
// accounts, members, admin) exists once, unprefixed: a French page posts to the
// normal URL, and the answer follows the language cookie a /fr/ visit sets.
//
//   isPublicPath("/books/12")        true   -> has a /fr/ twin
//   localize("/books.html?genre=x")  "/fr/books.html?genre=x"
//   splitFr("/fr/visit.html?a=1")    { prefixed: true, rest: "/visit.html?a=1" }
//   prefixLinks(html)                the <a href="/..."> links to public pages gain /fr
//   seoLinks(site, path, lang)       canonical + hreflang alternates (absolute)
//   switchHrefs(url)                 the EN / FR toggle targets for the current page
//
// assets/site.js carries a copy of the public-path rule for links it writes in
// the browser; test/unit/frUrls.test.js keeps the two in step.

const MARKETING_PAGES = require("./marketingPages");

const PREFIX = "/fr";

// "/volunteer" is the volunteers' area (an app route), not the marketing page
// "volunteer.html"; the extensionless form of every other marketing page is a 301
// to its ".html" address and so has a /fr/ twin too.
const APP_OWNED_BARE = new Set(["volunteer"]);
const EXACT = new Set(["/", "/contact", "/events", "/sessions", "/request-a-book", "/request-a-book/sent"]);
for (const file of MARKETING_PAGES) {
  EXACT.add("/" + file);
  const bare = file.replace(/\.html$/, "");
  if (!APP_OWNED_BARE.has(bare)) EXACT.add("/" + bare);
}
const BOOK_PAGE = /^\/books\/\d+$/;

// "/path?query#hash" -> ["/path", "?query#hash"]
function splitUrl(url) {
  const s = String(url);
  const i = s.search(/[?#]/);
  return i === -1 ? [s, ""] : [s.slice(0, i), s.slice(i)];
}

// A page that has an English and a French address. `pathname` is the unprefixed path.
function isPublicPath(pathname) {
  let p = String(pathname || "");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return EXACT.has(p) || BOOK_PAGE.test(p);
}

function isFrPath(pathname) {
  return pathname === PREFIX || String(pathname).startsWith(PREFIX + "/");
}

// "/fr/visit.html?a=1" -> { prefixed: true, rest: "/visit.html?a=1" }; "/fr" -> rest "/".
// Not a prefixed address: { prefixed: false, rest: url }.
function splitFr(url) {
  const [p, tail] = splitUrl(url);
  if (!isFrPath(p)) return { prefixed: false, rest: String(url) };
  const rest = p.slice(PREFIX.length) || "/";
  return { prefixed: true, rest: rest + tail };
}

// The /fr/ twin of an absolute path (with optional query), or the input unchanged
// when it is not a public page, is already prefixed, or is not a local path.
function localize(url) {
  const s = String(url);
  if (!s.startsWith("/") || s.startsWith("//")) return s;
  const [p, tail] = splitUrl(s);
  if (isFrPath(p) || !isPublicPath(p)) return s;
  return (p === "/" ? PREFIX + "/" : PREFIX + p) + tail;
}

// Absolute URLs for a page's <head>. `path` is the unprefixed path (no query);
// `site` the canonical base URL without a trailing slash ('' when unknown).
// Public pages: the canonical URL is the one in the page's own language and the
// alternates are en, fr and x-default (English). Other pages: canonical only.
function seoLinks(site, path, lang) {
  const base = site ? String(site).replace(/\/+$/, "") : "";
  if (!base || !path) return { canonical: "", alternates: [] };
  const en = base + path;
  if (!isPublicPath(path)) return { canonical: en, alternates: [{ hreflang: "x-default", href: en }] };
  const fr = base + localize(path);
  return {
    canonical: lang === "fr" ? fr : en,
    en,
    fr,
    alternates: [
      { hreflang: "en", href: en },
      { hreflang: "fr", href: fr },
      { hreflang: "x-default", href: en },
    ],
  };
}

// Where the EN and FR buttons go from the page at `url` (the unprefixed path
// plus query), or null when the page has no twin (the buttons then reload).
function switchHrefs(url) {
  const [p, tail] = splitUrl(url);
  if (!isPublicPath(p)) return null;
  return { en: p + tail, fr: localize(p) + tail };
}

// Public-page links inside French /fr/ HTML stay inside /fr/. Only <a href="/...">
// is touched (never forms, assets or API calls), never a link marked data-lang
// (the language toggle points at the other language on purpose), and never the
// text of <script>/<style>.
const A_TAG = /<a\b(?:"[^"]*"|'[^']*'|[^>"'])*>/gi;
function prefixSegment(html) {
  return html.replace(A_TAG, (tag) => {
    if (/\sdata-lang=/.test(tag)) return tag;
    return tag.replace(/(\shref=")(\/[^"]*)(")/i, (m, pre, href, post) => pre + localize(href) + post);
  });
}
function prefixLinks(html) {
  return String(html).split(/(<(?:script|style)\b[\s\S]*?<\/(?:script|style)>)/i)
    .map((part, i) => (i % 2 ? part : prefixSegment(part)))
    .join("");
}

module.exports = { PREFIX, isPublicPath, isFrPath, splitFr, localize, seoLinks, switchHrefs, prefixLinks, splitUrl };
