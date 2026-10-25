// Migration 097: the nullable French columns next to the English ones of events, classes, announcements, charities and
// charity_rounds. Nullable text with NO default (adding one rewrites no rows and invents no French), nothing machine
// translated, no table added, and running the statements again changes nothing.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { prepareDatabase } = require("../helpers/testDatabase");

const db = prepareDatabase("events_french_migration", { isolated: true });
const { pool } = require("../../src/db");
before(() => db.create());
after(async () => { await pool.end(); db.drop(); });

const FILE = path.join(__dirname, "..", "..", "migrations", "097_events_sessions_french.sql");
const EXPECTED = {
  events: ["description_fr", "location_fr", "title_fr"],
  classes: ["title_fr"],
  announcements: ["body_fr", "excerpt_fr", "title_fr"],
  charities: ["description_fr"],
  charity_rounds: ["title_fr"],
};

test("every French column exists, is nullable text and has no default", async () => {
  for (const [table, cols] of Object.entries(EXPECTED)) {
    const { rows } = await pool.query(
      "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = $1 AND column_name = ANY($2) ORDER BY 1", [table, cols]
    );
    assert.deepEqual(rows.map((r) => [r.column_name, r.data_type, r.is_nullable, r.column_default]), cols.map((c) => [c, "text", "YES", null]), table);
  }
});

test("the migration only adds nullable columns: no table, no data change, no machine translation, and it can run twice", async () => {
  const sql = fs.readFileSync(FILE, "utf8");
  const statements = sql.replace(/--.*$/gm, "").split(";").map((s) => s.trim()).filter(Boolean);
  assert.ok(statements.length > 0 && statements.every((s) => /^ALTER TABLE \w+ ADD COLUMN IF NOT EXISTS \w+_fr TEXT$/.test(s)), "only ALTER TABLE ... ADD COLUMN IF NOT EXISTS x_fr TEXT");
  await pool.query("INSERT INTO events (title, starts_at) VALUES ('Before rerun', now())");
  await pool.query(sql);
  const { rows } = await pool.query("SELECT title, title_fr, description_fr, location_fr FROM events WHERE title = 'Before rerun'");
  assert.deepEqual(rows, [{ title: "Before rerun", title_fr: null, description_fr: null, location_fr: null }]);
  for (const table of Object.keys(EXPECTED)) {
    const { rows: n } = await pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${EXPECTED[table].map((c) => `${c} IS NOT NULL`).join(" OR ")}`);
    assert.equal(n[0].n, 0, `${table}: no French text invented`);
  }
});
