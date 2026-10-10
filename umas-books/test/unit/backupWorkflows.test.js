"use strict";

// Static checks on the two backup workflows. CI cannot run them (they need
// the production database and the Backblaze bucket), so these guard the
// properties that matter: dumps never go into the code repository, the
// offsite upload is mandatory, and restore reads from the same place the
// nightly job writes to.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const wfDir = path.join(__dirname, "..", "..", "..", ".github", "workflows");
const nightly = fs.readFileSync(path.join(wfDir, "nightly-db-backup.yml"), "utf8");
const restore = fs.readFileSync(path.join(wfDir, "backup-restore-test.yml"), "utf8");

test("backup workflows no longer use the db-backups git branch", () => {
  assert.doesNotMatch(nightly, /db-backups/);
  assert.doesNotMatch(restore, /db-backups/);
  assert.doesNotMatch(nightly, /git push|git commit/);
});

test("nightly backup: read-only repository access", () => {
  assert.match(nightly, /^permissions:\n {2}contents: read$/m);
  assert.doesNotMatch(nightly, /contents: write/);
});

test("nightly backup: login sessions excluded, image bytes included", () => {
  assert.match(nightly, /--exclude-table-data=session/);
  assert.doesNotMatch(nightly, /--exclude-table-data=images/);
});

test("nightly backup: fails when the offsite settings are missing", () => {
  const m = nightly.match(/- name: Check the offsite settings[\s\S]*?(?=\n {6}- )/);
  assert.ok(m, "settings check step exists");
  const step = m[0];
  for (const v of ["BACKUP_S3_BUCKET", "BACKUP_S3_ENDPOINT", "BACKUP_S3_REGION", "BACKUP_S3_KEY_ID", "BACKUP_S3_APPLICATION_KEY"]) {
    assert.ok(step.includes(v), `${v} is checked`);
  }
  assert.match(step, /::error::/);
  assert.match(step, /exit 1/);
  assert.doesNotMatch(nightly, /enabled=false|upload skipped/i);
  assert.doesNotMatch(nightly, /steps\.offsite\.outputs/);
});

test("nightly backup: uploads to the full/ and monthly/ prefixes", () => {
  assert.match(nightly, /\$\{PREFIX\}\/full\/\$\(basename "\$UPLOAD"\)/);
  assert.match(nightly, /\$\{PREFIX\}\/monthly\/\$\(basename "\$UPLOAD"\)/);
  assert.match(nightly, /umas_books_full_\$\{STAMP\}\.dump/);
  assert.match(nightly, /date -u \+%d\)" = "01"/);
});

test("restore test: downloads the newest dump from the full/ prefix, read-only", () => {
  assert.match(restore, /--prefix "\$\{PREFIX\}\/full\/umas_books_full_"/);
  assert.match(restore, /^permissions:\n {2}contents: read$/m);
  assert.match(restore, /No backup dumps found/);
  // The only checkout is the sparse one of the migration files (to compare the
  // dump's newest migration with the repository's); never the whole repository.
  const checkouts = restore.match(/actions\/checkout@/g) || [];
  assert.equal(checkouts.length, 1);
  assert.match(restore, /sparse-checkout: umas-books\/migrations/);
});

// ---- Empty monthly/ folder (list-objects-v2 returns "Contents: null") ----

const freshness = fs.readFileSync(path.join(wfDir, "backup-freshness.yml"), "utf8");

test("every sort_by(Contents ...) list query in every workflow is null-safe", () => {
  let n = 0;
  for (const [name, text] of [["freshness", freshness], ["restore", restore], ["nightly", nightly]]) {
    for (const m of text.matchAll(/--query '([^']*sort_by[^']*)'/g)) {
      n++;
      assert.ok(m[1].includes("sort_by(Contents || `[]`,"), `${name}: not null-safe: ${m[1]}`);
    }
    assert.doesNotMatch(text, /sort_by\(Contents,/, `${name}: bare sort_by(Contents, ...)`);
  }
  assert.ok(n >= 5, "found the list queries");
});

test("freshness: no monthly copy yet is a notice while backups are younger than 35 days", () => {
  assert.match(freshness, /::notice title=No monthly copy yet::No monthly copy yet: the first one is written by the nightly backup on the 1st of next month/);
  assert.match(freshness, /\[0\]\.LastModified/); // oldest backup in full/
  assert.match(freshness, /OLDEST_DAYS" -lt "\$MAX_MONTHLY_AGE_DAYS"/);
  // ... and still an error when backups are older and there is still none.
  assert.match(freshness, /::error::No monthly copies found[^\n]*although backups have existed/);
});

test("nightly: bootstraps the monthly copy and has the force_monthly input", () => {
  assert.match(nightly, /workflow_dispatch:[^\n]*\n\s+inputs:\n\s+force_monthly:[\s\S]*?type: boolean\n\s+default: false/);
  assert.match(nightly, /FORCE_MONTHLY: \$\{\{ inputs\.force_monthly \}\}/);
  assert.match(nightly, /bootstrap: no monthly copy exists at all/);
  // one per calendar month: on the 1st only if none was written this month
  assert.match(nightly, /"\$\(date -u \+%d\)" = "01" \] && \[ "\$\{NEWEST_MONTHLY:0:7\}" != "\$THIS_MONTH"/);
});

const { spawnSync: spawnJm } = require("node:child_process");
const pyJm = process.env.PYTHON || "python3";
const haveJmespath = spawnJm(pyJm, ["-c", "import jmespath"]).status === 0;
test("self-test: the list queries against sample JSON (needs python jmespath)", { skip: haveJmespath ? false : "python module jmespath is not installed" }, () => {
  const r = spawnJm("bash", [path.join(__dirname, "..", "..", "scripts", "backup-list-selftest.sh")], { encoding: "utf8", env: { ...process.env, PYTHON: pyJm } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});
