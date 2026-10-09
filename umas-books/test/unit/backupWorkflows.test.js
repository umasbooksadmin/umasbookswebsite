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
