// Seller leftovers in catalogue answers (lib/lookupClean.js).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { cleanLookupTitle, cleanLookupAuthor, cleanLookupBook } = require("../../src/lib/lookupClean");
const { mergeBooks } = require("../../src/lib/bookLookup");

test("titles: format and date notes (and the junk word after them) are removed; real titles are untouched", () => {
  assert.equal(cleanLookupTitle("How Bear Lost His Tail  [Paperback] [Jan 01, 2012] NILL"), "How Bear Lost His Tail");
  assert.equal(cleanLookupTitle("Matilda [Hardcover]"), "Matilda");
  assert.equal(cleanLookupTitle("Dune [2005]"), "Dune");
  assert.equal(cleanLookupTitle("The Gruffalo [Board book] N/A"), "The Gruffalo");
  assert.equal(cleanLookupTitle("And Then There Were None"), "And Then There Were None", "a title ending in None is real");
  assert.equal(cleanLookupTitle("Poems [Illustrated]"), "Poems [Illustrated]", "only format and date notes go");
  assert.equal(cleanLookupTitle("[Paperback]"), "[Paperback]", "never an empty title");
  assert.equal(cleanLookupTitle(null), null);
});

test("authors: placeholders are dropped", () => {
  assert.equal(cleanLookupAuthor("NILL"), null);
  assert.equal(cleanLookupAuthor(" n/a "), null);
  assert.equal(cleanLookupAuthor("Jane Doe, NILL"), "Jane Doe");
  assert.equal(cleanLookupAuthor("Roald Dahl"), "Roald Dahl");
  assert.equal(cleanLookupAuthor("Anonymous"), "Anonymous");
  assert.equal(cleanLookupAuthor(null), null);
  assert.deepEqual(cleanLookupBook({ title: "T [Paperback]", author: "NILL", isbn: "1" }), { title: "T", author: null, isbn: "1" });
});

test("a junk author from one source lets the next source's real author fill the field", () => {
  const merged = mergeBooks("9781409555834", [
    { title: "How Bear Lost His Tail  [Paperback] [Jan 01, 2012] NILL", author: "NILL", publisher: "Usborne" },
    { title: "How Bear Lost His Tail", author: "Russell Punter" },
  ]);
  assert.equal(merged.title, "How Bear Lost His Tail");
  assert.equal(merged.author, "Russell Punter");
  assert.equal(merged.publisher, "Usborne");
  const alone = mergeBooks("9781409555834", [{ title: "X [Paperback] NILL", author: "NILL" }]);
  assert.equal(alone.author, null);
  assert.equal(alone.title, "X");
});
