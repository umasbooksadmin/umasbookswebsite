const { test } = require("node:test");
const assert = require("node:assert/strict");
const { scrubPersonalData } = require("../../src/lib/scrub");

test("replaces email addresses", () => {
  assert.equal(scrubPersonalData("mail a.b+c@sub.example.co.uk and x@y.fr now"), "mail [email] and [email] now");
});

test("replaces phone numbers and other digit runs of 9 or more, with or without separators", () => {
  assert.equal(scrubPersonalData("call 0612345678"), "call [number]");
  assert.equal(scrubPersonalData("call +33 6 12 34 56 78 today"), "call [number] today");
  assert.equal(scrubPersonalData("call 06.12.34.56.78"), "call [number]");
});

test("leaves ordinary short numbers, dates and line:column pairs alone", () => {
  const text = "order 12345678 at src/x.js:123:45 on 2026-10-04 total 19.90";
  assert.equal(scrubPersonalData(text), text);
});

test("non-strings are stringified", () => {
  assert.equal(scrubPersonalData(null), "null");
});
