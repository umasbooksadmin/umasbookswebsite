"use strict";

// Static checks on the 10-year records workflows: the monthly accounting export
// (accounting-export-monthly.yml), the yearly copy and yearly export added to
// nightly-db-backup.yml, and the yearly warning in backup-freshness.yml. CI cannot run them (they
// need the production database and the Backblaze bucket), so these guard what matters: the
// Paris-time gate, no artifacts, no secrets in the text, null-safe listings, the skip logic.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..", "..", "..");
const wf = (n) => fs.readFileSync(path.join(root, ".github", "workflows", n), "utf8");
const monthly = wf("accounting-export-monthly.yml");
const nightly = wf("nightly-db-backup.yml");
const freshness = wf("backup-freshness.yml");
const runbook = fs.readFileSync(path.join(root, "docs", "runbook.md"), "utf8");

// The steps of the first job, as text blocks starting at "      - ".
const steps = (text) => text.split(/\n(?= {6}- )/).slice(1).map((b) => b.replace(/\n(?=\S)[\s\S]*$/, ""));
const stepNamed = (text, re) => {
  const s = steps(text).find((b) => re.test(b));
  assert.ok(s, `step ${re} exists`);
  return s;
};
const names = (text, kind) => [...new Set([...text.matchAll(new RegExp(`${kind}\\.([A-Z0-9_]+)`, "g"))].map((m) => m[1]))].sort();

test("monthly: runs at 05:00 and 06:00 UTC on the 1st, plus a manual run with the three inputs", () => {
  assert.match(monthly, /- cron: "0 5 1 \* \*"/);
  assert.match(monthly, /- cron: "0 6 1 \* \*"/);
  assert.equal((monthly.match(/- cron:/g) || []).length, 2);
  assert.match(monthly, /workflow_dispatch:/);
  for (const input of ["month", "ignore_time_check", "allow_current_month"]) assert.match(monthly, new RegExp(`^ {6}${input}:`, "m"));
});

test("monthly: the FIRST step is the Paris time gate (hour 7, day 1) and everything else waits for it", () => {
  const all = steps(monthly);
  assert.match(all[0], /id: gate/);
  assert.match(all[0], /TZ=Europe\/Paris date \+%H/);
  assert.match(all[0], /TZ=Europe\/Paris date \+%d/);
  assert.match(all[0], /"\$HOUR" = "7"/);
  assert.match(all[0], /"\$DAY" = "1"/);
  assert.match(all[0], /IGNORE: \$\{\{ inputs\.ignore_time_check \}\}/);
  for (const s of all.slice(1)) {
    if (/Alert admin/.test(s)) { assert.match(s, /if: failure\(\)/); continue; }
    assert.match(s, /if: steps\.gate\.outputs\.run == 'true'/, s.split("\n")[0]);
  }
});

test("monthly: read-only permissions, concurrency, 10 minute timeout, no artifacts, pinned actions", () => {
  assert.match(monthly, /^permissions:\n {2}contents: read$/m);
  assert.doesNotMatch(monthly, /contents: write/);
  assert.match(monthly, /^concurrency:\n {2}group: accounting-export\n {2}cancel-in-progress: false$/m);
  assert.match(monthly, /timeout-minutes: 10\b/);
  assert.doesNotMatch(monthly, /upload-artifact|download-artifact/);
  for (const m of monthly.matchAll(/uses: ([^\s]+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `${m[1]} is pinned to a commit`);
});

test("monthly: only these secrets and variables are used, by name (never a value)", () => {
  assert.deepEqual(names(monthly, "secrets"), ["BACKUP_S3_APPLICATION_KEY", "BACKUP_S3_KEY_ID", "DATABASE_URL", "GMAIL_APP_PASSWORD", "GMAIL_USER"]);
  assert.deepEqual(names(monthly, "vars"), ["ACCOUNTING_TO", "ALERT_TO", "BACKUP_S3_BUCKET", "BACKUP_S3_ENDPOINT", "BACKUP_S3_REGION"]);
  assert.doesNotMatch(monthly, /postgres(ql)?:\/\//);
  assert.doesNotMatch(monthly, /age1[a-z0-9]{20,}|AGE-SECRET-KEY/);
});

test("monthly: stores the three files plain under accounting-exports/YYYY/, never encrypted", () => {
  const store = stepNamed(monthly, /Store the files in Backblaze/);
  assert.match(store, /accounting-exports\/\$\{FOLDER\}\/\$\{f\}/);
  for (const f of ["accounting_${LABEL}.csv", "till_days_${LABEL}.csv", "summary_${LABEL}.txt"]) assert.ok(store.includes(f), f);
  assert.doesNotMatch(monthly, /encrypt-dump|age -|--sse/);
  assert.match(store, /aws s3 cp /);
});

test("monthly: emails both CSVs to ACCOUNTING_TO, else ALERT_TO; failure alert goes to ALERT_TO", () => {
  const mail = stepNamed(monthly, /Email the two CSV files/);
  assert.match(mail, /to: \$\{\{ vars\.ACCOUNTING_TO \|\| vars\.ALERT_TO \|\| 'admin@umasbooks\.org' \}\}/);
  assert.match(mail, /attachments: accounting-out\/accounting_\*\.csv,accounting-out\/till_days_\*\.csv/);
  assert.match(mail, /dawidd6\/action-send-mail@[0-9a-f]{40}/);
  const alert = stepNamed(monthly, /Alert admin/);
  assert.match(alert, /to: \$\{\{ vars\.ALERT_TO \|\| 'admin@umasbooks\.org' \}\}/);
  assert.doesNotMatch(alert, /ACCOUNTING_TO/);
});

test("monthly: the log shows counts and totals only: no command prints a data file", () => {
  assert.doesNotMatch(monthly, /\b(cat|head|tail|less|more|sed|awk|grep|cut|sort|wc|tee|xargs)\b[^\n|]*(accounting|till_days|summary)[_-]/i, "no data file is read out");
  assert.doesNotMatch(monthly, /\b(cat|head|tail)\b[^\n]*\.(csv|txt)/);
  assert.doesNotMatch(monthly, /set -x|xtrace/);
});

test("monthly: the export step is read-only and uses the script; the month and force flags come from inputs through env", () => {
  const exp = stepNamed(monthly, /Produce the accounting files/);
  assert.match(exp, /node scripts\/export-accounting-month\.js/);
  assert.match(exp, /MONTH: \$\{\{ inputs\.month \}\}/);
  assert.doesNotMatch(exp, /\$\{\{ *inputs\.[a-z_]+ *\}\}[^\n]*node /, "inputs are never pasted into the command line");
  assert.match(exp, /--force/);
});

test("nightly: force_yearly input; yearly block comes AFTER the normal upload and the monthly copy", () => {
  assert.match(nightly, /force_yearly:\n[\s\S]*?type: boolean/);
  assert.match(nightly, /FORCE_YEARLY: \$\{\{ inputs\.force_yearly \}\}/);
  const iFull = nightly.indexOf("/full/$(basename");
  const iMonthly = nightly.indexOf("Monthly copy written.");
  const iYearly = nightly.indexOf("/yearly/umas_books_full_${PARIS_DATE}${YEXT}");
  assert.ok(iFull > 0 && iMonthly > iFull && iYearly > iMonthly, "full, then monthly, then yearly");
});

test("nightly: yearly copy is the SAME dump, on 2 January Paris date, once a year, null-safe listing", () => {
  assert.match(nightly, /TZ=Europe\/Paris date \+%m-%d\)" = "01-02"/);
  assert.match(nightly, /aws s3 cp "\$UPLOAD" "s3:\/\/\$\{BUCKET\}\/\$\{PREFIX\}\/yearly\//);
  assert.match(nightly, /YEXT="\.dump\.age"/);
  assert.match(nightly, /--prefix "\$\{PREFIX\}\/yearly\/umas_books_full_\$\{YEAR\}-"/);
  assert.ok(nightly.includes("--query 'length(Contents || `[]`)'"), "null-safe: Contents || `[]`");
  assert.match(nightly, /"\$\{EXISTING:-0\}" != "0" \] && \[ "\$FORCE_YEARLY" != "true"/, "skip when it exists, unless forced");
  // the dump itself is not dumped twice
  assert.equal((nightly.match(/pg_dump --no-owner/g) || []).length, 1);
});

test("nightly: an unencrypted yearly copy is written and flagged", () => {
  assert.match(nightly, /\[ "\$ENCRYPT" != "true" \][\s\S]*?::warning title=Yearly copy is not encrypted::/);
  assert.match(nightly, /YEXT="\.dump"/);
});

test("nightly: the yearly steps run only when a yearly copy was written; the export is the previous year, read-only, no artifacts", () => {
  for (const re of [/setup-node/, /Install dependencies for the yearly/, /Yearly accounting export/, /Email the yearly accounting files/]) {
    assert.match(stepNamed(nightly, re), /if: steps\.dump\.outputs\.yearly == 'true'/);
  }
  const exp = stepNamed(nightly, /Yearly accounting export/);
  assert.match(exp, /export-accounting-month\.js --year last/);
  assert.match(exp, /FISCAL_YEAR_START_MONTH: \$\{\{ vars\.FISCAL_YEAR_START_MONTH \}\}/);
  assert.match(exp, /accounting-exports\/\$\{FOLDER\}\/\$\{f\}/);
  assert.match(exp, /accounting_\$\{LABEL\}\.csv/);
  assert.doesNotMatch(nightly, /upload-artifact/);
  assert.match(stepNamed(nightly, /Email the yearly accounting files/), /vars\.ACCOUNTING_TO \|\| vars\.ALERT_TO/);
  assert.match(nightly, /^permissions:\n {2}contents: read$/m);
});

test("nightly: the failure alert is still the last step and still goes to ALERT_TO", () => {
  const all = steps(nightly);
  const names2 = all.map((s) => s.split("\n")[0]);
  assert.ok(names2.findIndex((n) => /Alert admin/.test(n)) > names2.findIndex((n) => /Email the yearly/.test(n)));
  assert.match(stepNamed(nightly, /Alert admin if any step/), /to: \$\{\{ vars\.ALERT_TO/);
});

test("freshness: the yearly copy is only a warning, never required, and only checked from 2027", () => {
  const s = stepNamed(freshness, /Check the yearly copy/);
  assert.match(s, /"\$YEAR" -lt 2027/);
  assert.match(s, /"\$MONTH" = "1" \] && \[ "\$DAY" -le 15/);
  assert.ok(s.includes("--query 'length(Contents || `[]`)'"), "null-safe listing");
  assert.match(s, /::warning title=No yearly backup copy/);
  assert.doesNotMatch(s, /exit 1|::error/);
  assert.match(s, /yearly\/umas_books_full_\$\{YEAR\}-/);
  // the other two checks are unchanged in what they require
  assert.doesNotMatch(stepNamed(freshness, /Check the newest nightly dump/), /yearly/);
});

test("runbook: the section exists with the owner steps, the lifecycle values and the config types", () => {
  const m = runbook.match(/^## ([a-z]+)\) Keeping records for 10 years$/m);
  assert.ok(m, "section heading");
  const body = runbook.slice(runbook.indexOf(m[0]), runbook.indexOf("\n## ", runbook.indexOf(m[0]) + 5));
  for (const needle of ["store-backups/yearly/", "accounting-exports/", "`3650`", "ACCOUNTING_TO", "FISCAL_YEAR_START_MONTH", "repository variable", "Variables** tab", "paper", "USB", "January", "October", "force_yearly", "Backblaze **bucket setting**", "Paheko"]) {
    assert.ok(body.includes(needle), `runbook mentions ${needle}`);
  }
  assert.doesNotMatch(runbook, /\bSEC\)/, "no placeholder letter left");
});

test("the admin Accounting export page has the hint", () => {
  const view = fs.readFileSync(path.join(root, "umas-books", "views", "admin", "reports", "show.ejs"), "utf8");
  assert.match(view, /The previous month is also emailed to you on the 1st at 07:00 and stored for 10 years/);
});
