// public/inventory-location.js, the plain functions (no browser): the same rule
// as normalizeLocation in src/lib/inventory.js (a scanned ISBN is not a place)
// and the test that tells a scanner's burst of digits from a person typing.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const L = require("../../public/inventory-location.js");
const { normalizeLocation } = require("../../src/lib/inventory");

test("clean and split cut a barcode off the start or the end of the location", () => {
  assert.equal(L.clean("9780141024479Storage"), "Storage");
  assert.equal(L.clean("Storage 9780141024479"), "Storage");
  assert.deepEqual(L.split("9780141024479Storage"), { location: "Storage", barcode: "9780141024479" });
  assert.deepEqual(L.split("Storage 9780141024479"), { location: "Storage", barcode: "9780141024479" });
  assert.deepEqual(L.split("9780141024479"), { location: "", barcode: "9780141024479" });
  assert.deepEqual(L.split("Shelf 12"), { location: "Shelf 12", barcode: "" });
  assert.deepEqual(L.split(null), { location: "", barcode: "" });
});

test("clean agrees with the server's normalizeLocation on every case", () => {
  const cases = ["9780141024479Storage", "Storage 9780141024479", "9780141024479 Storage 9780143127550", "9780141024479", "12345678", "1234567",
    "Shelf 12", "Box 2024", "A-7", "123456789012345", "123456789012345Store", "  fiction   a1 ", "a\tb", "Étagère #3", "x".repeat(60),
    "9780141024479" + "x".repeat(40), "٣٣٣٣٣٣٣٣٣Store", ""];
  for (const v of cases) assert.equal(L.clean(v), normalizeLocation(v) || "", JSON.stringify(v));
});

test("the burst guard calls 8 fast keys a scanner and a slow typist a person", () => {
  let t = 1000;
  const g = L.createBurstGuard({ now: () => t });
  for (let i = 0; i < 13; i++) { g.key(); t += 10; }
  assert.ok(g.isBurst(), "13 digits 10 ms apart");
  g.reset();
  assert.equal(g.isBurst(), false);
  for (let i = 0; i < 13; i++) { g.key(); t += 200; }
  assert.equal(g.isBurst(), false, "13 digits 200 ms apart is typing");
  for (let i = 0; i < 7; i++) { g.key(); t += 10; }
  assert.equal(g.isBurst(), false, "7 fast keys are too few");
  g.key();
  assert.ok(g.isBurst(), "the 8th fast key");
});
