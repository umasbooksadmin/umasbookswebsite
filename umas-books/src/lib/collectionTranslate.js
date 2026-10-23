// "Translate to French" on the admin collection page: fills the EMPTY French title / description from the English ones
// with the same AI client as the book translations (shared daily cap, usage counts, friendly failure). The result is
// only put in the form: the admin reads it and presses Save, nothing is stored here.

const { askText } = require("./anthropic");
const { clampText, MAX_DESCRIPTION } = require("./aiLimits");
const { explainFailure } = require("./collectionSuggestions");

async function translateShort(english, kind, ask) {
  const src = clampText(english, MAX_DESCRIPTION);
  if (!src) return { text: null, reason: "empty" };
  const what = kind === "title" ? "a title for a themed shelf of books" : "a short blurb for a themed shelf of books";
  const prompt = `Translate ${what} on an English-language bookshop's website from English to French. Keep the same tone, voice and length; use natural, elegant French. Do not translate the shop's name. Respond with ONLY the French translation, no preamble, no quotes around it.

"${src}"`;
  return ask(prompt, { maxTokens: kind === "title" ? 80 : 300, label: "AI translation (collection)", feature: "translation" });
}

// current: { title_en, description_en, title_fr, description_fr } as typed in the form.
// -> { ok: true, title_fr, description_fr, filled: [..] } | { ok: false, error }. Fields that already have French are kept.
async function translateEmptyFrench(current, { ask = askText } = {}) {
  const out = { title_fr: String(current.title_fr || ""), description_fr: String(current.description_fr || "") };
  const filled = [];
  for (const [field, srcField, kind] of [["title_fr", "title_en", "title"], ["description_fr", "description_en", "text"]]) {
    if (out[field].trim()) continue;
    const res = await translateShort(current[srcField], kind, ask);
    if (!res.text) {
      if (res.reason === "empty") continue;
      return { ok: false, error: explainFailure(res.reason, res.message) };
    }
    out[field] = res.text.replace(/^["«“]\s*|\s*["»”]$/g, "").trim();
    filled.push(field);
  }
  return { ok: true, ...out, filled };
}

module.exports = { translateEmptyFrench };
