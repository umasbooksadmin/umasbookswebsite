const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCondition, normalizeStatus, normalizeGenres } = require("../../src/lib/inventory");

test("normalizeCondition passes through a known value", () => {
  assert.equal(normalizeCondition("like_new"), "like_new");
});

test("normalizeCondition defaults an unknown value to good", () => {
  assert.equal(normalizeCondition("pristine"), "good");
  assert.equal(normalizeCondition(undefined), "good");
});

test("normalizeStatus passes through a known value", () => {
  assert.equal(normalizeStatus("donated"), "donated");
});

test("normalizeStatus defaults an unknown value to in_stock", () => {
  assert.equal(normalizeStatus("missing"), "in_stock");
});

test("normalizeGenres trims, dedupes case-insensitively, and rejoins", () => {
  assert.equal(normalizeGenres(" Fantasy ,fiction, Fantasy"), "Fantasy, fiction");
});

test("normalizeGenres returns null for empty input", () => {
  assert.equal(normalizeGenres(""), null);
  assert.equal(normalizeGenres(undefined), null);
  assert.equal(normalizeGenres(" , , "), null);
});
