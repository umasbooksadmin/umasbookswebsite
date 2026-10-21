"use strict";

// .github/scripts/ci-changes.sh decides how much of CI a pull request needs
// (docs-only -> skip the slow steps; smoke-crawl only when the site can be
// affected). And static guards on ci.yml: the six required check names still
// exist, every one still always runs (no workflow-level `paths:` filter, which
// would leave required checks "Pending" and block merges).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repo = path.join(__dirname, "..", "..", "..");
const script = path.join(repo, ".github", "scripts", "ci-changes.sh");
const ci = fs.readFileSync(path.join(repo, ".github", "workflows", "ci.yml"), "utf8");

function decide(files, event = "pull_request") {
  const outFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cichanges-")), "out");
  fs.writeFileSync(outFile, "");
  const env = { ...process.env, GITHUB_OUTPUT: outFile, GITHUB_EVENT_NAME: event };
  delete env.CHANGED_FILES;
  if (files !== null) env.CHANGED_FILES = files.join("\n");
  const r = spawnSync("bash", [script], { env, encoding: "utf8", cwd: os.tmpdir() });
  assert.equal(r.status, 0, r.stderr);
  const out = Object.fromEntries(fs.readFileSync(outFile, "utf8").trim().split("\n").map((l) => l.split("=")));
  return out;
}

test("documentation-only changes: docs_only, no smoke crawl", () => {
  assert.deepEqual(decide(["docs/runbook.md"]), { docs_only: "true", smoke_needed: "false" });
  assert.deepEqual(decide(["README.md", "umas-books/ARCHITECTURE.md", "docs/privacy/x.md"]), { docs_only: "true", smoke_needed: "false" });
});

test("code, views, public, migrations, scripts or marketing pages: smoke crawl runs", () => {
  for (const f of ["umas-books/src/index.js", "umas-books/views/cart.ejs", "umas-books/public/style.css", "umas-books/migrations/081_x.sql",
    "umas-books/scripts/sitemap/crawler.js", "umas-books/package-lock.json", "index.html", "assets/site.js", ".github/workflows/ci.yml", "render.yaml"]) {
    assert.deepEqual(decide([f]), { docs_only: "false", smoke_needed: "true" }, f);
  }
});

test("a tests-only change runs lint/test/migration but not the smoke crawl", () => {
  assert.deepEqual(decide(["umas-books/test/unit/x.test.js"]), { docs_only: "false", smoke_needed: "false" });
});

test("docs plus code: everything runs", () => {
  assert.deepEqual(decide(["docs/runbook.md", "umas-books/src/lib/x.js"]), { docs_only: "false", smoke_needed: "true" });
});

test("anything but a pull request, or no file list: everything runs", () => {
  assert.deepEqual(decide(null, "push"), { docs_only: "false", smoke_needed: "true" });
  assert.deepEqual(decide(null, "workflow_dispatch"), { docs_only: "false", smoke_needed: "true" });
  assert.deepEqual(decide([""], "pull_request"), { docs_only: "false", smoke_needed: "true" });
});

test("ci.yml keeps the six required checks, always running, with no workflow-level path filter", () => {
  const jobNames = [...ci.matchAll(/^ {2}([a-z-]+):\n {4}(?:#[^\n]*\n {4})*runs-on:/gm)].map((m) => m[1]);
  assert.deepEqual(jobNames.sort(), ["dependency-audit", "lint", "migration-test", "secret-scan", "smoke-crawl", "test"]);
  const onBlock = ci.slice(ci.indexOf("\non:"), ci.indexOf("\npermissions:")).replace(/#[^\n]*/g, "");
  assert.doesNotMatch(onBlock, /paths(-ignore)?:/, "a workflow skipped by paths: leaves required checks Pending and blocks merges");
  assert.match(ci, /concurrency:\n {2}group: ci-.*\n {2}cancel-in-progress: true/);
  // no job-level `if:` (a skipped job would be reported differently from a passed one)
  for (const m of ci.matchAll(/^ {2}[a-z-]+:\n((?: {4}[^\n]*\n|\n)+)/gm)) assert.doesNotMatch(m[1], /^ {4}if:/m);
  // the slow jobs decide inside the job
  for (const name of ["lint", "test", "migration-test", "dependency-audit", "smoke-crawl"]) {
    const block = ci.slice(ci.indexOf(`\n  ${name}:\n`)).split(/\n {2}[a-z-]+:\n/)[1];
    assert.match(block, /id: changes/, `${name} decides inside the job`);
  }
  assert.match(ci, /ci-changes\.sh/);
});

test("test (12 min) and smoke-crawl (20 min) jobs have sensible limits, and the test job reports its duration", () => {
  const block = (name) => ci.slice(ci.indexOf(`\n  ${name}:\n`)).split(/\n {2}[a-z-]+:\n/)[1];
  assert.match(block("test"), /timeout-minutes: 12\b/);
  assert.match(block("smoke-crawl"), /timeout-minutes: 20\b/);
  assert.match(block("test"), /job limit: 12m/, "the summary line names the real limit");
  assert.match(block("test"), /Test suite duration[\s\S]*GITHUB_STEP_SUMMARY/);
  assert.match(block("test"), /exit "\$status"/, "the suite's exit code is preserved");
});

test("smoke-crawl keeps the puppeteer and npm caches", () => {
  assert.match(ci, /path: ~\/\.cache\/puppeteer/);
  assert.ok((ci.match(/cache: npm/g) || []).length >= 5);
});
