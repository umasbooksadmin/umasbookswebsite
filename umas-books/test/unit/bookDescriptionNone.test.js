// Sharon (2026-10-28): "if a description is not able to be generated through AI, don't write anything".
// The model is told to answer NONE for a book it does not know (never a generic text from the title); a NONE, a refusal or
// an apology that comes back is dropped, so the book simply has no description (press Generate later).
const test = require("node:test");
const assert = require("node:assert/strict");
const { usableDescription } = require("../../src/lib/bookDescription");

test("a real description is kept exactly as written", () => {
  const d = "A quiet, funny story about a lighthouse keeper who talks to the gulls.";
  assert.equal(usableDescription(d), d);
  assert.equal(usableDescription("Nobody in town knows who left the letter. Unfortunately for Anna, everyone has a theory."), "Nobody in town knows who left the letter. Unfortunately for Anna, everyone has a theory.");
  assert.equal(usableDescription("None of the villagers expected the stranger to stay."), "None of the villagers expected the stranger to stay.");
  assert.equal(usableDescription("I Capture the Castle is a coming-of-age novel."), "I Capture the Castle is a coming-of-age novel.");
  // a description that starts with the book's own title is a description, whatever its first words
  assert.equal(usableDescription("I Am Not a Serial Killer is a dark teen thriller.", "I Am Not a Serial Killer"), "I Am Not a Serial Killer is a dark teen thriller.");
  assert.equal(usableDescription("Sorry Not Sorry follows two sisters.", "Sorry Not Sorry"), "Sorry Not Sorry follows two sisters.");
});

test("NONE, a refusal or an apology means no description at all", () => {
  for (const bad of ["NONE", "none", " None. ", '"NONE"', "N/A", "Unknown",
    "I don't recognize this book, so I can't write a description.", "I dont recognize this book.", "I don\u2019t recognize this book.", "I can\u2019t describe it.", "I do not have information about this title.",
    "I'm not familiar with this book.", "I\u2019m not familiar with this book.", "I cannot write a description for a book I don't know.", "Sorry, I don't know this book.",
    "Unfortunately I have no details about it.", "There is no information about this title.", "As an AI I can't say.", "", "   ", null, undefined, 42]) {
    assert.equal(usableDescription(bad), null, JSON.stringify(bad));
  }
});

// Through generateBookDescription itself, with the Anthropic client replaced by what the model answered.
const anthropic = require("../../src/lib/anthropic");
const real = anthropic.askText;
async function describeWhenModelSays(text) {
  const key = require.resolve("../../src/lib/bookDescription");
  anthropic.askText = async () => ({ text, reason: null });
  delete require.cache[key];
  try { return await require(key).generateBookDescription({ title: `Unknown ${Math.random()}`, author: "A. Nobody" }); }
  finally { anthropic.askText = real; delete require.cache[key]; }
}
test("generateBookDescription: a book the model does not know gets no description; a known one keeps it", async () => {
  assert.equal(await describeWhenModelSays("NONE"), null);
  assert.equal(await describeWhenModelSays("I'm not familiar with this book, so I can't describe it."), null);
  assert.equal(await describeWhenModelSays("A lighthouse keeper learns to talk to the gulls."), "A lighthouse keeper learns to talk to the gulls.");
});
test("the prompt tells the model to answer NONE instead of inventing a generic text", async () => {
  let prompt = "";
  const key = require.resolve("../../src/lib/bookDescription");
  anthropic.askText = async (p) => { prompt = p; return { text: "x", reason: null }; };
  delete require.cache[key];
  try { await require(key).generateBookDescription({ title: `Prompt check ${Math.random()}` }); } finally { anthropic.askText = real; delete require.cache[key]; }
  assert.match(prompt, /answer with exactly NONE/);
  assert.doesNotMatch(prompt, /generic description/);
});
