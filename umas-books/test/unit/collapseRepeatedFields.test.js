const { test } = require("node:test");
const assert = require("node:assert/strict");
const { collapseRepeatedFields, MULTIPART_LIMITS, MULTIPART_RICH_TEXT_FIELD_SIZE } = require("../../src/lib/multiValueFields");

test("a repeated field collapses to its first value; a listed multi-value field stays a list", () => {
  const body = collapseRepeatedFields({ title: ["a", "b"], ids: ["1", "2"], ok: "x" });
  assert.deepEqual(body, { title: "a", ids: ["1", "2"], ok: "x" });
});

test("a nested value (multipart 'title[a]=x') is dropped, so .trim() never meets an object", () => {
  const body = collapseRepeatedFields({ title: { a: "x" }, name: [{ a: "x" }], keep: "y" });
  assert.deepEqual(body, { keep: "y" });
});

test("anything that is not an object is returned as it came", () => {
  assert.equal(collapseRepeatedFields(undefined), undefined);
  assert.equal(collapseRepeatedFields(null), null);
});

test("multipart limits are bounded and rich text gets more room than ordinary text", () => {
  assert.deepEqual(MULTIPART_LIMITS, { fields: 200, parts: 210, fieldSize: 64 * 1024 });
  assert.equal(MULTIPART_RICH_TEXT_FIELD_SIZE, 256 * 1024);
});
