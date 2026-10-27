"use strict";

// src/migrate.js runs each migration file with lock_timeout and retries it when the lock is not
// available (55P03), so an ALTER/DROP queued behind a long read cannot block the table for the
// old version that still serves during pre-deploy. Two real connections on a throwaway database:
// one holds ACCESS EXCLUSIVE on a table, the migration tries to ALTER it.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { Client } = require("pg");
const { prepareDatabase } = require("../helpers/testDatabase");

const database = prepareDatabase("migratelock", { isolated: true });
let pool;
let runMigrations;
let dir;
const FILE = "999_probe_alter.sql";

before(() => {
  database.create();
  ({ pool } = require("../../src/db"));
  ({ runMigrations } = require("../../src/migrate"));
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mig-"));
  fs.writeFileSync(path.join(dir, FILE), "ALTER TABLE lock_probe ADD COLUMN IF NOT EXISTS added_by_probe int;\n");
});
after(async () => {
  await pool.end();
  database.drop();
});

async function blocker() {
  const c = new Client({ connectionString: process.env.DATABASE_URL });
  await c.connect();
  await c.query("BEGIN");
  await c.query("LOCK TABLE lock_probe IN ACCESS EXCLUSIVE MODE");
  return c;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function reset() {
  await pool.query("DROP TABLE IF EXISTS lock_probe");
  await pool.query("CREATE TABLE lock_probe (id int)");
  await pool.query("DELETE FROM schema_migrations WHERE filename = $1", [FILE]);
}

test("config: lock timeout and retries default to 5000 ms and 5", () => {
  const config = require("../../src/lib/config");
  assert.equal(config.get("MIGRATE_LOCK_TIMEOUT_MS"), 5000);
  assert.equal(config.get("MIGRATE_LOCK_RETRIES"), 5);
});

test("a migration waiting on a lock held by another connection retries, then succeeds once it is released", async () => {
  await reset();
  const held = await blocker();
  const log = [];
  const run = runMigrations({ dir, lockTimeoutMs: 150, retries: 8, backoffMs: 50, endPool: false, log: (m) => log.push(m) });
  const outcome = run.then(() => "done", (e) => e);
  // wait until at least two attempts have timed out, then let go
  const started = Date.now();
  while (log.filter((m) => /retrying/.test(m)).length < 2 && Date.now() - started < 8000) await sleep(50);
  if (log.filter((m) => /table lock not available/.test(m)).length < 2) {
    await held.query("ROLLBACK"); // never leave the lock held when the test fails
    await held.end();
    assert.fail(`did not retry while locked: ${log.join(" | ")}`);
  }
  const { rows: before } = await pool.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [FILE]);
  assert.equal(before.length, 0, "not recorded while it could not run");
  await held.query("ROLLBACK");
  await held.end();
  assert.equal(await outcome, "done");
  const { rows } = await pool.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [FILE]);
  assert.equal(rows.length, 1, "recorded once it ran");
  const { rows: cols } = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'lock_probe' AND column_name = 'added_by_probe'");
  assert.equal(cols.length, 1, "the ALTER was applied");
});

test("when the lock is never released the run fails with the clear message and nothing is recorded", async () => {
  await reset();
  const held = await blocker();
  const log = [];
  try {
    await assert.rejects(
      runMigrations({ dir, lockTimeoutMs: 100, retries: 2, backoffMs: 20, endPool: false, log: (m) => log.push(m) }),
      (err) => {
        assert.equal(err.code, "55P03");
        assert.match(err.message, new RegExp(`Migration ${FILE} could not get a table lock after 3 tries of 100 ms`));
        assert.match(err.message, /current version keeps serving/);
        assert.match(err.message, /When a deploy fails because a migration could not get a lock/);
        return true;
      }
    );
  } finally {
    await held.query("ROLLBACK");
    await held.end();
  }
  assert.equal(log.filter((m) => /retrying/.test(m)).length, 2, "two retries, then it gave up");
  const { rows } = await pool.query("SELECT 1 FROM schema_migrations WHERE filename = $1", [FILE]);
  assert.equal(rows.length, 0);
  const { rows: cols } = await pool.query("SELECT 1 FROM information_schema.columns WHERE table_name = 'lock_probe' AND column_name = 'added_by_probe'");
  assert.equal(cols.length, 0, "rolled back");
});

test("another kind of error is not retried", async () => {
  await reset();
  const bad = fs.mkdtempSync(path.join(os.tmpdir(), "mig-bad-"));
  fs.writeFileSync(path.join(bad, "998_bad.sql"), "ALTER TABLE no_such_table ADD COLUMN x int;\n");
  const log = [];
  await assert.rejects(runMigrations({ dir: bad, lockTimeoutMs: 100, retries: 5, backoffMs: 10, endPool: false, log: (m) => log.push(m) }), /no_such_table/);
  assert.equal(log.filter((m) => /retrying/.test(m)).length, 0);
});
