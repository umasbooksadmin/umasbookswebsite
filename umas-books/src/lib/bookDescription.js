// Generates a short, back-cover-style description for a book that has
// none (Open Library often lacks one). Fails open (returns null) on any
// error or missing config, so a book can still be saved without one.

const TEXT_MODEL = "claude-haiku-4-5-20251001";

async function generateBookDescription({ title, author, publisher, publishedYear }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn("ANTHROPIC_API_KEY not set — AI description generation is disabled.");
    return null;
  }
  if (!title) return null;

  const details = [
    author ? `by ${author}` : null,
    publisher ? `published by ${publisher}` : null,
    publishedYear ? `(${publishedYear})` : null,
  ].filter(Boolean).join(" ");

  const prompt = `Write a short, appealing back-cover-style description (2-3 sentences, no more than 60 words) for this second-hand book, for a bookshop's website:
Title: "${title}" ${details}
Only describe the book itself — no marketing fluff about the shop, no mention that it's second-hand. If you don't recognize the book, write a brief generic description based only on the title. Respond with ONLY the description text, no preamble, no quotes around it.`;

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
      },
      body: JSON.stringify({
        model: TEXT_MODEL,
        max_tokens: 200,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      console.warn("AI description request failed:", res.status, await res.text().catch(() => ""));
      return null;
    }

    const data = await res.json();
    const text = data.content && data.content[0] && data.content[0].text;
    return text ? text.trim() : null;
  } catch (err) {
    console.warn("AI description generation skipped:", err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { generateBookDescription };
