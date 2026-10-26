// "Suggest slots with AI" (Admin > Genres): proposes a managed genre for the raw genres no rule handles yet. The admin
// reads the proposals and ticks the ones to keep; NOTHING is saved here and nothing is applied to a book.
//
// One call asks about at most BATCH_SIZE raw genres (the most used first), at most MAX_BATCHES calls per press, each one
// a slot of the shared daily AI cap (lib/anthropic.js askText, feature "genre"). The model must answer with JSON that maps
// each number to one of the managed genre NAMES it was given, or "none". The answer is validated: a name that is not
// in the list (an invented genre), an unknown number or text that is not JSON is dropped, never saved.

const { askText } = require("./anthropic");
const { explainFailure } = require("./collectionSuggestions");
const { genreKey } = require("./genreRules");

const BATCH_SIZE = 100;
const MAX_BATCHES = 3;

function buildPrompt(managedNames, items) {
  return `You help a second-hand English bookshop tidy the genre tags on its books. Each tag below is free text that came from catalogue lookups and hand typing. For each numbered tag choose the single best genre from the managed list, or "none" when no managed genre fits well.

Managed genres (use these exact names, nothing else):
${managedNames.map((n) => `- ${n}`).join("\n")}

Tags:
${items.map((g, i) => `${i + 1}. ${g.name}`).join("\n")}

Respond with ONLY a JSON object whose keys are the tag numbers (as strings) and whose values are a managed genre name exactly as written above, or "none". Example: {"1": "Fiction", "2": "none"}. No explanation, no genres outside the list.`;
}

// The first JSON object in a model answer ("```json ... ```" or prose around it are tolerated), or null.
function parseAnswer(text) {
  if (!text) return null;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const v = JSON.parse(text.slice(start, end + 1));
    return v && typeof v === "object" && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// unmapped: [{ name, books }] (most used first); managed: [{ id, name_en }].
// -> { ok: true, proposals: [{ name, books, targetId, targetName }], rejected, asked, notice? } | { ok: false, error }
async function suggestSlots(unmapped, managed, { ask = askText, batchSize = BATCH_SIZE, maxBatches = MAX_BATCHES } = {}) {
  if (!managed.length) return { ok: false, error: "There are no managed genres to choose from." };
  if (!unmapped.length) return { ok: true, proposals: [], rejected: 0, asked: 0, notice: "Every genre already has a slot." };
  const byName = new Map(managed.map((m) => [genreKey(m.name_en), m]));
  const names = managed.map((m) => m.name_en);
  const proposals = [];
  let rejected = 0;
  let asked = 0;
  let failure = null;
  const todo = unmapped.slice(0, batchSize * maxBatches);
  for (let from = 0; from < todo.length; from += batchSize) {
    const items = todo.slice(from, from + batchSize);
    const res = await ask(buildPrompt(names, items), { maxTokens: 2500, timeoutMs: 45000, label: "AI genre slots", feature: "genre" });
    if (!res || !res.text) { failure = explainFailure(res && res.reason, res && res.message); break; }
    asked += items.length;
    const answer = parseAnswer(res.text);
    if (!answer) { failure = "The AI answered in a form that could not be read. Nothing was proposed from that batch: try again."; break; }
    items.forEach((g, i) => {
      const value = answer[String(i + 1)];
      if (value == null || genreKey(value) === "none") return;
      const m = byName.get(genreKey(value));
      if (!m) { rejected += 1; return; } // not a managed genre: never proposed
      proposals.push({ name: g.name, books: g.books, targetId: m.id, targetName: m.name_en });
    });
  }
  if (failure && !proposals.length) return { ok: false, error: failure };
  return { ok: true, proposals, rejected, asked, notice: failure ? `Stopped early: ${failure} The proposals below are from the batches that worked.` : null };
}

module.exports = { suggestSlots, buildPrompt, parseAnswer, BATCH_SIZE, MAX_BATCHES };
