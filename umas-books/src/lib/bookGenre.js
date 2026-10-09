// Assigns genre(s) to a book with AI, for titles that never went through
// the ISBN-lookup genre matching in bookLookup.js (e.g. inventory added
// before that existed, or where the lookup found no genre). Same
// fail-open contract as bookDescription.js: returns null on any error or
// missing config rather than throwing, and never invents a genre outside
// the site's own taxonomy.

const { COMMON_GENRES } = require("./bookLookup");
const { normalizeGenres } = require("./inventory");

const { recordCall } = require("./aiUsageStats");
const { getAiLimits, clampText, MAX_TITLE, MAX_AUTHOR, MAX_DESCRIPTION } = require("./aiLimits");

const TEXT_MODEL = "claude-haiku-4-5-20251001";

async function generateBookGenres(input) {
  // Bounded text only goes to the paid API.
  const title = clampText(input.title, MAX_TITLE);
  const author = clampText(input.author, MAX_AUTHOR);
  const description = clampText(input.description, MAX_DESCRIPTION);
  const existingGenres = clampText(input.existingGenres, 300);
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
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

  const slot = await getAiLimits().acquireAiCall(); // the shared daily cap (lib/aiLimits.js)
  if (!slot.ok) {
    console.warn(`AI genre skipped: ${slot.message}`);
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

  const t0 = Date.now();
  let recorded = false; // usage statistics (counts only), see lib/aiUsageStats.js
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        ...(process.env.ANTHROPIC_WORKSPACE_ID ? { "anthropic-workspace-id": process.env.ANTHROPIC_WORKSPACE_ID } : {}),
      },
      body: JSON.stringify({
        model: TEXT_MODEL,
        max_tokens: 60,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      recorded = true;
      recordCall("genre", { status: res.status, bodyText: body, ms: Date.now() - t0 });
      console.warn("AI genre request failed:", res.status, body);
      return null;
    }

    const data = await res.json();
    recorded = true;
    recordCall("genre", { status: res.status, data, ms: Date.now() - t0 });
    const text = data.content && data.content[0] && data.content[0].text;
    if (!text) {
      console.warn("AI genre skipped: unexpected response shape:", JSON.stringify(data).slice(0, 500));
      return null;
    }

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
    if (!recorded) recordCall("genre", { failed: true, ms: Date.now() - t0 });
    console.warn("AI genre skipped:", err.name === "AbortError" ? "request timed out" : err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { generateBookGenres };
