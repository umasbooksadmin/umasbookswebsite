// Generates a short, back-cover-style description for a book that has
// none (Open Library often lacks one), and can translate an existing
// description to French (see translateDescriptionToFrench). Both fail
// open (return null) on any error or missing config, so a book can
// still be saved without one rather than blocking the save.

const { recordCall } = require("./aiUsageStats");
const { getAiLimits, clampText, MAX_TITLE, MAX_AUTHOR, MAX_DESCRIPTION } = require("./aiLimits");
const { createInflight } = require("./inflight");

// Two identical requests running at the same time (a double click, two screens) share one API call.
const inflight = createInflight();

const TEXT_MODEL = "claude-haiku-4-5-20251001";

function callClaude(prompt, opts) {
  return inflight.run(`${opts.feature || "description"}|${opts.maxTokens || 200}|${prompt}`, () => callClaudeOnce(prompt, opts));
}

async function callClaudeOnce(prompt, { maxTokens = 200, label, feature = "description" }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn(`${label} skipped: ANTHROPIC_API_KEY not set.`);
    return null;
  }
  // The shared daily cap (lib/aiLimits.js): at the cap the call is skipped, like any other AI problem.
  const slot = await getAiLimits().acquireAiCall();
  if (!slot.ok) {
    console.warn(`${label} skipped: ${slot.message}`);
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
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      recorded = true;
      recordCall(feature, { status: res.status, bodyText: body, ms: Date.now() - t0 });
      console.warn(`${label} request failed:`, res.status, body);
      return null;
    }

    const data = await res.json();
    recorded = true;
    recordCall(feature, { status: res.status, data, ms: Date.now() - t0 });
    const text = data.content && data.content[0] && data.content[0].text;
    if (!text) {
      console.warn(`${label} skipped: unexpected response shape:`, JSON.stringify(data).slice(0, 500));
      return null;
    }
    return text.trim();
  } catch (err) {
    if (!recorded) recordCall(feature, { failed: true, ms: Date.now() - t0 });
    console.warn(`${label} skipped:`, err.name === "AbortError" ? "request timed out" : err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function generateBookDescription(input) {
  const { publishedYear } = input;
  // Only a bounded amount of text goes to the paid API (a title in a request can be 100 KB long).
  const title = clampText(input.title, MAX_TITLE);
  const author = clampText(input.author, MAX_AUTHOR);
  const publisher = clampText(input.publisher, MAX_AUTHOR);
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

"${clampText(englishText, MAX_DESCRIPTION)}"`;

  return callClaude(prompt, { maxTokens: 250, label: "AI description (French)", feature: "translation" });
}

module.exports = { generateBookDescription, translateDescriptionToFrench, TEXT_MODEL };
