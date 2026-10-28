// Generates a short, back-cover-style description for a book that has
// none (Open Library often lacks one). It fails open (returns null) on
// any error or missing config, so a book can still be saved without one
// rather than blocking the save. Books have no French description
// (Sharon, 2026-10-28): the French site shows this English text.

const { askText } = require("./anthropic");
const { clampText, MAX_TITLE, MAX_AUTHOR } = require("./aiLimits");
const { createInflight } = require("./inflight");

// Two identical requests running at the same time (a double click, two screens) share one API call.
const inflight = createInflight();

function callClaude(prompt, opts) {
  return inflight.run(`${opts.feature || "description"}|${opts.maxTokens || 200}|${prompt}`, () => callClaudeOnce(prompt, opts));
}

// { text, reason } as askText answers (reason null when it worked); the callers below keep only what they need.
async function callClaudeOnce(prompt, opts) {
  return askText(prompt, opts);
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

  return (await callClaude(prompt, { maxTokens: 200, label: "AI description" })).text;
}

module.exports = { generateBookDescription };
