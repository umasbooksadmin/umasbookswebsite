"use strict";

// Static guards on every GitHub workflow: they parse as the structure
// Actions expects, every third-party action stays pinned to a full commit
// SHA, and the monitoring workflows keep the properties that matter.
// (No YAML library is a dependency, so this checks the shape textually.)

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const wfDir = path.join(__dirname, "..", "..", "..", ".github", "workflows");
const files = fs.readdirSync(wfDir).filter((f) => /\.ya?ml$/.test(f));
const read = (f) => fs.readFileSync(path.join(wfDir, f), "utf8");

test("there are workflows to check", () => {
  assert.ok(files.length >= 6);
});

test("every workflow has the top-level keys Actions requires and no tab indentation", () => {
  for (const f of files) {
    const src = read(f);
    assert.match(src, /^name: .+$/m, `${f}: name`);
    assert.match(src, /^on:\s*$/m, `${f}: on`);
    assert.match(src, /^jobs:\s*$/m, `${f}: jobs`);
    assert.doesNotMatch(src, /^\t/m, `${f}: tab indentation is invalid YAML`);
    assert.match(src, /^ {2}[\w-]+:\s*$/m, `${f}: at least one job`);
  }
});

test("every `uses:` is pinned to a full 40-character commit SHA with a version comment", () => {
  const bad = [];
  for (const f of files) {
    for (const line of read(f).split("\n")) {
      const m = line.match(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/);
      if (!m) continue;
      if (m[1].startsWith("./")) continue; // local action
      if (!/@[0-9a-f]{40}$/.test(m[1]) || !/#\s*v?\d/.test(m[2])) bad.push(`${f}: ${line.trim()}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("uptime check reads SITE_URL (repository variable) with the live domain as fallback", () => {
  const src = read("uptime-check.yml");
  assert.match(src, /SITE_URL: \$\{\{ vars\.SITE_URL \|\| 'https:\/\/umasbooks\.org' \}\}/);
  assert.doesNotMatch(src, /onrender\.com/);
  assert.match(src, /"\$\{SITE_URL%\/\}\/healthz"/);
  // the two-consecutive-failures logic is unchanged
  assert.match(src, /\[ "\$P" = "failure" \] && \[ "\$PP" = "success" \]/);
});

test("test-alert runs weekly (Mondays) and can still be started by hand", () => {
  const src = read("test-alert.yml");
  assert.match(src, /schedule:\s*\n\s*- cron: "[^"]+ \* \* 1"/);
  assert.match(src, /workflow_dispatch:/);
});

test("CI: jobs that never run the crawler skip install scripts; the crawler job caches Chrome", () => {
  const src = read("ci.yml");
  const jobs = src.split(/^ {2}(?=[a-z-]+:\s*$)/m);
  const body = (name) => jobs.find((j) => j.startsWith(`${name}:`)) || "";
  for (const j of ["lint", "test", "migration-test", "dependency-audit"]) {
    assert.match(body(j), /npm ci --ignore-scripts/, `${j} skips install scripts`);
  }
  assert.doesNotMatch(body("smoke-crawl"), /--ignore-scripts/, "the crawler needs puppeteer's Chrome download");
  assert.match(body("smoke-crawl"), /~\/\.cache\/puppeteer/);
});
