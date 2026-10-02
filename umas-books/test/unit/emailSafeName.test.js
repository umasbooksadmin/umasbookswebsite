const { test } = require("node:test");
const assert = require("node:assert/strict");
const { emailSafeName } = require("../../src/lib/validation");

test("emailSafeName leaves ordinary names alone", () => {
  assert.equal(emailSafeName("Marie-Claire O'Neil"), "Marie-Claire O'Neil");
  assert.equal(emailSafeName("Zoë Müller 李"), "Zoë Müller 李");
});

test("emailSafeName strips http(s) and www URLs", () => {
  assert.equal(emailSafeName("Sam https://evil.example/pay?x=1 Smith"), "Sam Smith");
  assert.equal(emailSafeName("HTTP://EVIL.EXAMPLE"), "");
  assert.equal(emailSafeName("Click www.evil.example now"), "Click now");
});

test("emailSafeName strips control characters and angle brackets", () => {
  assert.equal(emailSafeName("Sam\r\nBcc: x@y.z"), "Sam Bcc: x@y.z");
  assert.equal(emailSafeName("a\u0000b\u0007c\u007fd"), "a b c d");
  assert.equal(emailSafeName("<b>Sam</b> <a@b.c>"), "b Sam /b a@b.c");
});

test("emailSafeName returns an empty string for non-strings", () => {
  assert.equal(emailSafeName(undefined), "");
  assert.equal(emailSafeName(["a"]), "");
  assert.equal(emailSafeName(null), "");
});
