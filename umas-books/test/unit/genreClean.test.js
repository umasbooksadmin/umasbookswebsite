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
  // A managed spelling wins over the taxonomy's, EXCEPT Children's Fiction: the capital F is the one spelling (2026-11-08).
  const k2 = buildKnown({ common: COMMON_GENRES, managed: [{ name_en: "Children's fiction" }] });
  assert.equal(canonicalGenre("Chidren's Fiction", k2), "Children's Fiction");
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

// "Nonfiction" is one word (2026-11-02). Sources (Open Library, BnF, Google) and old data still say "Non-fiction".
test("every spelling of non-fiction becomes the managed Nonfiction, on every write path", () => {
  const { NONFICTION, isNonfictionVariant, searchGenreName } = require("../../src/lib/genreClean");
  assert.equal(NONFICTION, "Nonfiction");
  assert.ok(COMMON_GENRES.includes("Nonfiction") && !COMMON_GENRES.some((g) => /non-fiction/i.test(g)));
  for (const v of ["Non-fiction", "non-fiction", "NON-FICTION", "Non-Fiction", "non fiction", "Non  Fiction", "nonfiction", "NONFICTION", "Non‐fiction", " Non-fiction§"]) {
    assert.ok(isNonfictionVariant(v), v);
    assert.equal(canonicalGenre(v, STATIC_KNOWN_GENRES), "Nonfiction", v);
    assert.equal(searchGenreName(v), "Nonfiction", v);
    assert.equal(normalizeGenres(`History, ${v}`), "History, Nonfiction", v);
  }
  assert.equal(canonicalGenres("Non-fiction, nonfiction, Fiction", STATIC_KNOWN_GENRES), "Nonfiction, Fiction", "duplicates collapse");
  for (const other of ["Fiction", "Science Fiction", "Nonfictional", "Non-fiction books", "Nonsense"]) {
    assert.ok(!isNonfictionVariant(other), other);
    assert.equal(searchGenreName(other), other);
  }
  assert.equal(canonicalGenre("Non-fiction books", STATIC_KNOWN_GENRES), "Non-fiction books", "only the whole genre is mapped");
  // a managed genre the admin still calls Non-fiction wins (the alias only fills a gap)
  const managedOld = buildKnown({ common: COMMON_GENRES, managed: [{ name_en: "Non-fiction" }] });
  assert.equal(canonicalGenre("non fiction", managedOld), "Nonfiction");
});

test("pickGenres: the subjects of Open Library / BnF / Google that say Non-fiction give Nonfiction", () => {
  assert.ok(pickGenres(["Non-fiction", "Dogs"]).split(", ").includes("Nonfiction"));
  assert.ok(pickGenres(["Nonfiction"]).split(", ").includes("Nonfiction"));
  assert.ok(pickGenres(["Cats", "Non fiction"]).split(", ").includes("Nonfiction"));
  assert.deepEqual(pickGenres(["History", "Non-fiction"]).split(", "), ["Fiction", "Nonfiction", "History"], "as before: the word fiction inside the subject also matches Fiction");
});

// "Children's Fiction" with a capital F (2026-11-08). The managed genre was spelled "Children's fiction" and won.
test("every capitals / apostrophe variant of children's fiction becomes Children's Fiction, whatever the managed spelling", () => {
  const { CHILDRENS_FICTION, isChildrensFictionVariant, searchGenreName } = require("../../src/lib/genreClean");
  assert.equal(CHILDRENS_FICTION, "Children's Fiction");
  assert.ok(COMMON_GENRES.includes("Children's Fiction"));
  const managedLower = buildKnown({ common: COMMON_GENRES, managed: [{ name_en: "Children's fiction" }] });
  const managedCurly = buildKnown({ common: [], managed: [{ name_en: "Children\u2019s fiction" }] });
  for (const v of ["Children's fiction", "children's fiction", "CHILDREN'S FICTION", "Children\u2019s fiction", "children\u2019s Fiction", "  Children's  fiction§", "Children\u2018s fiction"]) {
    assert.ok(isChildrensFictionVariant(v), v);
    for (const k of [known, managedLower, managedCurly, STATIC_KNOWN_GENRES, undefined]) assert.equal(canonicalGenre(v, k), "Children's Fiction", v);
    assert.equal(searchGenreName(v), "Children's Fiction", v);
    assert.equal(normalizeGenres(`Poetry, ${v}`), "Poetry, Children's Fiction", v);
  }
  assert.equal(canonicalGenres("Children's fiction, children\u2019s Fiction, Poetry", managedLower), "Children's Fiction, Poetry", "duplicates collapse");
  assert.equal(managedLower.get("children's fiction"), "Children's Fiction", "the known spelling is the capital F one");
  for (const other of ["Children's Books", "Juvenile Fiction", "Children's fiction books", "Childrens", "Fiction", "Children's"]) {
    assert.ok(!isChildrensFictionVariant(other), other);
    assert.equal(searchGenreName(other), other);
    assert.equal(canonicalGenre(other, managedLower), other);
  }
});

test("pickGenres: a source's Children's fiction subject gives Children's Fiction", () => {
  for (const s of ["Children's fiction", "CHILDREN'S FICTION", "Children\u2019s fiction"]) {
    const g = pickGenres([s, "Dogs"]);
    assert.ok(g.split(", ").includes("Children's Fiction"), `${s} -> ${g}`);
  }
  assert.equal(normalizeGenres(pickGenres(["children's fiction"])), "Fiction, Children's Fiction");
});
