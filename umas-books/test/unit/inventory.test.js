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

test("normalizeGenres trims, dedupes case-insensitively, and rejoins (a fixed-list genre takes its own spelling)", () => {
  assert.equal(normalizeGenres(" Fantasy ,fiction, Fantasy"), "Fantasy, Fiction");
  assert.equal(normalizeGenres(" Gothic ,gothic, Fantasy"), "Gothic, Fantasy");
});

const { normalizeLocation, locationKey, sameLocation, uniqueLocations, LOCATION_MAX, parseScan, isbnVariants } = require("../../src/lib/inventory");

test("normalizeLocation keeps the capitals, trims, collapses spaces and caps at 40", () => {
  assert.equal(normalizeLocation("  fiction   a1 "), "fiction a1");
  assert.equal(normalizeLocation("Fiction-A1"), "Fiction-A1");
  assert.equal(normalizeLocation("Store"), "Store");
  assert.equal(normalizeLocation("STORE"), "STORE");
  assert.equal(normalizeLocation("x".repeat(60)), "x".repeat(40));
  assert.equal(normalizeLocation("Ab".repeat(30)), "Ab".repeat(20));
  assert.equal(LOCATION_MAX, 40);
  assert.equal(normalizeLocation("a\tb\nc"), "a b c");
  assert.equal(normalizeLocation("a".repeat(39) + "   b"), "a".repeat(39), "no trailing space left after the cut");
});

test("normalizeLocation leaves every other character as it was (accents, digits, punctuation)", () => {
  assert.equal(normalizeLocation("Étagère #3 (rez-de-chaussée) / A.1_b"), "Étagère #3 (rez-de-chaussée) / A.1_b");
  assert.equal(normalizeLocation(12), "12");
});

test("locations that differ only in capitals are the same place", () => {
  assert.equal(sameLocation("store", "STORE"), true);
  assert.equal(sameLocation(" Store ", "sTORE"), true);
  assert.equal(sameLocation("Store", "Store 2"), false);
  assert.equal(sameLocation("", ""), false, "blank is no place");
  assert.equal(sameLocation(null, "Store"), false);
  assert.equal(locationKey("  Fiction   A1"), "fiction a1");
  assert.equal(locationKey("   "), null);
});

test("uniqueLocations lists one entry per place, in the most common then most recent spelling", () => {
  assert.deepEqual(uniqueLocations(["STORE", "Store", "store", "Fiction A1"]), ["Fiction A1", "STORE"], "ties: the first alphabetically (capitals first)");
  assert.deepEqual(uniqueLocations([{ location: "STORE", count: 2 }, { location: "Store", count: 5 }, { location: "Zed", count: 1 }]), ["Store", "Zed"]);
  assert.deepEqual(uniqueLocations([{ location: "STORE", count: 3, last: "2026-01-01" }, { location: "Store", count: 3, last: "2026-02-01" }]), ["Store"], "tie on count: the most recently used");
  assert.deepEqual(uniqueLocations([{ location: "b" }, { location: "A" }, { location: "  " }, { location: null }, "a"]), ["A", "b"], "blanks dropped, sorted ignoring capitals");
  assert.deepEqual(uniqueLocations(undefined), []);
});

test("normalizeLocation drops a barcode a scanner typed into the Location box", () => {
  assert.equal(normalizeLocation("9780141024479Storage"), "Storage");
  assert.equal(normalizeLocation("Storage 9780141024479"), "Storage");
  assert.equal(normalizeLocation("Storage9780141024479"), "Storage");
  assert.equal(normalizeLocation("9780141024479 Fiction A1"), "Fiction A1");
  assert.equal(normalizeLocation("9780141024479 Storage 9780143127550"), "Storage", "both ends");
  assert.equal(normalizeLocation("12345678Store"), "Store", "8 digits is the shortest barcode-looking run");
  assert.equal(normalizeLocation("Store 12345678901234"), "Store", "14 digits is the longest");
  assert.equal(normalizeLocation("  9780141024479   Étagère  3 "), "Étagère 3");
});

test("normalizeLocation turns a value that is only a barcode into null (the default applies)", () => {
  assert.equal(normalizeLocation("9780141024479"), null);
  assert.equal(normalizeLocation(" 12345678 "), null);
  assert.equal(normalizeLocation(9780141024479), null);
});

test("normalizeLocation leaves short numbers, long digit runs and non-ASCII digits alone", () => {
  for (const v of ["Shelf 12", "Box 2024", "A-7", "1234567", "Room 1234567", "123456789012345", "Store 123456789012345", "123456789012345Store", "Box 12-34-56-78", "\u0663\u0663\u0663\u0663\u0663\u0663\u0663\u0663\u0663Store", "978 0141 0244 79 Store"]) {
    assert.equal(normalizeLocation(v), v, v);
  }
});

test("normalizeLocation strips the barcode before the 40-character cap, never after", () => {
  assert.equal(normalizeLocation("9780141024479" + "x".repeat(40)), "x".repeat(40), "the barcode does not eat into the 40");
  assert.equal(normalizeLocation("y".repeat(45) + " 9780141024479"), "y".repeat(40));
  assert.equal(normalizeLocation("9780141024479" + "x".repeat(39) + " tail"), "x".repeat(39));
  assert.equal(normalizeLocation(normalizeLocation("9780141024479Storage")), "Storage", "idempotent");
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
