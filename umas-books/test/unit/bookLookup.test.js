const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeIsbn, translateGenresToFrench } = require("../../src/lib/bookLookup");

test("normalizeIsbn strips hyphens and spaces", () => {
  assert.equal(normalizeIsbn("978-0-13-468599-1"), "9780134685991");
  assert.equal(normalizeIsbn("978 0 13 468599 1"), "9780134685991");
});

test("normalizeIsbn uppercases a trailing X (ISBN-10 check digit)", () => {
  assert.equal(normalizeIsbn("043942089x"), "043942089X");
});

test("normalizeIsbn drops any other non-ISBN characters", () => {
  assert.equal(normalizeIsbn("isbn:9780134685991"), "9780134685991");
});

test("normalizeIsbn handles empty/missing input", () => {
  assert.equal(normalizeIsbn(""), "");
  assert.equal(normalizeIsbn(undefined), "");
});

test("translateGenresToFrench: taxonomy genres, the age-group short forms (Young Adult, Children's) and unknown tags", () => {
  assert.equal(translateGenresToFrench("Fiction, Mystery, Young Adult Fiction"), "Fiction, Policier, Fiction jeune adulte");
  assert.equal(translateGenresToFrench("Young Adult"), "Jeune adulte");
  assert.equal(translateGenresToFrench("young adult, Children's"), "Jeune adulte, Jeunesse");
  assert.equal(translateGenresToFrench("Non-fiction, Zymurgy"), "Non-fiction, Zymurgy", "a tag outside the taxonomy is kept, not dropped");
  assert.equal(translateGenresToFrench(""), null);
});
