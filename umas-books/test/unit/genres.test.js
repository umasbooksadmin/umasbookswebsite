// Genres shown to customers: every genre in the taxonomy has a French label.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { COMMON_GENRES, COMMON_GENRES_FR, GENRE_ALIASES_FR } = require("../../src/lib/bookLookup");
const { genreLabel, genresLabel } = require("../../src/lib/genres");

// Same spelling in both languages on purpose (the French word is the English one).
const SAME_IN_FRENCH = new Set(["Fiction", "Non-fiction", "Fantasy", "Romance", "Thriller", "Religion", "Art", "Suspense", "Nature", "Design", "Humour"]);

test("every known genre has a French label (same word only where French uses it)", () => {
  assert.equal(COMMON_GENRES_FR.length, COMMON_GENRES.length, "one French label per genre");
  for (const en of COMMON_GENRES) {
    const fr = genreLabel(en, "fr");
    assert.ok(fr, `${en} has a label`);
    if (!SAME_IN_FRENCH.has(en)) assert.notEqual(fr, en, `${en} must be translated`);
    assert.equal(genreLabel(en.toLowerCase(), "fr"), fr, `${en}: case-insensitive`);
  }
  for (const [en, fr] of GENRE_ALIASES_FR) {
    assert.equal(genreLabel(en, "fr"), fr);
    if (!SAME_IN_FRENCH.has(en)) assert.notEqual(fr, en, `${en} alias must be translated`);
    assert.doesNotMatch(fr, / [;:!?»]|«/, "no unprotected French punctuation spacing issues");
  }
});

test("genre labels: French only in French, unknown genres keep their text", () => {
  assert.equal(genreLabel("Mystery", "en"), "Mystery");
  assert.equal(genreLabel("Mystery", "fr"), "Policier");
  assert.equal(genreLabel("Zymurgy", "fr"), "Zymurgy");
  assert.equal(genresLabel("Mystery, Science Fiction", "en"), "Mystery, Science Fiction");
  assert.equal(genresLabel("Mystery, Science Fiction", "fr"), "Policier, Science-fiction");
  assert.equal(genresLabel("Mystery, Science Fiction", "fr", "Mystery, Science Fiction"), "Policier, Science-fiction", "a stale English copy is not shown");
  assert.equal(genresLabel("Fiction, Zymurgy", "fr", "Fiction, Brassage"), "Fiction, Brassage", "custom genre: the stored French entry");
  assert.equal(genresLabel("Zymurgy, Whimsy", "fr", "Brassage"), "Zymurgy, Whimsy", "mismatched stored French is ignored");
  assert.equal(genresLabel(null, "fr"), "");
});
