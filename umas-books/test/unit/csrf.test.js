const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isValidCsrfToken } = require("../../src/middleware/csrf");

const REAL = "a".repeat(64);

test("accepts a matching token", () => {
  assert.equal(isValidCsrfToken(REAL, REAL), true);
});

test("rejects a same-length but different token", () => {
  assert.equal(isValidCsrfToken("b".repeat(64), REAL), false);
});

test("rejects a shorter token instead of throwing", () => {
  assert.equal(isValidCsrfToken("short", REAL), false);
});

test("rejects a longer token instead of throwing", () => {
  assert.equal(isValidCsrfToken(REAL + "extra", REAL), false);
});

test("rejects a missing token", () => {
  assert.equal(isValidCsrfToken(undefined, REAL), false);
});

test("rejects a non-string token (e.g. an array from a duplicate form field)", () => {
  assert.equal(isValidCsrfToken(["a", "b"], REAL), false);
});

test("rejects when the session has no token yet", () => {
  assert.equal(isValidCsrfToken(REAL, undefined), false);
});
