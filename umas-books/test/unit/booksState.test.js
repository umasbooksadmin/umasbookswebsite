// public/books-state.js: the Browse Books search / genre / "new in" state <-> query string.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const S = require("../../public/books-state.js");

const GENRES = ["fiction", "children", "ya", "nonfiction", "all"];

test("serialize: nothing, a search, a genre, new in", () => {
  assert.equal(S.serialize(S.empty()), "");
  assert.equal(S.serialize({ q: "le petit prince", genre: "", isNew: false }), "?q=le+petit+prince");
  assert.equal(S.serialize({ q: "", genre: "fiction", isNew: false }), "?genre=fiction");
  assert.equal(S.serialize({ q: "", genre: "", isNew: true }), "?new=1");
  assert.equal(S.serialize({ q: "a&b=c#d", genre: "", isNew: false }), "?q=a%26b%3Dc%23d", "special characters are encoded");
});

test("parse is the inverse of serialize, including accents and quotes", () => {
  for (const state of [
    S.empty(),
    { q: "Étranger \"L'\" & Co", genre: "", isNew: false },
    { q: "", genre: "ya", isNew: false },
    { q: "", genre: "", isNew: true },
  ]) {
    assert.deepEqual(S.parse(S.serialize(state), GENRES), state);
  }
});

test("parse: a search wins over a genre, a genre over new; unknown things are ignored", () => {
  assert.deepEqual(S.parse("?q=x&genre=fiction&new=1", GENRES), { q: "x", genre: "", isNew: false });
  assert.deepEqual(S.parse("?genre=fiction&new=1", GENRES), { q: "", genre: "fiction", isNew: false });
  assert.deepEqual(S.parse("?genre=nope&new=1", GENRES), { q: "", genre: "", isNew: true });
  assert.deepEqual(S.parse("?genre=nope", GENRES), S.empty());
  assert.deepEqual(S.parse("?new=2", GENRES), S.empty());
  assert.deepEqual(S.parse("", GENRES), S.empty());
  assert.deepEqual(S.parse(undefined, GENRES), S.empty());
  assert.deepEqual(S.parse("?utm_source=x", GENRES), S.empty(), "other parameters are ignored");
  assert.deepEqual(S.parse("q=x", GENRES).q, "x", "works without the leading ?");
});

test("parse: the search is tidied and capped", () => {
  assert.equal(S.parse("?q=%20%20two%20%20%20words%20", GENRES).q, "two words");
  assert.equal(S.parse("?q=" + "a".repeat(500), GENRES).q.length, S.MAX_Q);
  assert.deepEqual(S.parse("?q=%20%20", GENRES), S.empty());
  assert.doesNotThrow(() => S.parse("?q=%E0%A4%A&genre=%", GENRES), "malformed escapes never throw");
});

test("same: compares what the address would be", () => {
  assert.ok(S.same({ q: "a", genre: "fiction", isNew: true }, { q: "a", genre: "", isNew: false }));
  assert.ok(!S.same({ q: "", genre: "fiction", isNew: false }, { q: "", genre: "ya", isNew: false }));
  assert.ok(S.same(S.empty(), S.empty()));
});

test("page-books.js wires the state to the history and respects reduced motion", () => {
  const js = fs.readFileSync(path.join(__dirname, "..", "..", "public", "page-books.js"), "utf8");
  assert.match(js, /history\.pushState/);
  assert.match(js, /history\.replaceState/);
  assert.match(js, /addEventListener\('popstate'/);
  assert.match(js, /UI\.reducedMotion/, "the shared helper (public/ui.js) answers it");
  assert.match(fs.readFileSync(path.join(__dirname, "..", "..", "public", "ui.js"), "utf8"), /prefers-reduced-motion: reduce/);
  assert.match(js, /scrollIntoView/);
});
