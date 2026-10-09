// src/lib/fastScan.js: the defaults of a fresh "Add a book" form.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { BINDINGS } = require("../../src/lib/inventory");
const { firstUseBinding, formDefaults, carryQuery, rememberedBinding, DEFAULT_LOCATION, DEFAULT_SOURCE } = require("../../src/lib/fastScan");

test("a fresh form starts at Store and Donation", () => {
  const d = formDefaults({});
  assert.equal(d.location, "Store");
  assert.equal(DEFAULT_LOCATION, "Store");
  assert.equal(d.locationQueried, false);
  assert.equal(d.source, "donation");
  assert.equal(DEFAULT_SOURCE, "donation");
  assert.equal(d.binding, firstUseBinding(), "first ever: the last option of the binding list");
  assert.equal(firstUseBinding(), BINDINGS[BINDINGS.length - 1].value);
  assert.equal(d.condition, null);
  assert.deepEqual(d.queried, { binding: false, source: false, condition: false }, "nothing carried: the browser's memory may fill in");
});

test("a location, source, binding and condition in the query (the last entry) replace the starting values", () => {
  const d = formDefaults({ location: " fiction  a1 ", binding: "hardcover", condition: "good", source: "lot" });
  assert.equal(d.source, "lot");
  assert.deepEqual(d.queried, { binding: true, source: true, condition: true });
  assert.equal(d.location, "fiction a1", "capitals are kept as typed");
  assert.equal(d.locationQueried, true);
  assert.equal(d.binding, "hardcover");
  assert.equal(d.condition, "good");
  assert.equal(formDefaults({ location: "   " }).location, "Store");
});

test("an unknown binding or condition in the query is ignored", () => {
  assert.equal(formDefaults({ binding: "spiral" }).binding, firstUseBinding());
  assert.equal(formDefaults({ binding: "spiral" }).queried.binding, false);
  assert.equal(rememberedBinding("spiral"), null);
  assert.equal(rememberedBinding(""), null);
  assert.equal(rememberedBinding(undefined), null);
});

test("the carry query keeps location, source, binding and condition", () => {
  const q = new URLSearchParams(carryQuery({ location: "Store", binding: "hardcover", condition: "very_good", copyId: 7, requests: 0, source: "lot" }));
  assert.equal(q.get("saved"), "7");
  assert.equal(q.get("location"), "Store");
  assert.equal(q.get("binding"), "hardcover");
  assert.equal(q.get("condition"), "very_good");
  assert.equal(q.get("source"), "lot");
  assert.equal(q.has("requests"), false);
  assert.equal(new URLSearchParams(carryQuery({ copyId: 3, requests: 2 })).get("requests"), "2");
});

test("the last copy an admin saved is the starting point; the query wins; Store, Donation, Other only when there is nothing", () => {
  const last = { location: "fiction a1", source: "purchase", condition: "good", binding: "hardcover" };
  const d = formDefaults({}, last);
  assert.deepEqual([d.location, d.source, d.binding, d.condition], ["fiction a1", "purchase", "hardcover", "good"]);
  assert.equal(d.locationQueried, false, "still replaceable by the browser's own memory");
  assert.deepEqual(d.queried, { binding: false, source: false, condition: false });
  const q = formDefaults({ location: "poetry", source: "lot" }, last);
  assert.deepEqual([q.location, q.source, q.binding], ["poetry", "lot", "hardcover"]);
  // Missing or unusable pieces of the last copy fall back one by one.
  const partial = formDefaults({}, { location: null, source: null, condition: "pristine", binding: "spiral" });
  assert.deepEqual([partial.location, partial.source, partial.binding, partial.condition], ["Store", "donation", firstUseBinding(), "very_good"]);
  assert.deepEqual(formDefaults({}, {}), formDefaults({}));
});
