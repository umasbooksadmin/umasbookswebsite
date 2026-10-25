// "Translate to French" in the admin editors of events, sessions, announcements and charities (the blog has its own,
// lib/blogTranslate.js, with the same rules). One AI call per press (lib/anthropic.js askText: the shared daily cap
// AI_DAILY_MAX_CALLS, usage counts, friendly failure). The answer is only handed back to the form to be read and
// changed: nothing is saved here, and a French text appears on the site only once the admin has pressed Save and it
// is complete (lib/frenchText.js frenchState).
//
// Only the parts that need it are sent: a French field that already has text is kept unless `overwrite` is true. An
// HTML text (an announcement's content) is told to keep every tag, and the answer goes through the same sanitize-html
// allowlist as any such text (lib/sanitizeHtml.js) before it is returned.

const anthropic = require("./anthropic");
const { clampText } = require("./aiLimits");
const { explainFailure } = require("./collectionSuggestions");
const { sanitizeHtml } = require("./sanitizeHtml");
const { SPECS, hasText } = require("./frenchText");

const MAX_TEXT = 4000; // characters of a plain field
const MAX_HTML = 20000; // characters of an HTML field; a longer one is translated in two goes by the admin

const KINDS = {
  event: { what: "an event of a community English-language bookshop (title, description and place)", label: "event" },
  session: { what: "an English-immersion session for children, teens or adults at a bookshop (its title)", label: "session" },
  announcement: { what: "an announcement to the members of a community English-language bookshop", label: "announcement" },
  charity: { what: "a charity the bookshop's members vote on (a short description)", label: "charity" },
  round: { what: "the question of a charity vote at a bookshop", label: "charity vote" },
};
const SOURCE = { title: "title", description: "description", location: "place", excerpt: "summary", body: "content" };
const marker = (field) => `===${field.toUpperCase()}===`;

function buildPrompt(kind, parts) {
  const wanted = Object.keys(parts);
  const sections = wanted.map((f) => `${marker(f)}\n${parts[f]}`).join("\n");
  const htmlNote = wanted.some((f) => SPECS[kind].html.includes(f))
    ? ` The ${wanted.filter((f) => SPECS[kind].html.includes(f)).map((f) => marker(f).replace(/=/g, "")).join(", ")} part is HTML: keep every HTML tag and attribute exactly as it is and translate only the words between the tags.`
    : "";
  return `Translate this text for ${KINDS[kind].what} in Albi, France ("Uma's Books and Adventures") from English to French. Keep the same tone, voice and length; use natural, elegant French. Do not translate the shop's name, people's names, or any web address; keep a street address or the name of a place as it is.${htmlNote}

Reply with ONLY the translation, in exactly this format, with these marker lines (${wanted.map(marker).join(", ")}) and nothing before or after them, no quotes, no comments:

${wanted.map((f) => `${marker(f)}\n(the French ${SOURCE[f]})`).join("\n")}

Here is the English:

${sections}`;
}

// The text after each marker, up to the next marker.
function parseAnswer(text, wanted) {
  const found = {};
  const order = wanted.map((f) => ({ f, at: text.indexOf(marker(f)) })).filter((x) => x.at !== -1).sort((a, b) => a.at - b.at);
  order.forEach((x, i) => {
    const start = x.at + marker(x.f).length;
    const end = i + 1 < order.length ? order[i + 1].at : text.length;
    found[x.f] = text.slice(start, end).trim();
  });
  return found;
}

const unquote = (s) => s.replace(/^["«“]\s*|\s*["»”]$/g, "").trim();
const stripFence = (s) => s.replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/, "").trim();

// current: the English fields and the French ones as typed in the form ({ title, description, title_fr, ... }; an HTML
// field is HTML). -> { ok: true, values: { title_fr, ... }, filled: ["title_fr", ..], partial } | { ok: false, status, error }.
async function translateFields(kind, current, { overwrite = false, ask = (...args) => anthropic.askText(...args) } = {}) {
  const spec = SPECS[kind];
  if (!spec) throw new Error(`unknown kind ${kind}`);
  const isHtml = (f) => spec.html.includes(f);
  const have = {};
  const english = {};
  for (const f of spec.fields) {
    const fr = String(current[`${f}_fr`] || "");
    have[f] = isHtml(f) ? (hasText(fr) ? sanitizeHtml(fr.trim()) : "") : fr.trim();
    const en = String(current[f] || "");
    english[f] = isHtml(f) ? (hasText(en) ? sanitizeHtml(en.trim()) : "") : clampText(en, MAX_TEXT);
  }
  const tooLong = spec.fields.find((f) => isHtml(f) && english[f].length > MAX_HTML);
  if (tooLong) {
    return { ok: false, status: 400, error: `This ${KINDS[kind].label} is too long to translate in one go (over ${MAX_HTML.toLocaleString("en-GB")} characters). Translate it in two parts, or write the French by hand. Nothing was changed.` };
  }
  const parts = {};
  for (const f of spec.fields) if (english[f] && (overwrite || !have[f])) parts[f] = english[f];
  const wanted = Object.keys(parts);
  if (!wanted.length) {
    return { ok: false, status: 400, error: Object.values(english).some(Boolean)
      ? "Nothing to translate: the French fields are already filled in. Clear a field to have it translated again."
      : `Write the English text first, then translate.` };
  }

  const res = await ask(buildPrompt(kind, parts), { maxTokens: 4000, timeoutMs: 60000, label: `AI translation (${KINDS[kind].label})`, feature: "translation" });
  if (!res.text) return { ok: false, status: res.reason === "cap" ? 429 : 502, error: explainFailure(res.reason, res.message).replace("no suggestions could be made", "the text could not be translated") };

  const answer = parseAnswer(res.text, wanted);
  const values = {};
  for (const f of spec.fields) values[`${f}_fr`] = have[f];
  const done = [];
  for (const f of wanted) {
    let v = answer[f];
    if (!v) continue;
    v = isHtml(f) ? sanitizeHtml(stripFence(v)) : unquote(v);
    if (isHtml(f) ? !hasText(v) : !v) continue;
    values[`${f}_fr`] = v;
    done.push(`${f}_fr`);
  }
  if (!done.length) return { ok: false, status: 502, error: "The AI helper did not give a usable answer. Try again in a moment. Nothing was changed." };
  return { ok: true, values, filled: done, partial: done.length < wanted.length };
}

module.exports = { translateFields, buildPrompt, parseAnswer, KINDS, MAX_HTML };
