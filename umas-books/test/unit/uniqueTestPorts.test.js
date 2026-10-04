// Two test files that start a server on the same port talk to each other's
// app and database, which shows up as random login/404 failures. This keeps
// every `const PORT = N` / `port: N` in test/ unique.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}

test("no two test files use the same server port", () => {
  const seen = new Map();
  const clashes = [];
  for (const file of walk(path.join(__dirname, ".."))) {
    if (!file.endsWith(".test.js")) continue;
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/\bPORT = (\d{4})\b|\bport: (\d{4})\b/g)) {
      const port = m[1] || m[2];
      const rel = path.relative(path.join(__dirname, ".."), file);
      if (seen.has(port) && seen.get(port) !== rel) clashes.push(`${port}: ${seen.get(port)} and ${rel}`);
      seen.set(port, rel);
    }
  }
  assert.deepEqual(clashes, []);
});
