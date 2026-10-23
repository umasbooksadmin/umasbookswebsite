"use strict";

// Environment-variable guard. Every setting is declared ONCE in src/lib/configRegistry.js and read
// through src/lib/config.js; this test keeps the code, the registry and the generated documents honest:
//
//   1. no `process.env.NAME` / `env.NAME` / `env["NAME"]` read in src/ or scripts/ outside config.js,
//      except the few listed in RAW_READS below (each with its reason);
//   2. every name given to an accessor (config.get("NAME"), config.isSet(...)) is in the registry (a typo
//      would otherwise only show when that code runs), and every registry name is still used;
//   3. the ARCHITECTURE.md tables and .env.example are exactly what the registry renders
//      (`npm run docs:env` rewrites them);
//   4. the registry itself is well-formed (secrets are plain strings, documented, with a "where").
//
// Adding a setting is one edit: an entry in configRegistry.js, then `npm run docs:env`.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { REGISTRY } = require("../../src/lib/configRegistry");
const { applyToArchitecture, renderEnvExample } = require("../../src/lib/configDocs");

const ROOT = path.join(__dirname, "..", "..");
const NAME = "[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*";
const NAMES = new Set(REGISTRY.map((s) => s.name));

// Direct reads that are allowed to bypass the registry, with the reason. file -> { NAME: reason }.
const RAW_READS = {
  "src/lib/tz.js": { TZ: "reads and then sets TZ itself, before any other module loads (it must not depend on config.js's defaults)" },
  "scripts/bench-login-cpu.js": { PORT: "a benchmark with its own default port (4790), not the server's 3000" },
  "scripts/load-dashboard.js": {
    PGSSLMODE: "sets the variable for the app it is about to require (`x = x || 'disable'`), before config could matter",
  },
  "scripts/profile-scan.js": { ANTHROPIC_API_KEY: "sets a simulated key for the process it profiles (`x = x || 'sim'`)" },
};

const SKIP_FILES = new Set(["src/lib/config.js", "src/lib/configRegistry.js", "src/lib/configDocs.js"]);

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
const sources = () =>
  [...walk(path.join(ROOT, "src")), ...walk(path.join(ROOT, "scripts"))]
    .map((f) => ({ rel: path.relative(ROOT, f), text: fs.readFileSync(f, "utf8") }))
    .filter((f) => !SKIP_FILES.has(f.rel));

// Direct reads: process.env.X, env.X, env["X"], process.env["X"], `const { X } = process.env`.
// An assignment (`process.env.X = ...`, `env.X = ...`) is a write, not a read, and is ignored; so is `delete`.
function directReads(text) {
  const found = new Set();
  const patterns = [
    new RegExp(`(delete\\s+)?\\b(?:process\\.)?env\\.(${NAME})\\b(?!\\s*=[^=])`, "g"),
    new RegExp(`(delete\\s+)?\\b(?:process\\.)?env\\[\\s*["'](${NAME})["']\\s*\\](?!\\s*=[^=])`, "g"),
  ];
  for (const re of patterns) for (const m of text.matchAll(re)) if (!m[1]) found.add(m[2]);
  for (const m of text.matchAll(/\{([^}]*)\}\s*=\s*(?:process\.)?env\b/g)) {
    for (const part of m[1].split(",")) {
      const id = part.split(":")[0].trim();
      if (new RegExp(`^${NAME}$`).test(id)) found.add(id);
    }
  }
  return found;
}

test("the scanner sees a direct read in each form it claims to (so the guard cannot go blind)", () => {
  const seen = (src) => [...directReads(src)];
  assert.deepEqual(seen("const x = process.env.AI_DAILY_MAX_CALLS;"), ["AI_DAILY_MAX_CALLS"]);
  assert.deepEqual(seen("if (env.TILL_MAX_VOIDS_PER_DAY) {}"), ["TILL_MAX_VOIDS_PER_DAY"]);
  assert.deepEqual(seen('const v = env["DATABASE_URL"];'), ["DATABASE_URL"]);
  assert.deepEqual(seen("const { SESSION_SECRET, PORT: p } = process.env;"), ["SESSION_SECRET", "PORT"]);
  assert.deepEqual(seen("process.env.PGSSLMODE = 'disable'; delete process.env.GMAIL_USER;"), [], "writes are not reads");
  assert.ok(sources().length > 100, "the scan found too few files; it is broken");
});

test("no setting is read straight from the environment: everything goes through src/lib/config.js", () => {
  const unexpected = [];
  const used = new Map(); // file -> Set of allowlisted names actually found
  for (const { rel, text } of sources()) {
    for (const name of directReads(text)) {
      const reason = RAW_READS[rel] && RAW_READS[rel][name];
      if (reason) {
        if (!used.has(rel)) used.set(rel, new Set());
        used.get(rel).add(name);
      } else unexpected.push(`${rel} reads ${name} directly`);
    }
  }
  assert.deepEqual(unexpected, [], `Use config.get("NAME", env) (declare NAME in src/lib/configRegistry.js first), or add an entry with a reason to RAW_READS:\n  ${unexpected.join("\n  ")}`);
  const stale = [];
  for (const [file, names] of Object.entries(RAW_READS)) {
    for (const name of Object.keys(names)) if (!(used.get(file) && used.get(file).has(name))) stale.push(`${file}: ${name}`);
  }
  assert.deepEqual(stale, [], `RAW_READS lists reads that no longer exist: remove them:\n  ${stale.join("\n  ")}`);
});

test("every setting name handed to config.* is declared, and every declared name is still used", () => {
  const re = new RegExp(`\\bconfig\\.(?:get|read|isSet|specFor)\\(\\s*["'](${NAME})["']`, "g");
  const used = new Set();
  const bad = [];
  const all = sources();
  for (const { rel, text } of all) {
    for (const m of text.matchAll(re)) {
      used.add(m[1]);
      if (!NAMES.has(m[1])) bad.push(`${rel}: ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], `these names are not in src/lib/configRegistry.js (a typo, or add the entry):\n  ${bad.join("\n  ")}`);
  // a name also counts as used when it appears as a string literal outside the registry (env.js group lists, staging.js ...)
  const literal = (name) => all.some(({ text }) => new RegExp(`["']${name}["']`).test(text));
  const raw = new Set(Object.values(RAW_READS).flatMap((o) => Object.keys(o)));
  const unused = REGISTRY.filter((s) => s.scope !== "workflow" && !used.has(s.name) && !raw.has(s.name) && !literal(s.name)).map((s) => s.name);
  assert.deepEqual(unused, [], `declared in the registry but never read by src/ or scripts/ (remove the entry, or set scope: "workflow" if only a GitHub workflow uses it):\n  ${unused.join("\n  ")}`);
});

test("every GitHub workflow variable and secret is in the registry", () => {
  const dir = path.join(ROOT, "..", ".github", "workflows");
  const missing = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith(".yml"))) {
    const text = fs.readFileSync(path.join(dir, f), "utf8");
    for (const m of text.matchAll(new RegExp(`\\b(vars|secrets)\\.(${NAME})\\b`, "g"))) {
      const spec = REGISTRY.find((s) => s.name === m[2]);
      const wantKind = m[1] === "secrets" ? "secret" : "variable";
      if (!spec || !spec.github || spec.github.kind !== wantKind) missing.push(`${f}: ${m[1]}.${m[2]}`);
    }
  }
  assert.deepEqual([...new Set(missing)], [], "declare these in configRegistry.js with a `github: { kind, usedBy, doc }` field");
});

test("ARCHITECTURE.md's environment tables are exactly what the registry renders (run `npm run docs:env`)", () => {
  const current = fs.readFileSync(path.join(ROOT, "ARCHITECTURE.md"), "utf8");
  assert.equal(applyToArchitecture(current), current, "ARCHITECTURE.md is stale: run `npm run docs:env` and commit the result");
  assert.ok(current.includes("\n## Environment variables"), "ARCHITECTURE.md has no '## Environment variables' section");
});

test(".env.example is exactly what the registry renders (run `npm run docs:env`)", () => {
  const current = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  assert.equal(renderEnvExample(), current, ".env.example is stale: run `npm run docs:env` and commit the result");
});

test(".env.example lists no variable twice, holds no real-looking secret, and lists every variable but the documented exceptions", () => {
  const example = fs.readFileSync(path.join(ROOT, ".env.example"), "utf8");
  const names = [...example.matchAll(new RegExp(`^\\s*#?\\s*(${NAME})=`, "gm"))].map((m) => m[1]);
  assert.deepEqual([...new Set(names.filter((n, i) => names.indexOf(n) !== i))], [], "duplicate entries in .env.example");
  for (const line of example.split("\n")) assert.ok(!/(sk-ant-|ghp_|AKIA[0-9A-Z]{12}|-----BEGIN)/.test(line), `looks like a real secret: ${line.slice(0, 40)}`);
  const missing = REGISTRY.filter((s) => s.scope !== "workflow" && !s.exampleSkip && !names.includes(s.name)).map((s) => s.name);
  assert.deepEqual(missing, [], "give these an `example` (or an `exampleSkip` reason) in configRegistry.js");
});

test("the registry is well-formed", () => {
  const seen = new Set();
  const WHERE = ["render", "github-variable", "github-secret", "both", "render-auto", "local", "tests", "ci", "code"];
  for (const s of REGISTRY) {
    assert.match(s.name, new RegExp(`^${NAME}$`), `bad name ${s.name}`);
    assert.ok(!seen.has(s.name), `${s.name} is declared twice`);
    seen.add(s.name);
    assert.ok(["string", "int", "ms", "flag"].includes(s.kind), `${s.name}: kind`);
    assert.ok(["app", "script", "workflow"].includes(s.scope), `${s.name}: scope`);
    assert.ok(typeof s.secret === "boolean", `${s.name}: secret must be true or false`);
    assert.ok(WHERE.includes(s.where), `${s.name}: where is one of ${WHERE.join(", ")}`);
    assert.ok(typeof s.doc === "string" && s.doc.length > 10, `${s.name}: doc`);
    if (s.secret) assert.equal(s.kind, "string", `${s.name}: a secret must be a string setting (number and flag messages quote the bad value)`);
    if (s.scope !== "workflow") {
      assert.ok(s.whereText && s.defaultText !== undefined, `${s.name}: whereText and defaultText feed the ARCHITECTURE.md table`);
      assert.ok(s.example !== undefined || s.exampleSkip, `${s.name}: example or exampleSkip`);
    }
    if (s.github) assert.ok(["secret", "variable"].includes(s.github.kind) && s.github.usedBy && s.github.doc, `${s.name}: github`);
    if (s.kind === "flag") assert.ok(Array.isArray(s.onWords) && s.onWords.length, `${s.name}: a flag lists its onWords`);
    if (s.group) assert.ok(["mail", "helloasso"].includes(s.group), `${s.name}: group`);
    if (s.example) assert.ok(!/(sk-ant-|ghp_|AKIA|-----BEGIN)/.test(s.example), `${s.name}: example looks like a real secret`);
  }
});

test("required variables and optional groups come from the registry, in the order env.js always reported them", () => {
  const env = require("../../src/lib/env");
  assert.deepEqual(env.REQUIRED, ["DATABASE_URL", "SESSION_SECRET", "TOTP_ENCRYPTION_KEY"]);
  assert.deepEqual(env.OPTIONAL_GROUPS.map((g) => g.vars), [["GMAIL_USER", "GMAIL_APP_PASSWORD"], ["HELLOASSO_CLIENT_ID", "HELLOASSO_CLIENT_SECRET", "HELLOASSO_ORG_SLUG"]]);
});
