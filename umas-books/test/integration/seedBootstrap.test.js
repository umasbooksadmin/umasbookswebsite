// src/seed.js is run before every start (render.yaml). It must bootstrap a
// brand-new database once, and never again stop the site from starting:
//  - fresh DB: first admin + sample content, once;
//  - second boot, content deleted/closed by the owner: nothing comes back;
//  - last admin demoted (row stays): no crash, no promotion, no password
//    reset, no sample content;
//  - SEED_ADMIN_PASSWORD missing: no crash.
//
// Own throwaway database (isolated:true): every case needs a database with
// no admin in it, which would race with other files on a shared one. The
// real script is run as a child process so the exit code (what decides
// whether `npm start` runs) is what is asserted.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Client } = require("pg");
const { startTestApp } = require("../helpers/testApp");

const PORT = 3850;
const ROOT = path.join(__dirname, "..", "..");
const EMAIL = "seed-admin@example.test";
const PASSWORD = "Seed-Boot-Strap-9x!Zq";

let app;
let db;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  db = new Client({ connectionString: app.databaseUrl, ssl: false });
  await db.connect();
  // The app server is not needed; a clean slate is.
  await db.query("DELETE FROM announcements");
  await db.query("DELETE FROM charity_rounds");
  await db.query("DELETE FROM users");
});
after(async () => {
  await db.end();
  await app.stop();
});

function seed(env = {}) {
  const base = { ...process.env };
  delete base.SEED_ADMIN_PASSWORD;
  delete base.SEED_SAMPLE_CONTENT;
  delete base.SEED_STRICT;
  const r = spawnSync("node", ["src/seed.js"], {
    cwd: ROOT,
    env: { ...base, DATABASE_URL: app.databaseUrl, PGSSLMODE: "disable", NODE_ENV: "test", SEED_ADMIN_EMAIL: EMAIL, ...env },
    encoding: "utf8",
    timeout: 60000,
  });
  return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
}
const count = async (table, where = "TRUE") => (await db.query(`SELECT COUNT(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n;

test("seed behaviour on a fresh database, then on later boots", async () => {
  // 1. Missing password on an empty database: warns, creates nothing, exits 0.
  let r = seed();
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /SEED_ADMIN_PASSWORD is not set/);
  assert.equal(await count("users"), 0);
  assert.equal(await count("announcements"), 0, "no sample content without a first admin");

  // 2. Fresh database + password: admin and sample content, once.
  r = seed({ SEED_ADMIN_PASSWORD: PASSWORD });
  assert.equal(r.code, 0, r.out);
  assert.equal(await count("users", `email = '${EMAIL}' AND is_admin`), 1);
  assert.equal(await count("announcements"), 1);
  assert.equal(await count("charity_rounds", "is_active"), 1);
  assert.equal(await count("charity_options"), 3);

  // 3. The owner closes the round and deletes the announcement; next boot
  //    (admin still exists) must not bring them back.
  await db.query("UPDATE charity_rounds SET is_active = FALSE");
  await db.query("DELETE FROM announcements");
  r = seed({ SEED_ADMIN_PASSWORD: PASSWORD });
  assert.equal(r.code, 0, r.out);
  assert.equal(await count("announcements"), 0, "deleted announcement stays deleted");
  assert.equal(await count("charity_rounds", "is_active"), 0, "closed round stays closed");
  assert.equal(await count("charity_rounds"), 1);

  // 4. Last admin demoted (row stays): must not crash, promote, or reset anything.
  const before = (await db.query("SELECT id, password_hash, is_admin FROM users WHERE email = $1", [EMAIL])).rows[0];
  await db.query("UPDATE users SET is_admin = FALSE WHERE id = $1", [before.id]);
  r = seed({ SEED_ADMIN_PASSWORD: PASSWORD });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /WARNING.*already exists as an ordinary account/);
  const after = (await db.query("SELECT password_hash, is_admin FROM users WHERE id = $1", [before.id])).rows[0];
  assert.equal(after.is_admin, false, "demoted account is NOT silently promoted");
  assert.equal(after.password_hash, before.password_hash, "password untouched");
  assert.equal(await count("users"), 1);
  assert.equal(await count("announcements"), 0, "no sample content on a non-fresh database");
  assert.equal(await count("charity_rounds"), 1);

  // 5. ...and with the password env var deleted (what the runbook says to do).
  r = seed();
  assert.equal(r.code, 0, r.out);
  assert.equal(await count("users"), 1);
});

test("SEED_SAMPLE_CONTENT=true forces sample content on a database that has an admin", async () => {
  await db.query("UPDATE users SET is_admin = TRUE");
  const r = seed({ SEED_SAMPLE_CONTENT: "true" });
  assert.equal(r.code, 0, r.out);
  assert.equal(await count("announcements"), 1);
  assert.equal(await count("charity_rounds", "is_active"), 1);
});

test("a failing seed exits 0 (so startup continues) unless SEED_STRICT=true", async () => {
  const broken = "postgres://127.0.0.1:1/nope";
  let r = seed({ DATABASE_URL: broken });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\[seed\] FAILED/);
  r = seed({ DATABASE_URL: broken, SEED_STRICT: "true" });
  assert.equal(r.code, 1, r.out);
});

test("a weak SEED_ADMIN_PASSWORD on an empty database warns and does not crash", async () => {
  await db.query("UPDATE users SET is_admin = FALSE");
  await db.query("DELETE FROM users");
  const r = seed({ SEED_ADMIN_PASSWORD: "short" });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /not strong enough/);
  assert.equal(await count("users"), 0);
});
