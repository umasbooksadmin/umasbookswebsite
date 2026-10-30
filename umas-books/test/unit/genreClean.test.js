// The clean-up of every saved book genre (src/lib/genreClean.js), English only: stray §, curly apostrophes, capitals of
// a known genre, the two sure typos, duplicates, empty parts. Also the write path helpers (normalizeGenres, pickGenres).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { cleanGenreName, cleanList, buildKnown, canonicalGenre, canonicalGenres, planGenreCleanup, GENRE_TYPOS } = require("../../src/lib/genreClean");
const { COMMON_GENRES, STATIC_KNOWN_GENRES, pickGenres } = require("../../src/lib/bookLookup");
const { normalizeGenres } = require("../../src/lib/inventory");

const known = buildKnown({ common: COMMON_GENRES, managed: [{ name_en: "Art & Design" }, { name_en: "Health & Wellness" }] });

test("a stray § (or other junk) at the start or end goes, nothing inside a name is touched", () => {
  assert.equal(cleanGenreName("Children's Fiction§"), "Children's Fiction");
  assert.equal(cleanGenreName("§Fantasy"), "Fantasy");
  assert.equal(cleanGenreName("* Mystery. ;"), "Mystery");
  assert.equal(cleanGenreName("Science-Fiction"), "Science-Fiction");
  assert.equal(cleanGenreName("Health & Wellbeing"), "Health & Wellbeing");
  assert.equal(cleanGenreName("Crime (Classic)"), "Crime (Classic)");
  assert.equal(cleanGenreName("Économie§"), "Économie");
  assert.equal(cleanGenreName("C++"), "C++");
  assert.equal(cleanGenreName("§"), "");
  assert.equal(cleanGenreName(null), "");
});

test("curly apostrophes U+2018 and U+2019 (and the other typographic ones) become the straight one", () => {
  assert.equal(cleanGenreName("Children’s Fiction"), "Children's Fiction");
  assert.equal(cleanGenreName("Children‘s Fiction"), "Children's Fiction");
  assert.equal(cleanGenreName("Childrenʼs Fiction"), "Children's Fiction");
  assert.equal(cleanGenreName("  Children’s   Fiction§ "), "Children's Fiction");
});

test("a known genre takes its own capitals and spelling; an unknown one is only cleaned", () => {
  assert.equal(canonicalGenre("art & design", known), "Art & Design");
  assert.equal(canonicalGenre("art & Design", known), "Art & Design");
  assert.equal(canonicalGenre("SCIENCE FICTION", known), "Science Fiction");
  assert.equal(canonicalGenre("children’s fiction§", known), "Children's Fiction");
  assert.equal(canonicalGenre("Gothic Horrors§", known), "Gothic Horrors", "unknown: cleaned, not guessed");
  assert.equal(canonicalGenre("Mistery", known), "Mistery", "a typo that is not in the list is NOT corrected");
});

test("typos only where the mapping is certain", () => {
  assert.deepEqual(GENRE_TYPOS.map((t) => t[0]), ["chidren's fiction", "childrens fiction"]);
  assert.equal(canonicalGenre("Chidren's Fiction", known), "Children's Fiction");
  assert.equal(canonicalGenre("Chidren’s Fiction§", known), "Children's Fiction");
  assert.equal(canonicalGenre("Childrens Fiction", known), "Children's Fiction");
  assert.equal(canonicalGenre("Children's Books", known), "Children's Books", "not a typo of a known genre: left alone");
  // A managed spelling of the genre wins over the taxonomy's, typo or not.
  const k2 = buildKnown({ common: COMMON_GENRES, managed: [{ name_en: "Children's fiction" }] });
  assert.equal(canonicalGenre("Chidren's Fiction", k2), "Children's fiction");
});

test("a list: duplicates (any capitals) dropped, empty parts dropped, order kept, tidy ', ' separator", () => {
  assert.equal(canonicalGenres("Fiction,fiction ,, §, Mystery ,Fiction", known), "Fiction, Mystery");
  assert.equal(canonicalGenres("Children's Fiction§, Children’s Fiction, Chidren's Fiction", known), "Children's Fiction");
  assert.equal(canonicalGenres("Fantasy; Epic, art & design", known), "Fantasy; Epic, Art & Design");
  assert.equal(canonicalGenres("", known), null);
  assert.equal(canonicalGenres(null, known), null);
  assert.equal(canonicalGenres(" , §, ", known), null);
  assert.deepEqual(cleanList("A, b ,, §"), ["A", "b"]);
});

test("planGenreCleanup: only a real change counts; spacing alone and 'nothing left' leave the value as stored", () => {
  assert.equal(planGenreCleanup("Children's Fiction§", known), "Children's Fiction");
  assert.equal(planGenreCleanup("art & Design, Fiction", known), "Art & Design, Fiction");
  assert.equal(planGenreCleanup("Fiction,Mystery", known), "Fiction,Mystery", "spacing around commas only: untouched");
  assert.equal(planGenreCleanup("Gothic", known), "Gothic");
  assert.equal(planGenreCleanup("§", known), "§", "a genre list that would be empty is not wiped by a data fix");
  assert.equal(planGenreCleanup(null, known), null);
  assert.equal(planGenreCleanup("", known), "");
  // idempotent
  for (const v of ["Children's Fiction§", "chidren’s fiction, ART & design", "Fiction, fiction"]) {
    const once = planGenreCleanup(v, known);
    assert.equal(planGenreCleanup(once, known), once, v);
  }
});

test("write path helpers: normalizeGenres and pickGenres use the same clean-up", () => {
  assert.equal(normalizeGenres("Children's Fiction§"), "Children's Fiction");
  assert.equal(normalizeGenres("children’s fiction, Chidren's Fiction"), "Children's Fiction");
  assert.equal(normalizeGenres(" Fantasy ,fiction, Fantasy"), "Fantasy, Fiction");
  assert.equal(normalizeGenres("Gothic, gothic"), "Gothic");
  assert.equal(normalizeGenres("§"), null);
  assert.ok(STATIC_KNOWN_GENRES.has("science fiction"));
  assert.equal(pickGenres(["Gothic tales§"]), "Gothic tales");
});
