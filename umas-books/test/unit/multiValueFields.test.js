// A route that reads a form field as a list must have that field in MULTI_VALUE_BODY_FIELDS (src/lib/multiValueFields.js),
// otherwise src/app.js collapses a repeated field to its first value and only one ticked box reaches the handler
// (the bug where "Save choices" on a collection kept one approved book).
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MULTI_VALUE_BODY_FIELDS } = require("../../src/lib/multiValueFields");

const ROUTES = path.join(__dirname, "..", "..", "src", "routes");
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith(".js") ? [path.join(dir, e.name)] : []));

test("every field a route reads as a list is in the multi-value allow-list", () => {
  const read = new Map();
  for (const f of files(ROUTES)) {
    const src = fs.readFileSync(f, "utf8");
    for (const m of src.matchAll(/\[\]\s*\.concat\(\s*req\.body\.(\w+)/g)) read.set(m[1], path.relative(ROUTES, f));
    for (const m of src.matchAll(/\blist\(\s*req\.body\.(\w+)/g)) read.set(m[1], path.relative(ROUTES, f)); // collections review helper
    for (const m of src.matchAll(/Array\.isArray\(\s*req\.body\.(\w+)\s*\)/g)) read.set(m[1], path.relative(ROUTES, f));
  }
  assert.ok(read.size >= 5, "the scan found the known list fields");
  const missing = [...read].filter(([name]) => !MULTI_VALUE_BODY_FIELDS.has(name)).map(([n, f]) => `${n} (${f})`);
  assert.deepEqual(missing, [], `list fields missing from src/lib/multiValueFields.js: ${missing.join(", ")}`);
});

test("the collection review checkboxes are named in the allow-list", () => {
  for (const n of ["approve", "reject", "ids"]) assert.ok(MULTI_VALUE_BODY_FIELDS.has(n), n);
});
