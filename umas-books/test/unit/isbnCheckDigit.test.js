// isValidIsbn (lib/bookLookup.js): the check digit of ISBN-10 / ISBN-13 is verified before any outside call.
// Cost caps PR: a made-up 13-digit number must not trigger catalog or paid ISBNdb requests.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isValidIsbn, normalizeIsbn, lookupByIsbnDetailed, lookupByIsbn, createTtlCache } = require("../../src/lib/bookLookup");
const { isbn13From, isbn10From } = require("../helpers/isbn");

test("valid ISBN-13 (978 and 979 prefixes) and ISBN-10 (including a final X) are accepted", () => {
  assert.equal(isValidIsbn("9780143127550"), true);
  assert.equal(isValidIsbn("9791090636071"), true, "979- prefix");
  assert.equal(isValidIsbn("0306406152"), true);
  assert.equal(isValidIsbn("080442957X"), true, "ISBN-10 ending in X");
  assert.equal(isValidIsbn(isbn10From("123456789")), true);
});

test("a wrong check digit, a wrong length or letters are refused", () => {
  assert.equal(isValidIsbn("9780143127551"), false, "last digit off by one");
  assert.equal(isValidIsbn("9780000000000"), false);
  assert.equal(isValidIsbn("0306406153"), false);
  assert.equal(isValidIsbn("080442957Y"), false);
  assert.equal(isValidIsbn("978014312755"), false, "12 digits");
  assert.equal(isValidIsbn("1234567890123"), false, "13 digits but not 978/979");
  assert.equal(isValidIsbn(""), false);
  assert.equal(isValidIsbn(null), false);
});

test("hyphenated, spaced and lower-case x forms are accepted once normalized", () => {
  for (const raw of ["978-0-14-312755-0", "978 0 14 312755 0", " 9780143127550 ", "0-8044-2957-x", "0 8044 2957 X"]) {
    assert.equal(isValidIsbn(normalizeIsbn(raw)), true, raw);
  }
});

test("normalizeIsbn itself stays loose (stored values and the till still use it)", () => {
  assert.equal(normalizeIsbn("123"), "123");
  assert.equal(normalizeIsbn("abc-9780000000000"), "9780000000000");
});

test("an invalid ISBN makes no outside call at all and answers state 'invalid'", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response("{}"); };
  const r = await lookupByIsbnDetailed("9780143127551", { fetchImpl, cache: createTtlCache() });
  assert.deepEqual([r.book, r.state], [null, "invalid"]);
  assert.equal(await lookupByIsbn("9780000000000", { fetchImpl, cache: createTtlCache() }), null);
  assert.equal(calls, 0);
});

test("a valid ISBN is looked up (the check passes it on)", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return new Response("{}"); };
  const r = await lookupByIsbnDetailed(isbn13From("978014312755"), { fetchImpl, cache: createTtlCache(), hedgeMs: 0, timeoutMs: 500 });
  assert.notEqual(r.state, "invalid");
  assert.ok(calls > 0);
});
