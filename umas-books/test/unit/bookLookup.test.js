const { test } = require("node:test");
const assert = require("node:assert/strict");
const { normalizeIsbn } = require("../../src/lib/bookLookup");

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
