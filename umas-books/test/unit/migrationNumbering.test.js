"use strict";

// Migration hygiene. migrate.js applies files in FILENAME order, so two files
// with the same number prefix (two branches that both took "066"), or a
// number that goes backwards, apply in an order nobody chose; a new file that
// sorts BEFORE an already-applied one is silently skipped on an old database
// or runs before its dependencies on a new one.
//
//  - every file is NNN_name.sql with a 3-digit number;
//  - no number is used twice;
//  - numbers increase with the filename order (the order migrate.js applies them);
//  - the newest file has the highest number;
//  - gaps are allowed (abandoned branches), but only the KNOWN ones below: a new
//    gap is almost always a number taken by a branch that is still open or lost.
//
// Known gaps (never used on main): 049, 051, 052, 061, 064.
// 067, 069-073 were reserved by branches that renumbered or never used them; 077-079 are
// taken by branches that were still open when this list was written. They may stay
// missing, or be filled later (filling a listed gap is fine).
// If you really must skip a number on purpose, add it to KNOWN_GAPS here in the same PR.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const dir = path.join(__dirname, "..", "..", "migrations");
const KNOWN_GAPS = new Set([49, 51, 52, 61, 64, 67, 69, 70, 71, 72, 73, 77, 78, 79]);

const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();

test("every migration file is named NNN_something.sql", () => {
  assert.ok(files.length > 0);
  for (const f of files) assert.match(f, /^\d{3}_[a-z0-9_]+\.sql$/, `${f}: use a 3-digit number, then lowercase words joined by underscores`);
});

test("migration numbers are unique and strictly increasing in filename order", () => {
  const numbers = files.map((f) => Number(f.slice(0, 3)));
  for (let i = 1; i < numbers.length; i++) {
    assert.ok(numbers[i] !== numbers[i - 1], `duplicate migration number ${files[i].slice(0, 3)}: ${files[i - 1]} and ${files[i]} (rebase and renumber the newer one)`);
    assert.ok(numbers[i] > numbers[i - 1], `${files[i]} does not come after ${files[i - 1]}`);
  }
  assert.equal(new Set(numbers).size, numbers.length);
});

test("the newest file has the highest number", () => {
  const numbers = files.map((f) => Number(f.slice(0, 3)));
  assert.equal(Number(files[files.length - 1].slice(0, 3)), Math.max(...numbers));
});

test("the only gaps in the numbering are the known ones", () => {
  const numbers = new Set(files.map((f) => Number(f.slice(0, 3))));
  const max = Math.max(...numbers);
  const gaps = [];
  for (let n = 1; n <= max; n++) if (!numbers.has(n)) gaps.push(n);
  const unexpected = gaps.filter((n) => !KNOWN_GAPS.has(n));
  assert.deepEqual(unexpected, [], `unexpected gap(s) in the migration numbers: ${unexpected.join(", ")}. A number was skipped: add it to KNOWN_GAPS only if that is deliberate.`);
  // (a listed gap may be filled later: that is fine, so nothing is asserted about it)
});
