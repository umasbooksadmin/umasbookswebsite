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
Only describe the book itself — no marketing fluff about the shop, no mention that it's second-hand. If you do not recognize this exact book, or are not sure what it is about, answer with exactly NONE and nothing else: never guess or invent a description from the title alone. Respond with ONLY the description text, no preamble, no quotes around it.`;

  return usableDescription((await callClaude(prompt, { maxTokens: 200, label: "AI description" })).text, title);
}

// Sharon: when a description cannot be generated, write nothing. The prompt tells the model to answer NONE for a book it
// does not know; this also drops a refusal or an apology that came back instead of a description. null = no description.
// A text that starts with the book's own title is a description (I Am Not a Serial Killer), whatever its first words.
const NO_DESCRIPTION = ["none", "n/a", "unknown"];
const REFUSAL_STARTS = ["i do not", "i dont", "i cannot", "i cant", "i could not", "i couldnt", "i am not", "im not", "i am unable",
  "im unable", "i am sorry", "im sorry", "unfortunately", "there is no", "no information", "no description", "as an ai"];
const QUOTES = ["\u0027", "\u2018", "\u2019", "\u201c", "\u201d"];
const plain = (x) => QUOTES.reduce((acc, q) => acc.split(q).join(""), String(x).toLowerCase()).replace(/[^a-z0-9/ ]+/g, " ").replace(/ +/g, " ").trim();
function usableDescription(text, title) {
  if (typeof text !== "string") return null;
  const t = plain(text);
  if (!t || NO_DESCRIPTION.includes(t)) return null;
  if (/^sorry[,.!]/i.test(text.trim())) return null;
  const own = title ? plain(title) : "";
  if (own && (t + " ").startsWith(own + " ")) return text;
  const padded = t + " ";
  return REFUSAL_STARTS.some((p) => padded.startsWith(p + " ")) ? null : text;
}

module.exports = { generateBookDescription, usableDescription };
