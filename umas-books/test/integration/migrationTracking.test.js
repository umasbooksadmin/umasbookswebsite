// Regression: src/migrate.js used to re-run every migration on every boot
// (render.yaml's startCommand). 032's `UPDATE users SET email_verified_at
// = created_at WHERE email_verified_at IS NULL` therefore verified any
// still-unverified account (e.g. an email squatter) on each deploy, and
// 014 reset NULL (unlimited) session capacities to 5. Now each file runs
// once, tracked in schema_migrations.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");
const { startTestApp } = require("../helpers/testApp");

const PORT = 3417; // distinct from 3411-3416
const ROOT = path.join(__dirname, "..", "..");

let app;
let pool;

function migrate() {
  return execFileSync("node", ["src/migrate.js"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: app.databaseUrl, PGSSLMODE: "disable" },
    encoding: "utf8",
  });
}

before(async () => {
  app = await startTestApp({ port: PORT });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
});

after(async () => {
  await pool.end();
  app.stop();
});

async function seedRows(tag) {
  const { rows: u } = await pool.query(
    "INSERT INTO users (email, password_hash, display_name) VALUES ($1, 'x', 'Squatter') RETURNING id",
    [`squatter-${tag}-${Date.now()}@example.test`]
  );
  const { rows: c } = await pool.query(
    "INSERT INTO classes (title, starts_at, capacity) VALUES ('Unlimited', now() + interval '1 day', NULL) RETURNING id"
  );
  return { userId: u[0].id, classId: c[0].id };
}

async function assertUntouched({ userId, classId }) {
  const { rows: u } = await pool.query("SELECT email_verified_at FROM users WHERE id = $1", [userId]);
  assert.equal(u[0].email_verified_at, null, "an unverified account must stay unverified across boots");
  const { rows: c } = await pool.query("SELECT capacity FROM classes WHERE id = $1", [classId]);
  assert.equal(c[0].capacity, null, "a NULL (unlimited) capacity must not be reset across boots");
}

test("re-running migrate does not re-apply old migrations", async () => {
  const seeded = await seedRows("rerun");
  const out = migrate();
  assert.ok(!out.includes("Running migration:"), "nothing should run on an up-to-date database");
  await assertUntouched(seeded);
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM schema_migrations");
  assert.ok(rows[0].n >= 32);
});

test("a database that predates schema_migrations is baselined, not re-migrated", async () => {
  const seeded = await seedRows("legacy");
  await pool.query("DROP TABLE schema_migrations");
  const out = migrate();
  assert.match(out, /Baselined \d+ existing migrations/);
  assert.ok(!out.includes("Running migration:"));
  await assertUntouched(seeded);
});
