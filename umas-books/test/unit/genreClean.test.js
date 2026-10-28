// The genre clean-up of every save (src/lib/genreClean.js), the translation of the cleaned names, and the canonical
// spelling of a known genre.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { cleanGenreName, canonicalGenres, tidyFrench, buildKnown, planGenreCleanup } = require("../../src/lib/genreClean");
const { translateGenresToFrench, STATIC_KNOWN_GENRES, GENRE_ALIASES_FR, COMMON_GENRES, COMMON_GENRES_FR } = require("../../src/lib/bookLookup");
const { normalizeGenres } = require("../../src/lib/inventory");

test("a curly or typographic apostrophe becomes the straight one", () => {
  for (const a of ["’", "‘", "ʼ", "′", "`", "´", "‛"]) {
    assert.equal(cleanGenreName(`Children${a}s Fiction`), "Children's Fiction", JSON.stringify(a));
  }
});

test("a stray character at the end is dropped (the § of a Mac ISO keyboard, and the like)", () => {
  for (const junk of ["§", "±", "`", "~", "*", ".", ";", ":", "\"", "'", "”", "»", " §", "§§", ". ", "-", "–", "…", " "]) {
    assert.equal(cleanGenreName(`Children's Fiction${junk}`), "Children's Fiction", JSON.stringify(junk));
  }
});

test("leading junk is dropped, spaces of every kind are collapsed", () => {
  assert.equal(cleanGenreName("§Fantasy"), "Fantasy");
  assert.equal(cleanGenreName("* Fantasy"), "Fantasy");
  assert.equal(cleanGenreName("“Mystery”"), "Mystery");
  assert.equal(cleanGenreName("'Classics'"), "Classics");
  assert.equal(cleanGenreName("  Science \t  Fiction  "), "Science Fiction");
  assert.equal(cleanGenreName("§"), "");
  assert.equal(cleanGenreName(null), "");
});

test("legitimate names are left exactly as they are", () => {
  for (const name of [
    "Science-Fiction", "Health & Wellbeing", "Crime (Classic)", "Children's Fiction", "Self-help", "Non-fiction",
    "Sci-Fi", "C++", "C#", "[Rare] Books", "1984 Collection", "WW2", "Arts & Crafts",
  ]) assert.equal(cleanGenreName(name), name);
});

test("French names, accented letters included, are left exactly as they are", () => {
  for (const name of [...COMMON_GENRES_FR, ...GENRE_ALIASES_FR.map(([, fr]) => fr), "Économie et gestion", "Santé & Bien-être", "Décoration d'intérieur", "Œuvres complètes", "Été"]) {
    assert.equal(cleanGenreName(name), name);
  }
});

test("translateGenresToFrench translates the cleaned names", () => {
  assert.equal(translateGenresToFrench("Children's Fiction"), "Fiction jeunesse");
  assert.equal(translateGenresToFrench("Children’s Fiction"), "Fiction jeunesse");
  assert.equal(translateGenresToFrench("Children's Fiction§"), "Fiction jeunesse");
  assert.equal(translateGenresToFrench("children’s fiction§, MYSTERY."), "Fiction jeunesse, Policier");
  assert.equal(translateGenresToFrench("Gothic§"), "Gothic", "outside the taxonomy: kept, cleaned");
  assert.equal(translateGenresToFrench("Science Fiction, , Fantasy"), "Science-fiction, Fantasy");
});

test("a known genre takes its canonical spelling; others stay as typed, cleaned", () => {
  assert.equal(normalizeGenres("children’s fiction§"), "Children's Fiction");
  assert.equal(normalizeGenres("young adult fiction, gothic novel§"), "Young Adult Fiction, gothic novel");
  assert.equal(normalizeGenres("Children's Fiction§, Children’s Fiction"), "Children's Fiction", "duplicates after the clean-up collapse");
  assert.equal(normalizeGenres("§, ±"), null);
  const known = buildKnown({ common: COMMON_GENRES, commonFr: COMMON_GENRES_FR, managed: [{ name_en: "Health & Wellness", name_fr: "Santé & Bien-être" }, { name_en: "Fiction", name_fr: "" }] });
  assert.equal(canonicalGenres("health & wellness*", known), "Health & Wellness");
  assert.equal(known.get("fiction").fr, "Fiction", "a managed genre without a French name takes the taxonomy's");
});

test("tidyFrench: the stray §, and an English name of a known genre, are fixed; real French is kept", () => {
  const k = STATIC_KNOWN_GENRES;
  assert.equal(tidyFrench("Children's Fiction§", "Children's Fiction", k), "Fiction jeunesse");
  assert.equal(tidyFrench("Children’s Fiction", "Children's Fiction", k), "Fiction jeunesse");
  assert.equal(tidyFrench("Fiction jeunesse§", "Children's Fiction", k), "Fiction jeunesse");
  assert.equal(tidyFrench("", "Children's Fiction, Gothic", k), "Fiction jeunesse, Gothic", "no French: made from the English");
  assert.equal(tidyFrench("Roman gothique", "Gothic", k), "Roman gothique", "hand-typed French is kept");
  assert.equal(tidyFrench("Policier, Mystery", "Mystery", k), "Policier", "duplicates collapse");
});

test("no French name of the lists is itself the English of a DIFFERENT known genre (a French entry is never re-translated wrongly)", () => {
  for (const fr of [...COMMON_GENRES_FR, ...GENRE_ALIASES_FR.map(([, f]) => f)]) {
    const hit = STATIC_KNOWN_GENRES.get(fr.toLowerCase());
    if (hit) assert.equal(hit.fr, fr, fr);
  }
});

test("planGenreCleanup (what migration 107 does to one book)", () => {
  const k = STATIC_KNOWN_GENRES;
  assert.deepEqual(planGenreCleanup("Children's Fiction§", "Children's Fiction§", k), { en: "Children's Fiction", fr: "Fiction jeunesse" });
  assert.deepEqual(planGenreCleanup("Children's Fiction", null, k), { en: "Children's Fiction", fr: "Fiction jeunesse" });
  assert.deepEqual(planGenreCleanup("Fiction,Mystery", "Fiction,Policier", k), { en: "Fiction,Mystery", fr: "Fiction,Policier" }, "spacing alone: untouched");
  assert.deepEqual(planGenreCleanup("Gothic", null, k), { en: "Gothic", fr: null }, "unknown genre, no French: untouched");
  assert.deepEqual(planGenreCleanup("§", "§", k), { en: "§", fr: "§" }, "nothing would be left: untouched");
});
