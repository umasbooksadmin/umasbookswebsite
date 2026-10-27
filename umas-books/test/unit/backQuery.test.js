const { test } = require("node:test");
const assert = require("node:assert/strict");
const { makeBackQuery, oneOf, text, pageNumber } = require("../../src/lib/backQuery");

const back = makeBackQuery({ status: oneOf(["draft", "published"]), q: text(100), page: pageNumber });

test("known keys with valid values are kept, in the spec's order, and encoded", () => {
  assert.equal(back("q=hello world&status=draft&page=007"), "?status=draft&q=hello+world&page=7");
  assert.equal(back("?status=published"), "?status=published");
});

test("nothing usable gives an empty string", () => {
  for (const v of [undefined, null, "", 5, ["status=draft"], {}, "status=nope", "page=0", "page=abc", "unknown=1"]) assert.equal(back(v), "", String(v));
});

test("extra parameters, a fragment, a leading // and a path are never carried over", () => {
  assert.equal(back("status=draft&redirect=//evil.example&x=1#frag"), "?status=draft");
  assert.equal(back("//evil.example/?status=draft"), "");
  assert.equal(back("&returnTo=/admin&status=draft"), "?status=draft");
});

test("CR/LF in a value is percent-encoded, so it can not split the header or the URL", () => {
  const out = back("q=a%0d%0aLocation:%20//evil.example%0a&status=draft%0d%0a");
  assert.ok(!/[\r\n]/.test(out), "no raw CR or LF");
  assert.ok(!out.includes("status"), "a status with a newline is not a valid status");
  assert.equal(out, "?q=a%0D%0ALocation%3A+%2F%2Fevil.example");
});

test("a long string is cut: the text at 100 characters, the whole input at 500", () => {
  const out = back(`q=${"x".repeat(5000)}`);
  assert.equal(out, `?q=${"x".repeat(100)}`);
  assert.equal(back(`${"a=1&".repeat(200)}q=late`), "");
});

test("only the first occurrence of a key counts", () => {
  assert.equal(back("status=nope&status=draft"), "");
  assert.equal(back("status=draft&status=published"), "?status=draft");
});
