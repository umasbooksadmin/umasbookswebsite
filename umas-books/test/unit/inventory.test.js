const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeCondition, normalizeStatus, normalizeGenres } = require("../../src/lib/inventory");

test("normalizeCondition passes through a known value", () => {
  for (const c of ["new", "like_new", "very_good", "good", "acceptable"]) assert.equal(normalizeCondition(c), c);
});

test("normalizeCondition accepts the old grade keys as aliases (fair and poor = acceptable; like_new is a grade)", () => {
  assert.equal(normalizeCondition("like_new"), "like_new");
  assert.equal(normalizeCondition("fair"), "acceptable");
  assert.equal(normalizeCondition("poor"), "acceptable");
});

test("normalizeCondition defaults an unknown value to very_good", () => {
  assert.equal(normalizeCondition("pristine"), "very_good");
  assert.equal(normalizeCondition(undefined), "very_good");
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

const { normalizeLocation, parseScan, isbnVariants } = require("../../src/lib/inventory");

test("normalizeLocation trims, collapses spaces, upper-cases and caps at 40", () => {
  assert.equal(normalizeLocation("  fiction   a1 "), "FICTION A1");
  assert.equal(normalizeLocation("Fiction-A1"), "FICTION-A1");
  assert.equal(normalizeLocation("x".repeat(60)), "X".repeat(40));
  assert.equal(normalizeLocation("a\tb\nc"), "A B C");
});

test("normalizeLocation returns null for blank input", () => {
  assert.equal(normalizeLocation(""), null);
  assert.equal(normalizeLocation("   "), null);
  assert.equal(normalizeLocation(undefined), null);
  assert.equal(normalizeLocation(null), null);
});

test("parseScan recognises ISBN-13 and ISBN-10, ignoring hyphens and spaces", () => {
  assert.deepEqual(parseScan("9780143127550"), { type: "isbn", isbn: "9780143127550" });
  assert.deepEqual(parseScan(" 978-0-14-312755-0 "), { type: "isbn", isbn: "9780143127550" });
  assert.deepEqual(parseScan("0 14 312755 x"), { type: "isbn", isbn: "014312755X" });
});

test("parseScan treats anything else as unknown", () => {
  for (const v of ["", "   ", "FICTION-A1", "12345", "97801431275501", undefined]) {
    assert.deepEqual(parseScan(v), { type: "unknown" }, String(v));
  }
});

test("isbnVariants converts between ISBN-10 and ISBN-13", () => {
  assert.deepEqual(isbnVariants("9780143127550").sort(), ["0143127551", "9780143127550"].sort());
  assert.deepEqual(isbnVariants("0143127551").sort(), ["0143127551", "9780143127550"].sort());
  assert.deepEqual(isbnVariants("9791234567896"), ["9791234567896"]);
});

test("normalizeGenres returns null for empty input", () => {
  assert.equal(normalizeGenres(""), null);
  assert.equal(normalizeGenres(undefined), null);
  assert.equal(normalizeGenres(" , , "), null);
});
