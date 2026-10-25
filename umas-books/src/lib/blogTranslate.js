// "Translate to French" on the admin blog editor: turns the English title, excerpt and body into French with the same
// AI client as the book and collection translations (lib/anthropic.js askText: one call of the shared daily cap
// AI_DAILY_MAX_CALLS, usage counts, friendly failure). The result is only handed back to the editor to be read and
// changed: nothing is saved here, and a translation is never published by itself (a post's French text is shown on the
// site only once the admin has pressed Save, and only when it is complete: lib/blogPosts.js frenchState).
//
// Only the parts that need it are sent: a French field that already has text is kept unless `overwrite` is true. The
// body is HTML from the rich-text editor; the model is told to keep every tag, and its answer is run through the same
// sanitize-html allowlist as any body (lib/sanitizeHtml.js) before it is returned.

const anthropic = require("./anthropic");
const { clampText } = require("./aiLimits");
const { explainFailure } = require("./collectionSuggestions");
const { sanitizeHtml } = require("./sanitizeHtml");
const { hasText } = require("./blogPosts");

const MAX_TITLE = 300;
const MAX_EXCERPT = 2000;
const MAX_BODY = 20000; // characters of HTML; a longer post is translated in two goes by the admin
const MARKERS = { title_fr: "===TITLE===", excerpt_fr: "===EXCERPT===", body_fr: "===BODY===" };
const SOURCE = { title_fr: "title", excerpt_fr: "excerpt", body_fr: "body" };

function buildPrompt(parts) {
  const wanted = Object.keys(parts);
  const sections = wanted.map((f) => `${MARKERS[f]}\n${parts[f]}`).join("\n");
  return `Translate this blog post for a community English-language bookshop in Albi, France ("Uma's Books and Adventures") from English to French. Keep the same tone, voice and length; use natural, elegant French. Do not translate the shop's name or any web address. The BODY is HTML: keep every HTML tag and attribute exactly as it is and translate only the words between the tags.

Reply with ONLY the translation, in exactly this format, with these marker lines (${wanted.map((f) => MARKERS[f]).join(", ")}) and nothing before or after them, no quotes, no comments:

${wanted.map((f) => `${MARKERS[f]}\n(the French ${SOURCE[f]})`).join("\n")}

Here is the English:

${sections}`;
}

// The text after each marker, up to the next marker.
function parseAnswer(text, wanted) {
  const found = {};
  const order = wanted.map((f) => ({ f, at: text.indexOf(MARKERS[f]) })).filter((x) => x.at !== -1).sort((a, b) => a.at - b.at);
  order.forEach((x, i) => {
    const start = x.at + MARKERS[x.f].length;
    const end = i + 1 < order.length ? order[i + 1].at : text.length;
    found[x.f] = text.slice(start, end).trim();
  });
  return found;
}

const unquote = (s) => s.replace(/^["«“]\s*|\s*["»”]$/g, "").trim();
const stripFence = (s) => s.replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/, "").trim();

// current: { title, excerpt, body, title_fr, excerpt_fr, body_fr } as typed in the form (the English body and the French
// body are HTML). -> { ok: true, title_fr, excerpt_fr, body_fr, filled: [..] } | { ok: false, status, error }.
async function translatePost(current, { overwrite = false, ask = (...args) => anthropic.askText(...args) } = {}) {
  const have = {
    title_fr: String(current.title_fr || "").trim(),
    excerpt_fr: String(current.excerpt_fr || "").trim(),
    body_fr: hasText(current.body_fr) ? sanitizeHtml(String(current.body_fr).trim()) : "",
  };
  const english = {
    title_fr: clampText(current.title, MAX_TITLE),
    excerpt_fr: clampText(current.excerpt, MAX_EXCERPT),
    body_fr: hasText(current.body) ? String(current.body).trim() : "",
  };
  if (english.body_fr.length > MAX_BODY) {
    return { ok: false, status: 400, error: `This post is too long to translate in one go (over ${MAX_BODY.toLocaleString("en-GB")} characters). Translate it in two parts, or write the French by hand. Nothing was changed.` };
  }
  const parts = {};
  for (const f of Object.keys(MARKERS)) if (english[f] && (overwrite || !have[f])) parts[f] = english[f];
  const wanted = Object.keys(parts);
  if (!wanted.length) {
    return { ok: false, status: 400, error: Object.values(english).some(Boolean)
      ? "Nothing to translate: the French title, excerpt and content are already filled in. Clear a field to have it translated again."
      : "Write the English title and content first, then translate." };
  }

  const res = await ask(buildPrompt(parts), { maxTokens: 8000, timeoutMs: 60000, label: "AI translation (blog post)", feature: "translation" });
  if (!res.text) return { ok: false, status: res.reason === "cap" ? 429 : 502, error: explainFailure(res.reason, res.message).replace("no suggestions could be made", "the post could not be translated") };

  const answer = parseAnswer(res.text, wanted);
  const out = { ...have };
  const filled = [];
  for (const f of wanted) {
    let v = answer[f];
    if (!v) continue;
    if (f === "body_fr") v = sanitizeHtml(stripFence(v));
    else v = unquote(v);
    if (f === "body_fr" ? !hasText(v) : !v) continue;
    out[f] = v;
    filled.push(f);
  }
  if (!filled.length) return { ok: false, status: 502, error: "The AI helper did not give a usable answer. Try again in a moment. Nothing was changed." };
  return { ok: true, ...out, filled, partial: filled.length < wanted.length };
}

module.exports = { translatePost, buildPrompt, parseAnswer, MAX_BODY };
