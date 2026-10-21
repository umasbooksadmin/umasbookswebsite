const { test } = require("node:test");
const assert = require("node:assert/strict");
const { parseIntParam, parseLimitParam, parseIdList, escapeLike, likeContains, INT4_MAX } = require("../../src/lib/parseParams");

test("parseIntParam: plain digits inside the range are returned as numbers", () => {
  assert.equal(parseIntParam("0"), 0);
  assert.equal(parseIntParam("24", { min: 1, max: 48, default: 24 }), 24);
  assert.equal(parseIntParam("007"), 7);
  assert.equal(parseIntParam(12), 12); // a JSON body number
});

test("parseIntParam: garbage, arrays, exponents, hex, whitespace and decimals give the default", () => {
  const opts = { min: 1, max: 48, default: 24 };
  for (const bad of [undefined, null, "", "abc", "1e3", "1e21", "0x10", " 5", "5 ", "1.5", "+3", "--1", "5;", ["1", "2"], ["1"], {}, true, NaN, Infinity, 1.5, 1e22]) {
    assert.equal(parseIntParam(bad, opts), 24, `bad value ${JSON.stringify(bad)}`);
  }
});

test("parseIntParam: out-of-range numbers clamp to the nearest end, however many digits", () => {
  assert.equal(parseIntParam("0", { min: 1, max: 48, default: 24 }), 1);
  assert.equal(parseIntParam("-1", { min: 1, max: 48, default: 24 }), 1);
  assert.equal(parseIntParam("49", { min: 1, max: 48, default: 24 }), 48);
  assert.equal(parseIntParam("99999999999999999999", { max: 100000 }), 100000);
  assert.equal(parseIntParam("9".repeat(400), { max: 100000 }), 100000);
  assert.equal(parseIntParam("-" + "9".repeat(400), { min: -5, max: 5 }), -5);
  assert.equal(parseIntParam("9".repeat(401), { max: 100000, default: 3 }), 3); // longer than any real number: garbage
  assert.equal(parseIntParam("2147483648"), INT4_MAX);
});

test("parseIntParam: clamp:false answers the default for an out-of-range number", () => {
  assert.equal(parseIntParam("500", { min: 1, max: 48, default: 24, clamp: false }), 24);
  assert.equal(parseIntParam("10", { min: 1, max: 48, default: 24, clamp: false }), 10);
});

test("parseIntParam: the default is the minimum unless given", () => {
  assert.equal(parseIntParam("x", { min: 3 }), 3);
  assert.equal(parseIntParam(undefined), 0);
  assert.equal(parseIntParam("x", { default: null }), null);
});

test("parseIdList keeps valid distinct int4 ids only and caps the count", () => {
  assert.deepEqual(parseIdList("1,2,3"), [1, 2, 3]);
  assert.deepEqual(parseIdList(" 4 , 4,5 "), [4, 5]);
  assert.deepEqual(parseIdList("0,-1,abc,1.5,1e3,0x10,99999999999,2147483648,2147483647"), [2147483647]);
  assert.deepEqual(parseIdList(["1", "2"]), []);
  assert.deepEqual(parseIdList(undefined), []);
  assert.equal(parseIdList(Array.from({ length: 1000 }, (_, i) => i + 1).join(",")).length, 200);
  assert.equal(parseIdList("1,2,3,4", { maxCount: 2 }).length, 2);
});

test("escapeLike makes % _ and backslash literal", () => {
  assert.equal(escapeLike("__"), "\\_\\_");
  assert.equal(escapeLike("100%"), "100\\%");
  assert.equal(escapeLike("a\\b"), "a\\\\b");
  assert.equal(escapeLike("plain text"), "plain text");
  assert.equal(likeContains("a_b"), "%a\\_b%");
});

test("parseLimitParam: default for absent, garbage and 0; 1 for negatives; capped at max", () => {
  const o = { max: 48, default: 24 };
  assert.deepEqual(["", "abc", "0", "1e3", ["1", "2"]].map((v) => parseLimitParam(v, o)), [24, 24, 24, 24, 24]);
  assert.deepEqual(["-4", "1", "30", "48", "49", "99999999999999999999"].map((v) => parseLimitParam(v, o)), [1, 1, 30, 48, 48, 48]);
});
