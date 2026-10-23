// Golden test for adding a copy (POST /admin/inventory) and the handlers beside it (edit a copy, cancel a
// reservation, delete a copy or a book). test/fixtures/intakeGolden.json was recorded from the code as it was
// BEFORE the logic moved into lib/inventoryIntake.js and lib/inventoryCopies.js: for ~60 inputs it holds the
// status, content type, Location, body, the form shown again after a refusal, the books / book_copies rows
// (ids, times and hashes normalised), the audit entries and the intake tokens. A refactor must not change a byte;
// a deliberate change re-records it (see test/helpers/intakeGolden.js).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { boot, runMatrix } = require("../helpers/intakeGolden");

const expected = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "fixtures", "intakeGolden.json"), "utf8"));
let harness;
let actual;
before(async () => {
  harness = await boot("intake_golden");
  actual = await runMatrix(harness);
});
after(async () => { await harness.close(); });

test("every case answers as the recorded one did (status, headers, body, audit)", () => {
  assert.deepEqual(Object.keys(actual.cases), Object.keys(expected.cases));
  for (const name of Object.keys(expected.cases)) assert.deepEqual(actual.cases[name], expected.cases[name], `case: ${name}`);
});
test("the books table holds what it did", () => assert.deepEqual(actual.books, expected.books));
test("the book_copies table holds what it did (location, source, price, publisher price, date acquired)", () => assert.deepEqual(actual.copies, expected.copies));
test("intake tokens and matched customer requests are as recorded", () => {
  assert.deepEqual(actual.tokens, expected.tokens);
  assert.deepEqual(actual.requests, expected.requests);
});
