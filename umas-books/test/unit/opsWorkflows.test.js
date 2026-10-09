"use strict";

// Static guards for the operations set-up (second operations review): alert
// recipients, the weekly test alert, the restore-test and freshness coverage,
// and render.yaml completeness. The workflows cannot run in CI (they need the
// production database and the Backblaze bucket), so these check the text.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const repo = path.join(__dirname, "..", "..", "..");
const wfDir = path.join(repo, ".github", "workflows");
const read = (f) => fs.readFileSync(path.join(wfDir, f), "utf8");
const workflows = fs.readdirSync(wfDir).filter((f) => f.endsWith(".yml"));

test("every workflow that emails sends to the ALERT_TO variable (default admin@umasbooks.org)", () => {
  let found = 0;
  for (const f of workflows) {
    for (const m of read(f).matchAll(/^\s*to:\s*(.+)$/gm)) {
      found++;
      assert.equal(m[1].trim(), "${{ vars.ALERT_TO || 'admin@umasbooks.org' }}", `${f}: ${m[1]}`);
    }
  }
  assert.ok(found >= 6);
});

test("the test alert runs every week, not every month", () => {
  const t = read("test-alert.yml");
  assert.match(t, /cron: "\d+ \d+ \* \* 1"/);
  assert.doesNotMatch(t, /cron: "\d+ \d+ 1 \* \*"/);
});

test("restore test: all the important tables must exist, and the dump's newest migration is compared with the repository", () => {
  const r = read("backup-restore-test.yml");
  for (const t of ["till_sales", "till_days", "till_sale_items", "till_quick_items", "shop_sales", "email_outbox", "membership_payments", "admin_audit_log", "images", "schema_migrations"]) {
    assert.match(r, new RegExp(`\\b${t}\\b`), t);
  }
  assert.match(r, /max\(filename\) FROM public\.schema_migrations/);
  assert.match(r, /umas-books\/migrations/);
  assert.match(r, /sparse-checkout: umas-books\/migrations/);
  assert.match(r, /::error::The dump is OLDER than the repository/);
  // every migration table the restore test names really exists in a migration
  const sql = fs.readdirSync(path.join(repo, "umas-books", "migrations")).map((f) => fs.readFileSync(path.join(repo, "umas-books", "migrations", f), "utf8")).join("\n");
  for (const t of ["till_sales", "till_days", "till_sale_items", "till_quick_items", "shop_sales", "email_outbox", "membership_payments", "admin_audit_log", "images"]) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${t}\\b`), `${t} is created by a migration`);
  }
});

test("freshness check: also watches the monthly/ copy (under 35 days, from the 4th of the month)", () => {
  const f = read("backup-freshness.yml");
  assert.match(f, /\/monthly\/umas_books_full_/);
  assert.match(f, /MAX_MONTHLY_AGE_DAYS: "35"/);
  assert.match(f, /-le 3/);
});

test("render.yaml lists the variables a Blueprint rebuild needs, and keeps PREVIEW_MODE out on purpose", () => {
  const y = fs.readFileSync(path.join(repo, "render.yaml"), "utf8");
  const keys = [...y.matchAll(/^\s+- key: (\w+)/gm)].map((m) => m[1]);
  for (const k of ["APP_BASE_URL", "CONTACT_TO", "ALERT_TO", "TRUST_PROXY_HOPS", "HELLOASSO_MEMBERSHIP_FORM_SLUG", "COVER_BACKFILL", "GMAIL_APP_PASSWORD", "TOTP_ENCRYPTION_KEY"]) {
    assert.ok(keys.includes(k), `${k} is in render.yaml`);
  }
  assert.match(y, /key: ALERT_TO\n\s+value: admin@umasbooks\.org,sharonbje@gmail\.com/);
  assert.ok(!keys.includes("PREVIEW_MODE"), "PREVIEW_MODE is deliberately not in render.yaml");
  assert.match(y, /PREVIEW_MODE is deliberately NOT in this file/);
  for (const secret of ["GMAIL_APP_PASSWORD", "SEED_ADMIN_PASSWORD", "HELLOASSO_CLIENT_SECRET", "ANTHROPIC_API_KEY"]) {
    assert.match(y, new RegExp(`key: ${secret}\\n\\s+sync: false`), `${secret} is sync:false`);
  }
});

test("README documents every variable render.yaml declares", () => {
  const y = fs.readFileSync(path.join(repo, "render.yaml"), "utf8");
  const readme = fs.readFileSync(path.join(repo, "umas-books", "README.md"), "utf8");
  for (const m of y.matchAll(/^\s+- key: (\w+)/gm)) assert.ok(readme.includes("`" + m[1] + "`"), `README mentions ${m[1]}`);
});

test("render.yaml declares the optional API keys and settings as sync:false (a rebuild prompts, nothing is overwritten) and does not touch autoDeploy", () => {
  const y = fs.readFileSync(path.join(repo, "render.yaml"), "utf8");
  for (const k of ["NYT_API_KEY", "ISBNDB_API_KEY", "GOOGLE_BOOKS_API_KEY", "ANTHROPIC_API_KEY", "PRICING_AI", "PRICING_AI_DAILY_MAX", "AI_DAILY_MAX_CALLS", "PRICING_AI_MODEL", "ADMIN_SESSION_IDLE_HOURS", "ADMIN_SESSION_MAX_DAYS"]) {
    assert.match(y, new RegExp(`key: ${k}\\n\\s+sync: false`), `${k} is sync:false`);
  }
  assert.ok(!/autoDeploy/.test(y), "render.yaml leaves autoDeploy alone");
});
