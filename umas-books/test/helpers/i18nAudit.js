// Safety net for the French translation work: given the HTML of one page
// rendered in English and in French, find text that is IDENTICAL in both
// renders, i.e. text nobody translated.
//
//   visibleText(html)                  -> array of the page's text nodes
//   untranslated(enHtml, frHtml, allow) -> text nodes present in both renders
//                                          that are not on the allowlist
//   ALLOWLIST                          -> shared exceptions (brand names,
//                                          legal identifiers, the shop address)
//
// A text node only counts when it has at least 3 letters, so numbers,
// prices, punctuation, "EN"/"FR", emails and URLs are never reported.
// Allowlist entries are exact strings (compared case-insensitively) or RegExps.

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", mdash: "—", ndash: "–", hellip: "…", euro: "€", middot: "·", larr: "←", rarr: "→", rsaquo: "›", lsaquo: "‹", laquo: "«", raquo: "»" };

function decodeEntities(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return Object.prototype.hasOwnProperty.call(ENTITIES, e.toLowerCase()) ? ENTITIES[e.toLowerCase()] : m;
  });
}

const EMAIL_RE = /^\S+@\S+\.\S+$/;
const URL_RE = /^(https?:\/\/|www\.)\S+$/i;
const LETTERS_RE = /\p{L}/gu;

function visibleText(html) {
  const withoutCode = String(html)
    .replace(/<!--[\s\S]*?-->/g, "\n")
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, "\n");
  return withoutCode
    .replace(/<[^>]*>/g, "\n")
    .split("\n")
    .map((line) => decodeEntities(line).replace(/\s+/g, " ").trim())
    .filter((line) => line && !EMAIL_RE.test(line) && !URL_RE.test(line));
}

// Text people (and search engines, screen readers) get from attributes the
// text scan never sees: aria-label, alt, placeholder, title, and the meta
// description / Open Graph / Twitter text.
const ATTR_RE = /\s(aria-label|alt|placeholder|title)=(?:"([^"]*)"|'([^']*)')/gi;
const META_RE = /<meta\b[^>]*>/gi;
function visibleAttributes(html) {
  const out = [];
  const body = String(html).replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, "");
  for (const tag of body.match(/<[a-zA-Z][^>]*>/g) || []) {
    for (const m of tag.matchAll(ATTR_RE)) out.push(m[2] !== undefined ? m[2] : m[3]);
  }
  for (const tag of body.match(META_RE) || []) {
    if (/(name|property)=["'](description|og:title|og:description|og:image:alt|twitter:title|twitter:description)["']/i.test(tag)) {
      const c = /\scontent="([^"]*)"/i.exec(tag);
      if (c) out.push(c[1]);
    }
  }
  return out.map((t) => decodeEntities(t).replace(/\s+/g, " ").trim()).filter(Boolean);
}

function hasThreeLetters(text) {
  return (text.match(LETTERS_RE) || []).length >= 3;
}

// Brand names, legal identifiers and places that are the same in both languages.
const ALLOWLIST = [
  "Uma's Books",
  "Uma’s Books",
  "Uma's Books & Adventures",
  "Uma’s Books & Adventures",
  "Uma’s Books and Adventures",
  "Uma's Books and Adventures",
  "HelloAsso",
  "RNA",
  "SIRET",
  "SIREN",
  "Instagram",
  "Facebook",
  "Albi, France",
  "Albi",
  "Admin", // admin link in the header: admin screens stay English
  "Adventures", // the shop's name ("Uma's Books and Adventures") in the events hero
  "Contact", // the same word in French
  /^Render( Services, Inc\.)?$|^render\.com$|^cm2c\.net$|^Google$|^Backblaze$|^GitHub$|^UMAS BOOKS$|^Anthropic$/, // processors named in the privacy policy and legal notice
  /^TVA non applicable(, art\. .* du CGI)?$|^Prix TTC, TVA non applicable/, // French legal mention, required as is
  /^(Éveil English|Young Readers|Young Adventurers|Little Explorers|Teen Literature|English Café)$/, // programme names, English on purpose
  // The official consumer-law notice (Consumer Code art. D211-2) is French in both languages by law.
  /^(Le |La |Les |Toute |Si |Lorsque ).*(consommat|garantie|bien\b)/,
  /^https?:\/\/$/, // a URL field placeholder
  "Language / Langue", // the toggle's label is bilingual on purpose
  /Rue Peyroli[eè]re/i, // the shop address
  /Hippolyte Savary/i, // the association's registered office
];

function isAllowed(text, allowlist) {
  const lower = text.toLowerCase();
  return allowlist.some((a) => (a instanceof RegExp ? a.test(text) : String(a).toLowerCase() === lower));
}

function untranslated(enHtml, frHtml, allowlist = []) {
  const allow = [...ALLOWLIST, ...allowlist];
  const fr = new Set([...visibleText(frHtml), ...visibleAttributes(frHtml)]);
  const seen = new Set();
  const out = [];
  for (const text of [...visibleText(enHtml), ...visibleAttributes(enHtml)]) {
    if (seen.has(text) || !fr.has(text) || !hasThreeLetters(text) || isAllowed(text, allow)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

module.exports = { visibleText, visibleAttributes, untranslated, ALLOWLIST };
