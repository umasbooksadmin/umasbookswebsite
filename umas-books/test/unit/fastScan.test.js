// src/lib/fastScan.js: the defaults of a fresh "Add a book" form.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { BINDINGS } = require("../../src/lib/inventory");
const { firstUseBinding, formDefaults, carryQuery, rememberedBinding, DEFAULT_LOCATION, DEFAULT_SOURCE } = require("../../src/lib/fastScan");

test("a fresh form starts at Store and Donation", () => {
  const d = formDefaults({});
  assert.equal(d.location, "STORE");
  assert.equal(DEFAULT_LOCATION, "STORE");
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
  assert.equal(d.location, "FICTION A1");
  assert.equal(d.locationQueried, true);
  assert.equal(d.binding, "hardcover");
  assert.equal(d.condition, "good");
  assert.equal(formDefaults({ location: "   " }).location, "STORE");
});

test("an unknown binding or condition in the query is ignored", () => {
  assert.equal(formDefaults({ binding: "spiral" }).binding, firstUseBinding());
  assert.equal(formDefaults({ binding: "spiral" }).queried.binding, false);
  assert.equal(rememberedBinding("spiral"), null);
  assert.equal(rememberedBinding(""), null);
  assert.equal(rememberedBinding(undefined), null);
});

test("the carry query keeps location, source, binding and condition", () => {
  const q = new URLSearchParams(carryQuery({ location: "STORE", binding: "hardcover", condition: "very_good", copyId: 7, requests: 0, source: "lot" }));
  assert.equal(q.get("saved"), "7");
  assert.equal(q.get("location"), "STORE");
  assert.equal(q.get("binding"), "hardcover");
  assert.equal(q.get("condition"), "very_good");
  assert.equal(q.get("source"), "lot");
  assert.equal(q.has("requests"), false);
  assert.equal(new URLSearchParams(carryQuery({ copyId: 3, requests: 2 })).get("requests"), "2");
});
