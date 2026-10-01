const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isEmail, clean } = require("../../src/lib/validation");

test("isEmail accepts one ordinary address", () => {
  assert.ok(isEmail("sam@example.com"));
  assert.ok(isEmail("first.last+tag@sub.example.co.uk"));
});

test("isEmail rejects multi-recipient and header-injection shapes", () => {
  for (const bad of [
    "a@x.com, b@y.com", "a@x.com;b@y.com", "a@x.com b@y.com", "Name <a@x.com>",
    '"a"@x.com', "a@x.com\nBcc: b@y.com", "a@@x.com", "a@x", "", " ", "x".repeat(201) + "@x.com",
  ]) {
    assert.equal(isEmail(bad), false, JSON.stringify(bad));
  }
});

test("isEmail rejects non-strings (e.g. repeated form fields)", () => {
  assert.equal(isEmail(["a@x.com", "b@y.com"]), false);
  assert.equal(isEmail(undefined), false);
});

test("clean trims, caps length, and blanks non-strings", () => {
  assert.equal(clean("  hi  ", 10), "hi");
  assert.equal(clean("abcdef", 3), "abc");
  assert.equal(clean(["a", "b"], 10), "");
  assert.equal(clean(undefined, 10), "");
});
