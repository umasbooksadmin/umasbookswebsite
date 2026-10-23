#!/usr/bin/env node
// `npm run docs:env`: regenerates the documentation that comes from the setting registry
// (src/lib/configRegistry.js): the environment-variable tables of ARCHITECTURE.md (between the
// <!-- env-...:start --> / <!-- env-...:end --> markers) and the whole of .env.example.
// `--check` writes nothing and exits 1 when either file is stale (what the envInventory test asserts).
const fs = require("fs");
const path = require("path");
const { applyToArchitecture, renderEnvExample } = require("../src/lib/configDocs");

const ROOT = path.join(__dirname, "..");
const files = [
  [path.join(ROOT, "ARCHITECTURE.md"), (text) => applyToArchitecture(text)],
  [path.join(ROOT, ".env.example"), () => renderEnvExample()],
];

const check = process.argv.includes("--check");
let stale = 0;
for (const [file, render] of files) {
  const before = fs.readFileSync(file, "utf8");
  const after = render(before);
  if (before === after) continue;
  stale += 1;
  if (check) console.error(`${path.relative(ROOT, file)} is out of date: run npm run docs:env`);
  else {
    fs.writeFileSync(file, after);
    console.log(`updated ${path.relative(ROOT, file)}`);
  }
}
if (check && stale) process.exit(1);
if (!stale) console.log("env docs are up to date");
