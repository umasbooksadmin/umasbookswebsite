// A form field that arrives more than once (a checkbox list) must be on the allow-list of src/lib/multiValueFields.js,
// or app.js collapses it to its first value and a "tick three" form silently saves one. This reads the views and the
// routes and fails when a repeated field is not listed (and when app.js stops using the list).

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { MULTI_VALUE_BODY_FIELDS } = require("../../src/lib/multiValueFields");

const ROOT = path.join(__dirname, "..", "..");
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

test("app.js collapses repeated fields except the ones on the allow-list", () => {
  const app = fs.readFileSync(path.join(ROOT, "src", "app.js"), "utf8");
  assert.ok(app.includes('require("./lib/multiValueFields")'));
  assert.ok(/collapseRepeatedFields\(req\.body\)/.test(app));
  const lib = fs.readFileSync(path.join(ROOT, "src", "lib", "multiValueFields.js"), "utf8");
  assert.ok(/!MULTI_VALUE_BODY_FIELDS\.has\(key\)/.test(lib));
});

test("every checkbox rendered in a loop, and every field a route reads as a list, is on the allow-list", () => {
  const missing = [];
  for (const file of walk(path.join(ROOT, "views")).filter((f) => f.endsWith(".ejs"))) {
    const lines = fs.readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      const m = line.match(/<input[^>]*type="checkbox"[^>]*name="(\w+)"|<input[^>]*name="(\w+)"[^>]*type="checkbox"/);
      if (!m) return;
      const name = m[1] || m[2];
      // inside a loop: a forEach / for opened on this or the previous line (or earlier in the line) and not closed again before the checkbox
      const before = lines.slice(Math.max(0, i - 2), i).join("\n") + "\n" + line.slice(0, line.indexOf("<input"));
      const open = Math.max(before.lastIndexOf(".forEach("), before.lastIndexOf("for ("));
      const inLoop = open >= 0 && !/\}\)\s*%>|<%\s*\}\s*%>/.test(before.slice(open));
      if (inLoop && !MULTI_VALUE_BODY_FIELDS.has(name)) missing.push(`${path.relative(ROOT, file)}:${i + 1} ${name}`);
    });
  }
  for (const file of walk(path.join(ROOT, "src", "routes")).filter((f) => f.endsWith(".js"))) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/\[\]\.concat\(\s*req\.body\.(\w+)/g)) {
      if (!MULTI_VALUE_BODY_FIELDS.has(m[1])) missing.push(`${path.relative(ROOT, file)} reads req.body.${m[1]} as a list`);
    }
  }
  assert.deepEqual(missing, [], "add these field names to src/lib/multiValueFields.js");
});

test("the Genres page's AI proposals use a repeated checkbox that is on the list", () => {
  assert.ok(MULTI_VALUE_BODY_FIELDS.has("accept"));
  const view = fs.readFileSync(path.join(ROOT, "views", "admin", "genres.ejs"), "utf8");
  assert.ok(view.includes('type="checkbox" name="accept"'));
});
