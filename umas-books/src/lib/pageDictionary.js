// Server-side rendering of the marketing pages' EN/FR dictionaries.
//
// The marketing pages (views/marketing/*.ejs) are written in English with
// data-i18n / data-i18n-html / data-i18n-attr hooks, plus an EN and an FR
// dictionary (the page's own, passed to partials/mkt_footer.ejs, and COMMON in
// assets/site.js). assets/site.js swaps the text in the browser when someone
// uses the EN/FR toggle. The server runs the SAME swap before sending, so
// search engines, no-JavaScript clients and print get the chosen language.
// There is one copy of every text: the dictionaries.
//
//   applyPageDictionary(html, dict)  pure: returns html with every hook filled from dict
//   commonDictionary(lang)           COMMON from assets/site.js (read once, never duplicated)
//   renderMarketing(req, res, next, view)   res.render + applyPageDictionary when req.lang is "fr"
//
// Same rules as site.js: data-i18n sets the element's text (escaped here),
// data-i18n-html sets its inner HTML, data-i18n-attr="attr:key;attr:key" sets
// attributes. A key missing from the dictionary leaves the English in place.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const SITE_JS = path.join(__dirname, "..", "..", "..", "assets", "site.js");
let common = null;

function commonDictionary(lang) {
  if (!common) {
    const src = fs.readFileSync(SITE_JS, "utf8");
    const start = src.indexOf("var COMMON = {");
    const end = src.indexOf("\n  };", start);
    if (start === -1 || end === -1) throw new Error("assets/site.js: cannot find the COMMON dictionary");
    common = vm.runInNewContext("(" + src.slice(start + "var COMMON = ".length, end + 4) + ")");
  }
  return common[lang === "fr" ? "fr" : "en"];
}

const escText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const escAttr = (s) => escText(s).replace(/"/g, "&quot;");

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
// An opening tag, quoted attribute values may contain ">".
const OPEN_TAG = /<([a-zA-Z][a-zA-Z0-9]*)((?:\s(?:"[^"]*"|'[^']*'|[^>"'])*)?)>/g;

function getAttr(attrs, name) {
  const m = new RegExp("\\s" + name + "=(?:\"([^\"]*)\"|'([^']*)')").exec(attrs);
  return m ? (m[1] !== undefined ? m[1] : m[2]) : null;
}

function setAttr(attrs, name, value) {
  const re = new RegExp("(\\s" + name + "=)(?:\"[^\"]*\"|'[^']*')");
  const v = '"' + escAttr(value) + '"';
  if (re.test(attrs)) return attrs.replace(re, (m, pre) => pre + v);
  return attrs.replace(/\s*\/?$/, "") + " " + name + "=" + v + (/\/\s*$/.test(attrs) ? " /" : "");
}

// Index just after the </tag> that closes the element opened at `from`.
function closeIndex(html, tag, from) {
  const re = new RegExp("<(/?)" + tag + "\\b[^>]*>", "gi");
  re.lastIndex = from;
  let depth = 1, m;
  while ((m = re.exec(html))) {
    if (m[1]) { if (--depth === 0) return { start: m.index, end: re.lastIndex }; }
    else if (!/\/>$/.test(m[0])) depth++;
  }
  return null;
}

function applySegment(html, dict) {
  let out = "", pos = 0;
  OPEN_TAG.lastIndex = 0;
  let m;
  while ((m = OPEN_TAG.exec(html))) {
    if (m.index < pos) continue;
    const tag = m[1].toLowerCase();
    let attrs = m[2] || "";
    if (!/\sdata-i18n/.test(attrs)) continue;
    const attrSpec = getAttr(attrs, "data-i18n-attr");
    if (attrSpec) {
      for (const pair of attrSpec.split(";")) {
        const i = pair.indexOf(":");
        if (i === -1) continue;
        const name = pair.slice(0, i).trim(), key = pair.slice(i + 1).trim();
        if (name && Object.prototype.hasOwnProperty.call(dict, key)) attrs = setAttr(attrs, name, dict[key]);
      }
    }
    const textKey = getAttr(attrs, "data-i18n");
    const htmlKey = getAttr(attrs, "data-i18n-html");
    const key = textKey !== null ? textKey : htmlKey;
    const openEnd = m.index + m[0].length;
    const open = "<" + m[1] + attrs + ">";
    if (key !== null && Object.prototype.hasOwnProperty.call(dict, key) && !VOID.has(tag)) {
      const close = closeIndex(html, tag, openEnd);
      if (close) {
        const value = textKey !== null ? escText(dict[key]) : String(dict[key]);
        out += html.slice(pos, m.index) + open + value;
        pos = close.start;
        OPEN_TAG.lastIndex = close.start;
        continue;
      }
    }
    out += html.slice(pos, m.index) + open;
    pos = openEnd;
  }
  return out + html.slice(pos);
}

function applyPageDictionary(html, dict) {
  // Never touch <script>/<style> bodies (they hold the dictionaries and page JS).
  return String(html).split(/(<(?:script|style)\b[\s\S]*?<\/(?:script|style)>)/i)
    .map((part, i) => (i % 2 ? part : applySegment(part, dict)))
    .join("");
}

function renderMarketing(req, res, next, view) {
  let page = { en: {}, fr: {} };
  // partials/mkt_footer.ejs reports the page's own dictionaries through this.
  res.locals.registerPageDict = (en, fr) => { page = { en: en || {}, fr: fr || {} }; };
  res.render(view, (err, html) => {
    if (err) return next(err);
    if (req.lang === "fr") html = applyPageDictionary(html, { ...commonDictionary("fr"), ...page.fr });
    res.send(html);
  });
}

module.exports = { applyPageDictionary, commonDictionary, renderMarketing };
