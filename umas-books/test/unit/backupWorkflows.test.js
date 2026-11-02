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
  // no "only on the 1st" gate: a failed run on the 1st must not cost a whole month
  assert.doesNotMatch(nightly, /date -u \+%d\)" = "01"/);
});

test("restore test: downloads the newest dump from the full/ prefix, read-only", () => {
  assert.match(restore, /--prefix "\$\{PREFIX\}\/full\/umas_books_full_"/);
  assert.match(restore, /^permissions:\n {2}contents: read$/m);
  assert.match(restore, /No backup dumps found/);
  // The only checkout is the sparse one of the migration files (to compare the
  // dump's newest migration with the repository's); never the whole repository.
  const checkouts = restore.match(/actions\/checkout@/g) || [];
  assert.equal(checkouts.length, 1);
  // (plus .github/actions, the local alert-mail action the failure email uses.)
  assert.match(restore, /sparse-checkout: \|\n\s+umas-books\/migrations\n\s+\.github\/actions\n/);
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
  // one per calendar month: the first successful run of a month that finds none yet writes it (the 1st normally,
  // the next night if the 1st failed)
  // the month is the Paris month of the backup's day (the gate's DAY), compared with the Paris month the newest
  // monthly copy was written in (replayed end to end in backupSchedule.test.js)
  assert.match(nightly, /THIS_MONTH="\$\{DAY:0:7\}"/);
  assert.match(nightly, /NEWEST_MONTH=\$\(paris_text "\$E"\)/);
  assert.match(nightly, /if \[ "\$NEWEST_MONTH" != "\$THIS_MONTH" \]; then\n\s+WRITE_MONTHLY=yes/);
  assert.doesNotMatch(nightly, /date -u \+%Y-%m\)/, "not the runner's UTC month");
});

const { spawnSync: spawnJm } = require("node:child_process");
const pyJm = process.env.PYTHON || "python3";
const haveJmespath = spawnJm(pyJm, ["-c", "import jmespath"]).status === 0;
test("self-test: the list queries against sample JSON (needs python jmespath)", { skip: haveJmespath ? false : "python module jmespath is not installed" }, () => {
  const r = spawnJm("bash", [path.join(__dirname, "..", "..", "scripts", "backup-list-selftest.sh")], { encoding: "utf8", env: { ...process.env, PYTHON: pyJm } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

// ---- 22:00 Paris schedule (the behaviour is replayed end to end in backupSchedule.test.js) ----

const code = nightly.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n"); // without comment lines
const nightlySteps = code.split(/\n {6}- /).slice(1);

test("nightly: 22:00 Paris (20:00 UTC summer, 21:00 UTC winter) plus retries; the old 03:00 UTC line is gone", () => {
  assert.deepEqual([...code.matchAll(/- cron: "([^"]+)"/g)].map((m) => m[1]), ["0 20 * * *", "0 21 * * *", "0 22 * * *", "0 23 * * *", "0 1 * * *"]);
  assert.doesNotMatch(code, /cron: "0 3 \* \* \*"/);
});

test("nightly: the gate comes right after checkout; every real step waits for it; a manual run always goes on", () => {
  assert.match(nightlySteps[0], /^uses: actions\/checkout@/, "checkout first: the gate script lives in the repository");
  const gate = nightlySteps[1];
  assert.match(gate, /^name: Only go on from 22h in Paris/);
  assert.match(gate, /id: gate/);
  assert.match(gate, /run: bash \.github\/scripts\/export-gate\.sh backup/);
  assert.match(gate, /IGNORE: \$\{\{ github\.event_name == 'workflow_dispatch' \}\}/);
  assert.match(gate, /PREFIX: \$\{\{ vars\.BACKUP_S3_PREFIX \}\}/);
  for (const s of nightlySteps.slice(2)) {
    const name = s.split("\n")[0];
    if (/Alert admin/.test(name)) { assert.match(s, /if: failure\(\)/); continue; }
    // the yearly steps follow steps.dump.outputs.yearly (only set when the dump ran), the reminder follows steps.enc
    assert.match(s, /if: [^\n]*steps\.(gate\.outputs\.run == 'true'|dump\.outputs\.yearly == 'true'|enc\.outputs\.nag == 'true')/, name);
  }
  const script = fs.readFileSync(path.join(wfDir, "..", "scripts", "export-gate.sh"), "utf8");
  assert.match(script, /"\$hour" -lt 22/);
  assert.match(script, /paris_epoch "\$for_day" "22:00"/);
  assert.match(script, /newest_since "\$\{pfx\}\/full\/umas_books_full_"/, "the gate looks where the dump step writes");
});

test("nightly: the dump, monthly and yearly copies use the gate's Paris day; the file name stays the UTC time of the dump", () => {
  const dump = nightlySteps.find((s) => s.startsWith("name: Dump database and upload"));
  assert.match(dump, /DAY: \$\{\{ steps\.gate\.outputs\.day \}\}/);
  assert.match(dump, /STAMP=\$\(date -u \+%Y-%m-%dT%H-%M-%SZ\)/);
  assert.match(dump, /FILE="full\/umas_books_full_\$\{STAMP\}\.dump"/);
  assert.match(dump, /s3:\/\/\$\{BUCKET\}\/\$\{PREFIX\}\/full\/\$\(basename "\$UPLOAD"\)/);
  const enc = nightlySteps.find((s) => s.startsWith("name: Check the encryption setting"));
  assert.match(enc, /DAY: \$\{\{ steps\.gate\.outputs\.day \}\}/);
  assert.doesNotMatch(enc, /date -u \+%u\)/, "the weekly reminder goes by the backup's Paris day");
});

test("nightly: only the scheduled night's backup reports in to the site", () => {
  const probe = nightlySteps.find((s) => /X-Umas-Probe: backup/.test(s));
  assert.match(probe, /if: success\(\) && steps\.gate\.outputs\.run == 'true' && steps\.gate\.outputs\.manual != 'true'/);
});

test("freshness: last night's backup is checked with the gate's rule (22:00 Paris), not a fixed age", () => {
  const s = freshness.split(/\n {6}- /).find((x) => x.startsWith("name: Check last night's backup is in Backblaze"));
  assert.ok(s);
  assert.match(s, /id: backup/);
  assert.match(s, /bash \.github\/scripts\/export-freshness\.sh backup/);
  assert.match(s, /grep -qx 'missing=true'[^\n]*\n\s+exit 1/);
  assert.doesNotMatch(freshness, /MAX_AGE_HOURS|AGE_HOURS/);
  assert.match(freshness, /cron: "0 9 \* \* \*"/);
});
