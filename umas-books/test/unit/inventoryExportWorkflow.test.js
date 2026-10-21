"use strict";

// Static checks on .github/workflows/inventory-export.yml (CI cannot run it: it
// needs the production database and the Backblaze bucket).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const wf = fs.readFileSync(path.join(__dirname, "..", "..", "..", ".github", "workflows", "inventory-export.yml"), "utf8");
const code = wf.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"); // without comment lines

test("scheduled at 19:00 and 20:00 UTC, and only goes on when it is 21h in Paris", () => {
  assert.deepEqual([...code.matchAll(/- cron: "([^"]+)"/g)].map((m) => m[1]), ["0 19 * * *", "0 20 * * *"]);
  assert.match(code, /TZ=Europe\/Paris date \+%H/);
  assert.match(code, /\[ "\$hour" = "21" \]/);
  // the no-op path succeeds (no exit 1 in the gate step) with a notice
  const gate = code.match(/- name: Only go on at 21:00 in Paris[\s\S]*?(?=\n {6}- )/)[0];
  assert.doesNotMatch(gate, /exit [1-9]/);
  assert.match(gate, /::notice/);
});

test("every real step waits for the time check; manual runs can skip it", () => {
  assert.match(code, /workflow_dispatch:\n {4}inputs:\n {6}ignore_time_check:\n(?:.*\n)*? {8}type: boolean/);
  assert.match(code, /IGNORE: \$\{\{ inputs\.ignore_time_check \}\}/);
  const steps = code.split(/\n {6}- /).slice(1);
  const gateStep = steps.find((s) => s.startsWith("name: Only go on at 21:00"));
  assert.ok(gateStep);
  for (const s of steps) {
    if (s === gateStep || /^name: Alert admin/.test(s)) continue;
    assert.match(s, /if: steps\.gate\.outputs\.run == 'true'/, s.split("\n")[0]);
  }
});

test("the CSV never goes to GitHub storage: no artifact upload, no cache of data, no git push", () => {
  assert.doesNotMatch(code, /upload-artifact|download-artifact|actions\/cache|git push|git commit/);
});

test("one run at a time, 10 minute limit, read-only token", () => {
  assert.match(code, /^concurrency:\n {2}group: inventory-export\n {2}cancel-in-progress: false$/m);
  assert.match(code, /timeout-minutes: 10$/m);
  assert.match(code, /^permissions:\n {2}contents: read$/m);
});

test("uses the existing secrets and variables by name only, no new ones, no literal credentials", () => {
  const used = new Set([...code.matchAll(/(secrets|vars)\.(\w+)/g)].map((m) => `${m[1]}.${m[2]}`));
  const allowed = new Set([
    "secrets.DATABASE_URL", "secrets.BACKUP_S3_KEY_ID", "secrets.BACKUP_S3_APPLICATION_KEY", "secrets.GMAIL_USER", "secrets.GMAIL_APP_PASSWORD",
    "vars.BACKUP_S3_BUCKET", "vars.BACKUP_S3_ENDPOINT", "vars.BACKUP_S3_REGION", "vars.ALERT_TO",
  ]);
  for (const u of used) assert.ok(allowed.has(u), `${u} is not an existing setting`);
  assert.doesNotMatch(code, /postgres(ql)?:\/\/|AKIA|age1[a-z0-9]{20}/);
});

test("uploads the dated, books and latest files to inventory-exports/ in the backup bucket", () => {
  assert.match(code, /inventory_\$\{DAY\}\.csv" "inventory_books_\$\{DAY\}\.csv" "inventory_latest\.csv"/);
  assert.match(code, /s3:\/\/\$\{BUCKET\}\/inventory-exports\/\$f/);
  assert.match(code, /--endpoint-url "\$ENDPOINT"/);
});

test("emails ALERT_TO with the attachments, the counts subject and a failure alert", () => {
  assert.equal([...code.matchAll(/^\s*to:\s*(.+)$/gm)].map((m) => m[1].trim()).join("|"),
    "${{ vars.ALERT_TO || 'admin@umasbooks.org' }}|${{ vars.ALERT_TO || 'admin@umasbooks.org' }}");
  assert.match(code, /subject: "\[umas-books\] Inventory export \$\{\{ steps\.export\.outputs\.date \}\} \(\$\{\{ steps\.export\.outputs\.copies \}\} copies\)"/);
  assert.match(code, /attachments: \$\{\{ steps\.attach\.outputs\.files \}\}/);
  assert.match(code, /if: failure\(\)/);
  assert.match(code, /subject: "\[umas-books\] Nightly inventory export failed"/);
});

test("installs only runtime dependencies and logs counts only", () => {
  assert.match(code, /npm ci --omit=dev/);
  assert.doesNotMatch(code, /\bcat\b[^\n]*inventory_[^\n]*\.csv|\bhead\b|\btail\b|\bcurl\b/);
  assert.match(code, /GITHUB_STEP_SUMMARY/);
});

test("actions are pinned to full commit SHAs", () => {
  for (const m of code.matchAll(/uses: (\S+)/g)) assert.match(m[1], /^(\.\/\.github\/actions\/send-alert-mail|\S+@[0-9a-f]{40})$/, m[1]);
});
