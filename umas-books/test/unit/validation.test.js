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

test("parseId accepts positive int4 strings only", () => {
  const { parseId } = require("../../src/lib/validation");
  assert.equal(parseId("42"), 42);
  assert.equal(parseId("2147483647"), 2147483647);
  for (const bad of ["abc", "", "0", "-1", "1.5", "1x", " 1", "01", "2147483648", "99999999999", undefined, ["1"], 5]) {
    assert.equal(parseId(bad), null, JSON.stringify(bad));
  }
});

test("cleanHttpUrl keeps absolute http(s) URLs and drops everything else", () => {
  const { cleanHttpUrl } = require("../../src/lib/validation");
  assert.equal(cleanHttpUrl("  https://example.org/a?b=1 "), "https://example.org/a?b=1");
  assert.equal(cleanHttpUrl("http://example.org"), "http://example.org");
  for (const bad of ["javascript:alert(1)", "JAVASCRIPT:alert(1)", "data:text/html,x", "ftp://example.org", "example.org", "//example.org", "", "   ", undefined, ["https://a.org"], `https://a.org/${"x".repeat(300)}`]) {
    assert.equal(cleanHttpUrl(bad), null, JSON.stringify(bad));
  }
});
