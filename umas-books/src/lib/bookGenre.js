// Assigns genre(s) to a book with AI, for titles that never went through
// the ISBN-lookup genre matching in bookLookup.js (e.g. inventory added
// before that existed, or where the lookup found no genre). Same
// fail-open contract as bookDescription.js: returns null on any error or
// missing config rather than throwing, and never invents a genre outside
// the site's own taxonomy.

const { COMMON_GENRES } = require("./bookLookup");
const { normalizeGenres } = require("./inventory");

const anthropic = require("./anthropic");
const { clampText, MAX_TITLE, MAX_AUTHOR, MAX_DESCRIPTION } = require("./aiLimits");

async function generateBookGenres(input) {
  // Bounded text only goes to the paid API.
  const title = clampText(input.title, MAX_TITLE);
  const author = clampText(input.author, MAX_AUTHOR);
  const description = clampText(input.description, MAX_DESCRIPTION);
  const existingGenres = clampText(input.existingGenres, 300);
  if (!anthropic.hasApiKey()) {
    console.warn("AI genre skipped: ANTHROPIC_API_KEY not set.");
    return null;
  }
  if (!title) {
    console.warn("AI genre skipped: no title provided.");
    return null;
  }

  const details = [
    author ? `by ${author}` : null,
    description ? `Description: ${description}` : null,
    existingGenres ? `Current genre tags on file (may be incomplete or wrong): ${existingGenres}` : null,
  ].filter(Boolean).join("\n");

  const prompt = `Assign 1-3 genres to this second-hand book for a bookshop's website, choosing ONLY from this exact list (use the exact spelling/casing shown):
${COMMON_GENRES.join(", ")}

Title: "${title}"${details ? `\n${details}` : ""}

Respond with ONLY a comma-separated list of the genres you chose from that list, most-relevant first (e.g. "Fantasy, Young Adult Fiction"). No preamble, no explanation, no genres outside the list. If you don't recognize the book and the title gives no clue, respond with "Fiction".`;

  const r = await anthropic.request({
    feature: "genre", model: anthropic.MODELS.text.id, maxTokens: 60, timeoutMs: 8000,
    messages: [{ role: "user", content: prompt }],
  });
  if (!r.ok) {
    if (r.kind === "cap") console.warn(`AI genre skipped: ${r.message}`);
    else if (r.status) console.warn("AI genre request failed:", r.status, r.body);
    else console.warn("AI genre skipped:", r.message);
    return null;
  }
  const text = anthropic.textOf(r.data);
  if (!text) {
    console.warn("AI genre skipped: unexpected response shape:", JSON.stringify(r.data).slice(0, 500));
    return null;
  }

  try {
    // Keep only genres that are actually in the taxonomy — a model can
    // still drift from instructions, and a stray invented tag would
    // otherwise leak into the site's genre filter chips. Map back to the
    // taxonomy's own casing too, in case the model didn't match it exactly.
    const byLower = new Map(COMMON_GENRES.map((g) => [g.toLowerCase(), g]));
    const picked = text.split(",")
      .map((g) => byLower.get(g.trim().toLowerCase()))
      .filter(Boolean);
    return normalizeGenres(picked.join(", "));
  } catch (err) {
    console.warn("AI genre skipped:", err.message);
    return null;
  }
}

module.exports = { generateBookGenres };
