// Guard for the shared CI database (see "Writing tests that are safe on the
// shared CI database" in README.md). In CI every test file runs against ONE
// Postgres database, several at a time, so a file that counts rows, clears a
// table, or relies on per-IP caps fails at random. The rule that makes the
// suite deterministic: a file that gets a database gets its OWN one —
// startTestApp / prepareDatabase / adminHarness all take { isolated: true }.
//
// A file may opt out with a `// shared-db-ok: <why>` comment, but then it must
// not contain a global destructive statement (TRUNCATE, DROP TABLE, an
// unscoped DELETE, `UPDATE orders SET client_ip = NULL` without a row filter
// of its own) because that would hit every other file's rows.
//
// Static source checks, so they are cheap and deterministic; the checker
// itself is exercised against synthetic sources at the bottom so we know it
// really does catch a violation.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const TEST_ROOT = path.join(__dirname, "..");
const DIRS = ["integration", "unit"];
const DB_ENTRY_POINTS = ["startTestApp", "prepareDatabase", "adminHarness"];
const OPT_OUT = /\/\/\s*shared-db-ok:\s*\S/;

// Text of the argument list of the call starting at `open` (the index of "(").
function callArguments(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "(") depth++;
    else if (src[i] === ")" && --depth === 0) return src.slice(open + 1, i);
  }
  return src.slice(open + 1);
}

// Every call to a database entry point in `src` that does not pass isolated: true.
function nonIsolatedCalls(src) {
  const found = [];
  for (const name of DB_ENTRY_POINTS) {
    const re = new RegExp(`(?<![\\w.])${name}\\s*\\(`, "g");
    for (let m; (m = re.exec(src));) {
      const before = src.slice(Math.max(0, src.lastIndexOf("\n", m.index) + 1), m.index);
      if (/\b(function|async function)\s*$/.test(before) || /^\s*(\/\/|\*)/.test(before)) continue; // a definition or a comment
      const args = callArguments(src, m.index + m[0].length - 1);
      if (!/\bisolated:\s*true\b/.test(args)) found.push(name);
    }
  }
  return found;
}

// Statements that act on a whole shared table.
const GLOBAL_DESTRUCTIVE = [
  [/\bTRUNCATE\b/i, "TRUNCATE"],
  [/\bDROP\s+TABLE\b/i, "DROP TABLE"],
  [/\bDELETE\s+FROM\s+\w+\s*(?=["'`;)]|$)/im, "DELETE FROM <table> with no WHERE"],
  // Counting (or resetting) every account in the database: other files create users and admins at the same time,
  // so "exactly one admin" or "n users" is only true in a database of your own.
  [/\bcount\(\*\)(?:::\w+)?\s*(?:AS\s+\w+\s+)?FROM\s+users\s*(?:WHERE\s+(?:NOT\s+)?is_(?:admin|disabled|member|till|volunteer)\b[^"'`;)]*)?(?=["'`;)])/i, "count of all users / all admins (not limited to ids this test created)"],
  [/\bUPDATE\s+users\s+SET\s+is_admin\s*=\s*(?:false|FALSE)\s+WHERE\s+is_admin\s*(?=["'`;)])/, "UPDATE users SET is_admin = false for every admin"],
  [/\bUPDATE\s+orders\s+SET\s+client_ip\s*=\s*NULL\s*(?:WHERE\s+client_ip\s+IS\s+NOT\s+NULL\s*)?(?=["'`;)])/i, "UPDATE orders SET client_ip = NULL for every order"],
];

function globalDestructiveStatements(src) {
  return GLOBAL_DESTRUCTIVE.filter(([re]) => re.test(src)).map(([, label]) => label);
}

function testFiles() {
  const out = [];
  for (const dir of DIRS) {
    for (const f of fs.readdirSync(path.join(TEST_ROOT, dir))) {
      if (f.endsWith(".test.js") && f !== path.basename(__filename)) out.push(path.join(dir, f));
    }
  }
  return out;
}

test("every test file that gets a database gets its own (isolated: true), unless it opts out with a reason", () => {
  const offenders = [];
  for (const rel of testFiles()) {
    const src = fs.readFileSync(path.join(TEST_ROOT, rel), "utf8");
    if (OPT_OUT.test(src)) continue;
    const calls = nonIsolatedCalls(src);
    if (calls.length) offenders.push(`${rel}: ${calls.join(", ")} without isolated: true`);
  }
  assert.deepEqual(offenders, [], `On the shared CI database these tests see each other's rows. Pass { isolated: true }, or add "// shared-db-ok: <why>" if the file only touches rows it created itself and never counts or clears anything global.\n${offenders.join("\n")}`);
});

test("a file that opts out of isolation contains no global destructive statement", () => {
  const offenders = [];
  for (const rel of testFiles()) {
    const src = fs.readFileSync(path.join(TEST_ROOT, rel), "utf8");
    if (!OPT_OUT.test(src)) continue;
    for (const label of globalDestructiveStatements(src)) offenders.push(`${rel}: ${label}`);
  }
  assert.deepEqual(offenders, []);
});

// ---- the checker itself (so a green run means something) ----

test("checker: flags a non-isolated database entry point, accepts isolated ones", () => {
  assert.deepEqual(nonIsolatedCalls('app = await startTestApp({ port: 3999 });'), ["startTestApp"]);
  assert.deepEqual(nonIsolatedCalls('const db = prepareDatabase("x");'), ["prepareDatabase"]);
  assert.deepEqual(nonIsolatedCalls('const h = adminHarness("x", ["a"]);'), ["adminHarness"]);
  assert.deepEqual(nonIsolatedCalls('app = await startTestApp({ port: 3999, isolated: true });'), []);
  assert.deepEqual(nonIsolatedCalls('const db = prepareDatabase("x", { isolated: true });'), []);
  assert.deepEqual(nonIsolatedCalls('const h = adminHarness("x", ["a"], { isolated: true });'), []);
  // multi-line options, a second app in the same file
  assert.deepEqual(nonIsolatedCalls('a = await startTestApp({\n  port: 1,\n  isolated: true,\n  env: { A: "(" },\n});\nb = await startTestApp({ port: 2 });'), ["startTestApp"]);
  // definitions and comments are not calls
  assert.deepEqual(nonIsolatedCalls("function startTestApp(opts) {}\n// startTestApp(x)\n"), []);
});

test("checker: flags statements that act on a whole shared table", () => {
  const flagged = (sql) => globalDestructiveStatements(`await pool.query("${sql}");`);
  assert.equal(flagged("UPDATE orders SET client_ip = NULL WHERE client_ip IS NOT NULL").length, 1);
  assert.equal(flagged("UPDATE orders SET client_ip = NULL").length, 1);
  assert.equal(flagged("DELETE FROM session").length, 1);
  assert.equal(flagged("DELETE FROM books").length, 1);
  assert.equal(flagged("TRUNCATE orders CASCADE").length, 1);
  assert.equal(flagged("DROP TABLE schema_migrations").length, 1);
  // global account counts and admin resets (the adminRoleToggles pattern)
  assert.equal(flagged("SELECT count(*)::int AS n FROM users WHERE is_admin AND NOT is_disabled").length, 1);
  assert.equal(flagged("SELECT count(*) FROM users").length, 1);
  assert.equal(flagged("UPDATE users SET is_admin = false WHERE is_admin").length, 1);
  assert.equal(flagged("SELECT count(*) FROM users WHERE id = ANY($1)").length, 0);
  assert.equal(flagged("SELECT count(*) FROM users WHERE email = $1").length, 0);
  // scoped to the test's own rows: fine
  assert.equal(flagged("UPDATE orders SET client_ip = NULL WHERE buyer_email = $1").length, 0);
  assert.equal(flagged("DELETE FROM books WHERE id = $1").length, 0);
});
