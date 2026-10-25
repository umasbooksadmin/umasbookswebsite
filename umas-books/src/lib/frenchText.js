// French versions of admin-written texts (events, sessions, announcements, charities): ONE place for "is the French
// ready", "which language to show" and "how an HTML text is made safe". The blog has the same rules for its own
// columns (lib/blogPosts.js); this module covers the other entities with the same conventions:
//
//  * Every French column is nullable (migration 097) and sits next to its English one: title / title_fr, ...
//  * The English text is never changed. French is used on a page only when it is READY (frenchState); a half-written
//    French text is never shown, the English text is, labelled as English (`fallback: true` -> lang="en" and a small
//    "EN" marker in the views).
//  * An HTML text (an announcement's body) is run through the same sanitize-html allowlist when it is written (the admin
//    routes) and again here when it is served, so a row that got into the table another way cannot put script on a page.
//
// What "ready" needs, per kind (SPECS): the fields the page cannot do without (`need`), plus the fields that are
// needed only when the English text has them (`needIfEnglish`: a French description for an event that has an English
// one, so a card never mixes the two languages). `optional` fields (a place name, an address) are used when written,
// else the English one is shown as it is.

const { sanitizeHtml } = require("./sanitizeHtml");

const SPECS = {
  event: { fields: ["title", "description", "location"], need: ["title"], needIfEnglish: ["description"], html: [] },
  session: { fields: ["title"], need: ["title"], needIfEnglish: [], html: [] },
  announcement: { fields: ["title", "excerpt", "body"], need: ["title", "body"], needIfEnglish: ["excerpt"], html: ["body"] },
  charity: { fields: ["description"], need: [], needIfEnglish: ["description"], html: [] },
  round: { fields: ["title"], need: ["title"], needIfEnglish: [], html: [] },
};

// An editor holding only empty paragraphs and line breaks counts as empty.
function hasText(html) {
  return Boolean(String(html == null ? "" : html).replace(/<[^>]*>/g, "").replace(/&nbsp;|[\s\u00a0]/g, ""));
}
const filled = (spec, field, value) => (spec.html.includes(field) ? hasText(value) : Boolean(String(value == null ? "" : value).trim()));

// "missing": no French text at all. "ready": every needed field is written. "draft": some French, not enough to show.
function frenchState(kind, row) {
  const spec = SPECS[kind];
  const fr = (f) => filled(spec, f, row[`${f}_fr`]);
  if (!spec.fields.some(fr)) return "missing";
  const needed = [...spec.need, ...spec.needIfEnglish.filter((f) => filled(spec, f, row[f]))];
  return needed.every(fr) ? "ready" : "draft";
}

// A copy of `row` carrying the text to show in `lang`: the fields of the kind hold the French text when lang is "fr" and
// the French is ready, else the English text (an HTML field is sanitised either way it is French). Also:
//   frLang    the language of the text now in the fields: "fr" or "en"
//   fallback  true when French was asked for, is not ready, and there is English text to show (views: lang="en" + EN marker)
//   <field>_en  the English original of every field (for things keyed on English, e.g. a session's colour)
// The row's *_fr columns are left as they were.
function localize(kind, row, lang) {
  const spec = SPECS[kind];
  const wantFr = lang === "fr";
  const useFr = wantFr && frenchState(kind, row) === "ready";
  const out = { ...row, frLang: useFr ? "fr" : "en", fallback: wantFr && !useFr && spec.fields.some((f) => filled(spec, f, row[f])) };
  for (const f of spec.fields) {
    out[`${f}_en`] = row[f];
    if (useFr && filled(spec, f, row[`${f}_fr`])) {
      out[f] = spec.html.includes(f) ? sanitizeHtml(String(row[`${f}_fr`])) : String(row[`${f}_fr`]).trim();
    }
  }
  return out;
}
const localizeAll = (kind, rows, lang) => rows.map((r) => localize(kind, r, lang));

// The French columns of a kind as typed in an admin form: trimmed, "" -> null, HTML sanitised (an editor with only
// empty paragraphs -> null). `body` is a request body (or any object with title_fr, ...).
function readFrench(kind, body) {
  const spec = SPECS[kind];
  const out = {};
  for (const f of spec.fields) {
    const raw = body[`${f}_fr`];
    const one = String(Array.isArray(raw) ? raw[0] : raw == null ? "" : raw);
    if (spec.html.includes(f)) {
      const clean = sanitizeHtml(one.trim());
      out[`${f}_fr`] = hasText(clean) ? clean : null;
    } else {
      out[`${f}_fr`] = one.trim() || null;
    }
  }
  return out;
}

// What the admin screens say about a row's French.
const FRENCH_LABELS = { missing: "missing", draft: "draft", ready: "ready" };
const FRENCH_PILL = { ready: "published", draft: "scheduled", missing: "draft" }; // the status pills: green, amber, grey
const FRENCH_HELP = {
  ready: "The French pages show this French version.",
  draft: "Not complete yet, so French visitors still see the English text (marked as English).",
  missing: "No French version yet, so French visitors see the English text (marked as English). That is fine: the French is optional.",
};

module.exports = { SPECS, safeHtml: sanitizeHtml, hasText, frenchState, localize, localizeAll, readFrench, FRENCH_LABELS, FRENCH_PILL, FRENCH_HELP };
