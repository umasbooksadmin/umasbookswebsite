"use strict";

// Backup encryption (age): static checks on the three workflows and the shared
// script, plus the real round trip when `age` is installed locally. CI cannot run
// the workflows (production database, Backblaze), so these pin the properties
// that matter.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const repo = path.join(__dirname, "..", "..", "..");
const wf = (n) => fs.readFileSync(path.join(repo, ".github", "workflows", n), "utf8");
const nightly = wf("nightly-db-backup.yml");
const restore = wf("backup-restore-test.yml");
const freshness = wf("backup-freshness.yml");
const script = path.join(repo, ".github", "scripts", "encrypt-dump.sh");

test("nightly: encrypts before upload, uploads only the encrypted file when a recipient is set", () => {
  assert.match(nightly, /vars\.BACKUP_AGE_RECIPIENT/);
  assert.match(nightly, /bash \.github\/scripts\/encrypt-dump\.sh "\$FILE"/);
  assert.match(nightly, /UPLOAD="\$FILE\.age"/);
  // the encryption happens before any `aws s3 cp`
  assert.ok(nightly.indexOf("encrypt-dump.sh \"$FILE\"") < nightly.indexOf("aws s3 cp"));
  assert.doesNotMatch(nightly, /aws s3 cp "\$FILE"/, "the plaintext variable is never uploaded directly");
});

test("nightly: never holds a private key", () => {
  assert.doesNotMatch(nightly, /BACKUP_AGE_IDENTITY|AGE-SECRET-KEY/);
});

test("nightly: unset recipient = still runs, with a warning in the summary, the failure email and a weekly reminder", () => {
  assert.match(nightly, /Backups are not encrypted/);
  assert.match(nightly, /GITHUB_STEP_SUMMARY/);
  assert.match(nightly, /steps\.enc\.outputs\.encrypt == 'false'/);
  assert.match(nightly, /Database backups are NOT encrypted/);
  assert.match(nightly, /nag=true/);
  // the unset case does not exit non-zero
  const m = nightly.match(/- name: Check the encryption setting[\s\S]*?(?=\n {6}- name:)/);
  assert.ok(m);
  const unsetBranch = m[0].slice(0, m[0].indexOf("else"));
  assert.doesNotMatch(unsetBranch, /exit 1/);
});

test("age is installed from a pinned release with a verified SHA-256, identically in both workflows", () => {
  const pick = (t, k) => (t.match(new RegExp(`${k}: "?([0-9a-f.]+)"?`)) || [])[1];
  assert.match(pick(nightly, "AGE_VERSION"), /^\d+\.\d+\.\d+$/);
  assert.match(pick(nightly, "AGE_SHA256"), /^[0-9a-f]{64}$/);
  assert.equal(pick(restore, "AGE_VERSION"), pick(nightly, "AGE_VERSION"));
  assert.equal(pick(restore, "AGE_SHA256"), pick(nightly, "AGE_SHA256"));
  for (const t of [nightly, restore]) {
    assert.match(t, /sha256sum --check --strict -/);
    assert.match(t, /releases\/download\/v\$\{AGE_VERSION\}\/age-v\$\{AGE_VERSION\}-linux-amd64\.tar\.gz/);
  }
});

test("restore test: integrity-only by default, full decrypt only with the BACKUP_AGE_IDENTITY secret, plain dumps still restored", () => {
  assert.match(restore, /MODE=integrity-only/);
  assert.match(restore, /MODE=full-encrypted/);
  assert.match(restore, /MODE=full-plain/);
  assert.match(restore, /secrets\.BACKUP_AGE_IDENTITY/);
  // the identity is referenced only in the step that decrypts (and the has-it probe)
  const uses = restore.match(/secrets\.BACKUP_AGE_IDENTITY/g) || [];
  assert.equal(uses.length, 2);
  assert.match(restore, /age-encryption\.org\/v1/);
  assert.match(restore, /\+-50%/);
  assert.match(restore, /PGDMP/);
  // the heavy steps are skipped in integrity-only mode
  for (const name of ["Install matching PostgreSQL client tools", "Restore the dump", "Sanity-check the restored data"]) {
    const m = restore.match(new RegExp(`- name: ${name}\\n\\s+if: env\\.MODE == 'full-plain' \\|\\| env\\.MODE == 'full-encrypted'`));
    assert.ok(m, `${name} is gated on the mode`);
  }
  assert.match(restore, /--prefix "\$\{PREFIX\}\/full\/umas_books_full_"/);
});

test("freshness check: recognises .age files, checks the header, warns (not fails) on a plaintext newest dump", () => {
  assert.match(freshness, /age-encryption\.org\/v1/);
  assert.match(freshness, /--range bytes=0-31/);
  assert.match(freshness, /::warning title=Backups are not encrypted/);
  assert.match(freshness, /--prefix "\$\{PREFIX\}\/full\/umas_books_full_"/);
});

test("encrypt-dump.sh refuses a missing, malformed or private-key recipient", () => {
  const run = (recipient) => spawnSync("bash", [script, "--check"], { env: { ...process.env, BACKUP_AGE_RECIPIENT: recipient }, encoding: "utf8" });
  assert.notEqual(run("").status, 0);
  assert.notEqual(run("hello").status, 0);
  assert.notEqual(run("AGE-SECRET" + "-KEY-1" + "q".repeat(58)).status, 0); // built at run time: no key-shaped literal in the repo
  const good = "age1" + "q".repeat(58);
  const ok = run(`${good}, ${good}`);
  assert.equal(ok.status, 0);
  assert.equal(ok.stdout.trim(), "2");
});

const haveAge = spawnSync("age", ["--version"]).status === 0 && spawnSync("age-keygen", ["--version"]).status === 0;
test("self-test: encrypt -> decrypt round trip (needs age on PATH)", { skip: haveAge ? false : "age is not installed (brew install age)" }, () => {
  const r = spawnSync("bash", [path.join(repo, "umas-books", "scripts", "backup-encrypt-selftest.sh")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /SELFTEST OK/);
});
