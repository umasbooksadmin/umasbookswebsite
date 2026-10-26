// sortTitleKey / compareTitles (src/lib/titleSort.js): alphabetical order
// ignores a leading "The" and nothing else.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { sortTitleKey, compareTitles } = require("../../src/lib/titleSort");

test("a leading The is ignored, in any capitals and with extra spaces", () => {
  assert.equal(sortTitleKey("The Hobbit"), "hobbit");
  assert.equal(sortTitleKey("THE END"), "end");
  assert.equal(sortTitleKey("the hobbit"), "hobbit");
  assert.equal(sortTitleKey("The  Great Gatsby"), "great gatsby");
  assert.equal(sortTitleKey("The\tGreat Gatsby"), "great gatsby");
});

test("only a whole first word The counts", () => {
  for (const t of ["Theory of Everything", "Theodore Rex", "Thelma and Louise", "Then We Came to the End", "Their Eyes", "Other, The"]) {
    assert.equal(sortTitleKey(t), t.toLowerCase());
  }
});

test("leading spaces, quotes and brackets are ignored, then The", () => {
  assert.equal(sortTitleKey("  The Road"), "road");
  assert.equal(sortTitleKey("“The Road”"), "road”");
  assert.equal(sortTitleKey('"The Road"'), 'road"');
  assert.equal(sortTitleKey("(The) Cat"), "cat");
  assert.equal(sortTitleKey("The “Quoted” One"), "quoted” one");
  assert.equal(sortTitleKey("'Salem's Lot"), "salem's lot");
});

test("a title that is only The (or has nothing to sort on) keeps its own text", () => {
  assert.equal(sortTitleKey("The"), "the");
  assert.equal(sortTitleKey("the "), "the ");
  assert.equal(sortTitleKey("The ???"), "the ???");
  assert.equal(sortTitleKey("..."), "...");
  assert.equal(sortTitleKey(""), "");
  assert.equal(sortTitleKey(null), "");
});

test("A and An are ignored like The, only as a whole first word; the French articles are not", () => {
  assert.equal(sortTitleKey("A Tale of Two Cities"), "tale of two cities");
  assert.equal(sortTitleKey("a midsummer night's dream"), "midsummer night's dream");
  assert.equal(sortTitleKey("An Instance"), "instance");
  assert.equal(sortTitleKey("AN  Introduction"), "introduction");
  assert.equal(sortTitleKey("A"), "a");
  assert.equal(sortTitleKey("An"), "an");
  assert.equal(sortTitleKey("A. J. Ayer"), "a. j. ayer");
  assert.equal(sortTitleKey("Anne of Green Gables"), "anne of green gables");
  assert.equal(sortTitleKey("Another Country"), "another country");
  assert.equal(sortTitleKey("Theory of Everything"), "theory of everything");
  assert.equal(sortTitleKey("Le Petit Prince"), "le petit prince");
  assert.equal(sortTitleKey("L’Étranger"), "l’étranger");
});

test("titles and digits keep their text; the shown title is untouched", () => {
  assert.equal(sortTitleKey("The 39 Steps"), "39 steps");
  assert.equal(sortTitleKey("1984"), "1984");
  const t = "The Hobbit";
  sortTitleKey(t);
  assert.equal(t, "The Hobbit");
});

test("The Hobbit sorts between Hamlet and Hunger Games; ties break on the full title, then id", () => {
  const sorted = ["Hunger Games", "The Hobbit", "Hamlet"].sort(compareTitles);
  assert.deepEqual(sorted, ["Hamlet", "The Hobbit", "Hunger Games"]);
  const rows = [
    { id: 3, title: "The Road" }, { id: 2, title: "Road" }, { id: 1, title: "The Road" }, { id: 4, title: "Roads" },
  ];
  assert.deepEqual(rows.sort(compareTitles).map((r) => r.id), [2, 1, 3, 4]);
});
