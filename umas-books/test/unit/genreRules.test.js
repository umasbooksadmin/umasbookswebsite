// applyGenreRules / rewriteGenres (src/lib/genreRules.js): the pure rewriting of "Children's Books, Fiction".

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { applyGenreRules, rewriteGenres, planBook, containsWord, genreKey, splitGenres, matchRule } = require("../../src/lib/genreRules");

const children = [{ kind: "contains-word", pattern: "Children", target: "Children", targetFr: "Jeunesse" }];

test("the word Children matches Children, Children's, Childrens, Children’s Books and Children's Fiction", () => {
  for (const g of ["Children", "Children's", "Childrens", "Children’s Books", "Children's Fiction", "CHILDREN'S BOOKS", "  children  "]) {
    assert.equal(applyGenreRules(g, children), "Children", g);
  }
});

test("a word is matched whole: Childhood is not Children, nothing is matched by meaning", () => {
  assert.equal(applyGenreRules("Childhood", children), "Childhood");
  assert.equal(applyGenreRules("Child", children), "Child");
  assert.equal(applyGenreRules("Juvenile Fiction", children), "Juvenile Fiction");
  assert.equal(containsWord("Children", "Anti-children stories"), true, "a hyphen separates words");
  assert.equal(containsWord("Fiction", "Nonfiction"), false);
});

test("plural and possessive endings are tolerated both ways", () => {
  assert.equal(containsWord("Comic", "Comics & Graphic Novels"), true);
  assert.equal(containsWord("Comics", "Comic books"), true);
  assert.equal(containsWord("Children's", "Children"), true);
  assert.equal(containsWord("Class", "Classics"), false, "Class is not Classics");
  assert.equal(containsWord("Glass", "Glas"), false);
});

test("a phrase matches its words in order", () => {
  assert.equal(containsWord("Young Adult", "Young Adult Fiction"), true);
  assert.equal(containsWord("Young Adult", "Adult Young"), false);
});

test("several genres in one book: order kept, duplicates collapsed, others untouched", () => {
  assert.equal(applyGenreRules("Children's Books, Fiction, Childrens Fiction, Zoology", children), "Children, Fiction, Zoology");
  assert.equal(applyGenreRules("Fiction, fiction, FICTION", []), "Fiction", "duplicates collapse even with no rule");
});

test("unmapped genres are left exactly as they are", () => {
  assert.equal(applyGenreRules("Zoology,  Botany ", children), "Zoology, Botany");
  assert.equal(rewriteGenres("Zoology", children).touched, false);
});

test("empty input and a book with nothing left give null", () => {
  assert.equal(applyGenreRules("", children), null);
  assert.equal(applyGenreRules(null, children), null);
  assert.equal(applyGenreRules(" , ,", children), null);
  assert.equal(applyGenreRules("Erotica", [{ kind: "exact", pattern: "erotica", action: "remove" }]), null);
});

test("removal drops the genre and keeps the rest in order", () => {
  const rules = [{ kind: "contains-word", pattern: "General", action: "remove" }];
  assert.equal(applyGenreRules("Fiction, General, Mystery", rules), "Fiction, Mystery");
  const r = rewriteGenres("Fiction, General", rules);
  assert.equal(r.removed, 1);
});

test("exact beats contains-word, whatever their order in the list", () => {
  const rules = [
    { kind: "contains-word", pattern: "Children", target: "Children" },
    { kind: "exact", pattern: "Children's Literature", target: "Kids' Lit" },
  ];
  assert.equal(applyGenreRules("Children's Literature, Children's Books", rules), "Kids' Lit, Children");
});

test("an exact 'keep' protects a genre from a word rule; a word rule beats a managed name; a managed name beats nothing", () => {
  const rules = [
    { kind: "contains-word", pattern: "Fiction", target: "Fiction" },
    { kind: "exact", pattern: "Science Fiction", action: "keep" },
    { kind: "exact", pattern: "Non-fiction", action: "keep" },
    { kind: "managed", pattern: "Children's Fiction", target: "Children's Fiction" },
    { kind: "managed", pattern: "History", target: "History" },
  ];
  assert.equal(applyGenreRules("Science Fiction, Non-fiction, Historical Fiction, Children's Fiction", rules), "Science Fiction, Non-fiction, Fiction", "the word rule takes Children's Fiction (use Show matches), a keep rule protects");
  assert.equal(applyGenreRules("history", rules), "History", "a managed name normalises its capitals");
});

test("exact matching ignores capitals, spacing and the curly apostrophe", () => {
  const rules = [{ kind: "exact", pattern: "Children's Books", target: "Children" }];
  for (const g of ["children’s books", "CHILDREN'S   BOOKS", " Children‘s Books "]) assert.equal(applyGenreRules(g, rules), "Children", g);
  assert.equal(applyGenreRules("Children's Book", rules), "Children's Book");
});

test("first match wins inside a kind (priority = list order, or sort)", () => {
  const rules = [
    { kind: "contains-word", pattern: "Crime", target: "Mystery" },
    { kind: "contains-word", pattern: "True", target: "Non-fiction" },
  ];
  assert.equal(applyGenreRules("True Crime", rules), "Mystery");
  const swapped = [{ ...rules[0], sort: 2 }, { ...rules[1], sort: 1 }];
  assert.equal(applyGenreRules("True Crime", swapped), "Non-fiction");
});

test("French follows: the managed French name for mapped genres, the word list for the rest", () => {
  const r = rewriteGenres("Children's Books, Mystery, Zoology", [...children, { kind: "exact", pattern: "Mystery", action: "keep" }]);
  assert.equal(r.en, "Children, Mystery, Zoology");
  assert.equal(r.fr, "Jeunesse, Policier, Zoology");
});

test("changed means the list differs; spacing alone is not a change", () => {
  assert.equal(rewriteGenres("A,B", []).changed, false);
  assert.equal(rewriteGenres("Children's", children).changed, true);
  assert.equal(rewriteGenres("Children", children).changed, false);
});

test("planBook: a book already in line is not touched; a stale French is fixed when a rule applies", () => {
  const rules = [...children, { kind: "managed", pattern: "Children", target: "Children", targetFr: "Jeunesse" }];
  const done = planBook("Children", "Jeunesse", rules);
  assert.equal(done.changed, false);
  const staleFr = planBook("Children", "Enfants", rules);
  assert.equal(staleFr.changed, true);
  assert.equal(staleFr.enChanged, false);
  assert.equal(staleFr.fr, "Jeunesse");
  const free = planBook("Zoology", "Zoologie", rules);
  assert.equal(free.changed, false, "unmapped genres and their French stay as they are");
  assert.equal(free.fr, "Zoologie");
});

test("helpers", () => {
  assert.equal(genreKey("  Children’s   BOOKS "), "children's books");
  assert.deepEqual(splitGenres("a, ,b ,"), ["a", "b"]);
  assert.equal(matchRule(children, "Childhood"), null);
});
