// Generates a short, back-cover-style description for a book that has
// none (Open Library often lacks one), and can translate an existing
// description to French (see translateDescriptionToFrench). Both fail
// open (return null) on any error or missing config, so a book can
// still be saved without one rather than blocking the save.

const { askText } = require("./anthropic");
const { clampText, MAX_TITLE, MAX_AUTHOR, MAX_DESCRIPTION } = require("./aiLimits");
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
Only describe the book itself — no marketing fluff about the shop, no mention that it's second-hand. If you do not recognize this exact book, or are not sure what it is about, answer with exactly NONE and nothing else: never guess or invent a description from the title alone. Respond with ONLY the description text, no preamble, no quotes around it.`;

  return usableDescription((await callClaude(prompt, { maxTokens: 200, label: "AI description" })).text);
}

// Sharon: when a description cannot be generated, write nothing. The prompt tells the model to answer NONE for a book it
// does not know; this also drops a refusal or an apology that came back instead of a description. null = no description.
const NOT_A_DESCRIPTION = /^(none|n\/a|unknown)\b[.!]*$|^(i\s+(do\s*n[o']t|don[’']t|can[’']?not|can[’']t|couldn[’']t|could\s+not|am\s+not|[’']m\s+not|am\s+unable)|i[’']m\s+(not|unable|sorry)|sorry|unfortunately|there\s+is\s+no|no\s+(information|description)|as\s+an\s+ai)\b/i;
function usableDescription(text) {
  if (typeof text !== "string") return null;
  const t = text.trim().replace(/^["“”']+|["“”']+$/g, "").trim();
  if (!t || NOT_A_DESCRIPTION.test(t)) return null;
  return text;
}

// Translates an existing (English) description to French — used both
// right after generateBookDescription produces one, and by the backfill
// script for older books that already have an English description but
// no French one.
async function translateDescriptionToFrench(englishText) {
  return (await translateDescriptionToFrenchWhy(englishText)).text;
}

// Same, but says why when there is no translation: { text, reason, message }. reason is null (worked), "empty" (nothing to
// translate: no call was made), or askText's "no_key", "cap" (+ message), "credit", "rate", "timeout", "error". The book
// form's "Update the French from the English" button uses it to tell the admin what happened.
async function translateDescriptionToFrenchWhy(englishText) {
  if (!englishText) return { text: null, reason: "empty" };

  const prompt = `Translate this English bookshop back-cover description to French. Keep the same tone and length. Respond with ONLY the French translation, no preamble, no quotes around it.

"${clampText(englishText, MAX_DESCRIPTION)}"`;

  return callClaude(prompt, { maxTokens: 250, label: "AI description (French)", feature: "translation" });
}

module.exports = { generateBookDescription, usableDescription, translateDescriptionToFrench, translateDescriptionToFrenchWhy };
