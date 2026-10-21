"use strict";

// Environment-variable inventory guard. Every variable the code reads in src/
// and scripts/ must be listed in the ARCHITECTURE.md "Environment variables"
// section and in .env.example, so the documented inventory cannot drift again.
//
// Reads are found in the forms the code really uses (a plain
// `grep process.env.X` misses most of the second and third):
//   process.env.NAME   env.NAME   env["NAME"]   process.env["NAME"]
//   readNumber(env, "NAME")  isSet(env, "NAME")  (any call with `env,` then a literal)
//   envNumber("NAME", ...)   envMs("NAME", ...)  (any *env*( "NAME" ... ) helper)
//   const { A, B } = process.env   (destructured reads)

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const NAME = "[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*";

// Variables that are real reads but need no row in .env.example (the table in
// ARCHITECTURE.md still has them). Each with its reason.
const NOT_IN_ENV_EXAMPLE = {
  TZ: "forced to Europe/Paris by src/lib/tz.js; nobody sets it",
  CI: "set by GitHub Actions",
  GITHUB_OUTPUT: "set by GitHub Actions",
  DEBUG_BLOBS: "debug switch of one scripts/ image tool",
  DUMP_FILE: "output path of scripts/i18n-audit.js",
  DUMP_EN_FILE: "output path of scripts/i18n-audit.js",
};
// Names that look like variables to the scanner but are not (none today).
const NOT_VARIABLES = {};

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      walk(full, out);
    } else if (entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}

function variablesRead() {
  const found = new Map(); // name -> first file
  const add = (name, file) => { if (!(name in NOT_VARIABLES) && !found.has(name)) found.set(name, path.relative(ROOT, file)); };
  const patterns = [
    new RegExp(`\\benv\\.(${NAME})\\b`, "g"),
    new RegExp(`\\benv\\[\\s*["'](${NAME})["']\\s*\\]`, "g"),
    new RegExp(`\\benv,\\s*["'](${NAME})["']`, "g"),
    new RegExp(`\\b\\w*[eE]nv\\w*\\(\\s*["'](${NAME})["']`, "g"),
  ];
  for (const file of [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "scripts"))]) {
    const text = fs.readFileSync(file, "utf8");
    for (const re of patterns) for (const m of text.matchAll(re)) add(m[1], file);
    for (const m of text.matchAll(/\{([^}]*)\}\s*=\s*(?:process\.)?env\b/g)) {
      for (const part of m[1].split(",")) {
        const id = part.split(":")[0].trim();
        if (new RegExp(`^${NAME}$`).test(id)) add(id, file);
      }
    }
  }
  return found;
}

function envSectionOfArchitecture() {
  const text = fs.readFileSync(path.join(ROOT, "ARCHITECTURE.md"), "utf8");
  const start = text.indexOf("\n## Environment variables");
  assert.ok(start >= 0, "ARCHITECTURE.md has no '## Environment variables' section");
  const end = text.indexOf("\n## ", start + 5);
  return text.slice(start, end < 0 ? undefined : end);
}

test("the scanner finds the variables it is known to miss with a plain grep", () => {
  const vars = variablesRead();
  for (const n of ["TOTP_ENCRYPTION_KEY", "AI_DAILY_MAX_CALLS", "ADMIN_SESSION_IDLE_HOURS", "SCAN_PRICE_WAIT_MS", "TILL_MAX_VOIDS_PER_DAY", "DATABASE_URL"]) {
    assert.ok(vars.has(n), `scanner no longer finds ${n}: the guard would be blind`);
  }
  assert.ok(vars.size >= 60, `only ${vars.size} variables found; the scanner is broken`);
});

test("every variable read in src/ and scripts/ is in the ARCHITECTURE.md environment table", () => {
  const section = envSectionOfArchitecture();
  const documented = new Set([...section.matchAll(new RegExp("`(" + NAME + ")`", "g"))].map((m) => m[1]));
  const missing = [...variablesRead()].filter(([n]) => !documented.has(n)).map(([n, f]) => `${n} (read in ${f})`);
  assert.deepEqual(missing, [], `Add these to the "Environment variables" table in ARCHITECTURE.md:\n  ${missing.join("\n  ")}`);
});

test("every variable read in src/ and scripts/ is in .env.example (as a line or a commented placeholder)", () => {
  const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  const listed = new Set([...example.matchAll(new RegExp(`^\\s*#?\\s*(${NAME})=`, "gm"))].map((m) => m[1]));
  const missing = [...variablesRead()].filter(([n]) => !listed.has(n) && !(n in NOT_IN_ENV_EXAMPLE)).map(([n, f]) => `${n} (read in ${f})`);
  assert.deepEqual(missing, [], `Add these to .env.example (a commented "# NAME=" line is enough):\n  ${missing.join("\n  ")}`);
});

test(".env.example lists no variable twice and holds no real-looking secret", () => {
  const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  const names = [...example.matchAll(new RegExp(`^\\s*#?\\s*(${NAME})=`, "gm"))].map((m) => m[1]);
  const dup = names.filter((n, i) => names.indexOf(n) !== i);
  assert.deepEqual([...new Set(dup)], [], "duplicate entries in .env.example");
  for (const line of example.split("\n")) {
    assert.ok(!/(sk-ant-|ghp_|AKIA[0-9A-Z]{12}|-----BEGIN)/.test(line), `looks like a real secret: ${line.slice(0, 40)}`);
  }
});

test("every allowlist entry is still a real read (no stale exemptions)", () => {
  const vars = variablesRead();
  for (const n of Object.keys(NOT_IN_ENV_EXAMPLE)) assert.ok(vars.has(n), `${n} is allowlisted but no longer read: remove it`);
});
