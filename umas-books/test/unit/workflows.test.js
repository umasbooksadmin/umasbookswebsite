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

// ---- the local alert-mail composite action (L13) and the Node version (L12) ----

const repoRoot = path.join(__dirname, "..", "..", "..");
const mailAction = fs.readFileSync(path.join(repoRoot, ".github", "actions", "send-alert-mail", "action.yml"), "utf8");

test("the local action keeps the third-party mail action pinned to a SHA, and it is the ONLY place that uses it", () => {
  assert.match(mailAction, /uses: dawidd6\/action-send-mail@[0-9a-f]{40} # v\d/);
  assert.match(mailAction, /server_address: smtp\.gmail\.com/);
  assert.match(mailAction, /server_port: 465/);
  assert.match(mailAction, /using: composite/);
  for (const f of files) assert.doesNotMatch(read(f), /dawidd6\/action-send-mail/, `${f} calls the local action instead`);
  // pinned-action guard also covers composite actions
  const actionsDir = path.join(repoRoot, ".github", "actions");
  for (const d of fs.readdirSync(actionsDir)) {
    for (const line of fs.readFileSync(path.join(actionsDir, d, "action.yml"), "utf8").split("\n")) {
      const m = line.match(/^\s*(?:-\s*)?uses:\s*(\S+)(.*)$/);
      if (m && !m[1].startsWith("./")) assert.match(m[1] + m[2], /@[0-9a-f]{40}\s+#\s*v?\d/, `${d}: ${line.trim()}`);
    }
  }
});

test("the local action takes secrets and recipients as inputs (it cannot read them itself) and never sends if skipped by an earlier failure", () => {
  assert.doesNotMatch(mailAction, /\$\{\{\s*(secrets|vars)\./);
  assert.match(mailAction, /username: \$\{\{ inputs\.username \}\}/);
  assert.match(mailAction, /password: \$\{\{ inputs\.password \}\}/);
  assert.match(mailAction, /to: \$\{\{ inputs\.to \}\}/);
  assert.match(mailAction, /from: "\$\{\{ inputs\.from-name \}\} <\$\{\{ inputs\.username \}\}>"/);
  assert.match(mailAction, /^ {6}if: always\(\)$/m, "a failed earlier step must not suppress the alert");
});

test("every workflow that emails: calls the local action, passes the two Gmail secrets, and has the action checked out first", () => {
  const callers = files.filter((f) => /uses: \.\/\.github\/actions\/send-alert-mail/.test(read(f)));
  assert.deepEqual(callers.sort(), ["accounting-export-monthly.yml", "backup-freshness.yml", "backup-restore-test.yml", "inventory-export.yml", "nightly-db-backup.yml", "test-alert.yml", "uptime-check.yml"]);
  let calls = 0;
  for (const f of callers) {
    const src = read(f);
    const blocks = src.split(/\n(?=\s+- name: )/).filter((b) => b.includes("uses: ./.github/actions/send-alert-mail"));
    for (const b of blocks) {
      calls++;
      assert.match(b, /username: \$\{\{ secrets\.GMAIL_USER \}\}/, `${f}`);
      assert.match(b, /password: \$\{\{ secrets\.GMAIL_APP_PASSWORD \}\}/, `${f}`);
      assert.match(b, /^\s+from-name: "Uma's Books [^"]+"$/m, `${f}`);
      assert.match(b, /^\s+subject: /m, `${f}`);
      assert.match(b, /^\s+body: /m, `${f}`);
    }
    // checkout (full or sparse including .github/actions) comes BEFORE the first call
    const firstCall = src.indexOf("uses: ./.github/actions/send-alert-mail");
    const co = [...src.matchAll(/actions\/checkout@/g)].map((m) => m.index).filter((i) => i < firstCall);
    assert.ok(co.length >= 1, `${f}: checkout before the first email step`);
    if (/sparse-checkout/.test(src)) assert.match(src, /\.github\/actions/, `${f}: sparse checkout includes .github/actions`);
  }
  assert.equal(calls, 12, "12 email steps, as before the refactor");
});

test("the failure alerts still run on failure(), and uptime/freshness fetch the action only when they email", () => {
  for (const [f, name] of [["backup-freshness.yml", "Alert admin if there is no fresh backup"], ["nightly-db-backup.yml", "Alert admin if any step above failed"], ["accounting-export-monthly.yml", "Alert admin if any step above failed"], ["inventory-export.yml", "Alert admin if any step above failed"], ["backup-restore-test.yml", "Alert admin if the restore test failed"]]) {
    const i = read(f).indexOf(`- name: ${name}`);
    assert.ok(i > 0, `${f}: ${name}`);
    assert.match(read(f).slice(i, i + 700), /if: failure\(\)/, f);
  }
  const up = read("uptime-check.yml");
  assert.match(up, /Fetch the alert-mail action\n(?:\s+#.*\n)*\s+if: steps\.decide\.outputs\.alert == 'true' \|\| steps\.decide\.outputs\.recovered == 'true'/);
  const fr = read("backup-freshness.yml");
  assert.match(fr, /Fetch the alert-mail action\n(?:\s+#.*\n)*\s+if: failure\(\)/);
});

test("the uptime check runs hourly (Actions minutes budget), not every 30 minutes", () => {
  const src = read("uptime-check.yml");
  const crons = [...src.matchAll(/- cron: "([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(crons, ["7 * * * *"]);
  assert.doesNotMatch(src, /\*\/30/);
});

test("Node version: one source (umas-books/.node-version); workflows read it, nothing hard-codes it", () => {
  const nodeVersion = fs.readFileSync(path.join(repoRoot, "umas-books", ".node-version"), "utf8").trim();
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "umas-books", "package.json"), "utf8"));
  assert.equal(pkg.engines.node, `${nodeVersion}.x`, "package.json engines agrees with .node-version");
  for (const f of files) {
    const src = read(f);
    assert.doesNotMatch(src, /node-version: ["']?\d/, `${f}: no literal node-version`);
    assert.doesNotMatch(src, /NODE_VERSION/, `${f}: no NODE_VERSION env copy`);
    for (const m of src.matchAll(/node-version-file: (\S+)/g)) assert.equal(m[1], "umas-books/.node-version", f);
  }
  assert.ok(files.some((f) => /node-version-file:/.test(read(f))));
});
