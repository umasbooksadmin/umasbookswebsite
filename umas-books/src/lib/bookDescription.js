// Generates a short, back-cover-style description for a book that has
// none (Open Library often lacks one), and can translate an existing
// description to French (see translateDescriptionToFrench). Both fail
// open (return null) on any error or missing config, so a book can
// still be saved without one rather than blocking the save.

const TEXT_MODEL = "claude-haiku-4-5-20251001";

async function callClaude(prompt, { maxTokens = 200, label }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn(`${label} skipped: ANTHROPIC_API_KEY not set.`);
    return null;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);

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
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      console.warn(`${label} request failed:`, res.status, await res.text().catch(() => ""));
      return null;
    }

    const data = await res.json();
    const text = data.content && data.content[0] && data.content[0].text;
    if (!text) {
      console.warn(`${label} skipped: unexpected response shape:`, JSON.stringify(data).slice(0, 500));
      return null;
    }
    return text.trim();
  } catch (err) {
    console.warn(`${label} skipped:`, err.name === "AbortError" ? "request timed out" : err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function generateBookDescription({ title, author, publisher, publishedYear }) {
  if (!title) {
    console.warn("AI description skipped: no title provided.");
    return null;
  }

  const details = [
    author ? `by ${author}` : null,
    publisher ? `published by ${publisher}` : null,
    publishedYear ? `(${publishedYear})` : null,
  ].filter(Boolean).join(" ");

  const prompt = `Write a short, appealing back-cover-style description (2-3 sentences, no more than 60 words) for this second-hand book, for a bookshop's website:
Title: "${title}" ${details}
Only describe the book itself — no marketing fluff about the shop, no mention that it's second-hand. If you don't recognize the book, write a brief generic description based only on the title. Respond with ONLY the description text, no preamble, no quotes around it.`;

  return callClaude(prompt, { maxTokens: 200, label: "AI description" });
}

// Translates an existing (English) description to French — used both
// right after generateBookDescription produces one, and by the backfill
// script for older books that already have an English description but
// no French one.
async function translateDescriptionToFrench(englishText) {
  if (!englishText) return null;

  const prompt = `Translate this English bookshop back-cover description to French. Keep the same tone and length. Respond with ONLY the French translation, no preamble, no quotes around it.

"${englishText}"`;

  return callClaude(prompt, { maxTokens: 250, label: "AI description (French)" });
}

module.exports = { generateBookDescription, translateDescriptionToFrench, TEXT_MODEL };
