// Migration 094 adds CHECK constraints on orders.status, orders.payment_method, book_copies.status and
// class_dropin_seats.status. A CHECK that is narrower than what the code writes would turn a normal action
// into a 500, so this test scans the source for every literal the code writes to those columns and compares
// it with the sets in the migration. Adding a new status in code without widening the CHECK (a new migration)
// fails here, not in production.

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { STATUSES } = require("../../src/lib/inventory");

const ROOT = path.join(__dirname, "..", "..");
const MIGRATION = fs.readFileSync(path.join(ROOT, "migrations", "094_email_case_and_status_checks.sql"), "utf8");

// { "orders.status": Set, ... } from the VALUES list of the migration.
function checkSets() {
  const out = {};
  const re = /\('(\w+)',\s*'(\w+)',\s*'\w+',\s*ARRAY\[([^\]]*)\]\)/g;
  let m;
  while ((m = re.exec(MIGRATION))) out[`${m[1]}.${m[2]}`] = new Set(m[3].split(",").map((x) => x.trim().replace(/^'|'$/g, "")));
  return out;
}

function sourceFiles(dir) {
  const files = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...sourceFiles(p));
    else if (e.name.endsWith(".js")) files.push(p);
  }
  return files;
}

// Splits "a, 'b,c', f(x, y)" on top-level commas.
function topLevelSplit(text) {
  const parts = [];
  let depth = 0, quote = null, cur = "";
  for (const ch of text) {
    if (quote) { cur += ch; if (ch === quote) quote = null; continue; }
    if (ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) { parts.push(cur.trim()); cur = ""; continue; }
    cur += ch;
  }
  parts.push(cur.trim());
  return parts;
}

// Every literal written to table.column by the code: [{ value, where }].
function writtenLiterals(table, column) {
  const found = [];
  const colRe = new RegExp(`\\b(?:\\w+\\.)?${column}\\s*=\\s*'([a-z_]+)'`, "g");
  const updateRe = new RegExp(`UPDATE\\s+${table}(?:\\s+\\w+)?\\s+SET([\\s\\S]*?)(?:\\bWHERE\\b|\\bRETURNING\\b|\`|")`, "g");
  const insertRe = new RegExp(`INSERT\\s+INTO\\s+${table}\\s*\\(([^)]*)\\)\\s*VALUES\\s*\\(([\\s\\S]*?)\\)\\s*(?:ON CONFLICT|RETURNING|\`|"|;)`, "g");
  for (const file of [...sourceFiles(path.join(ROOT, "src")), ...sourceFiles(path.join(ROOT, "scripts"))]) {
    const text = fs.readFileSync(file, "utf8");
    const rel = path.relative(ROOT, file);
    let m;
    while ((m = updateRe.exec(text))) {
      let c;
      colRe.lastIndex = 0;
      while ((c = colRe.exec(m[1]))) found.push({ value: c[1], where: `${rel}: UPDATE ${table} SET ${column}` });
    }
    while ((m = insertRe.exec(text))) {
      const cols = m[1].split(",").map((x) => x.trim());
      const i = cols.indexOf(column);
      if (i < 0) continue;
      const v = topLevelSplit(m[2])[i];
      const lit = v && /^'([a-z_]+)'$/.exec(v);
      if (lit) found.push({ value: lit[1], where: `${rel}: INSERT INTO ${table} (${column})` });
    }
  }
  return found;
}

// orderActions.js needs a database to be required, so its PAYMENT_METHODS list is read from the source.
const PAYMENT_METHODS = [...fs.readFileSync(path.join(ROOT, "src", "lib", "orderActions.js"), "utf8")
  .match(/const PAYMENT_METHODS = \[([\s\S]*?)\];/)[1].matchAll(/value:\s*"(\w+)"/g)].map((m) => ({ value: m[1] }));

const sets = checkSets();

test("the migration lists the four CHECK sets", () => {
  assert.deepEqual(Object.keys(sets).sort(), ["book_copies.status", "class_dropin_seats.status", "orders.payment_method", "orders.status"]);
});

test("every literal the code writes to orders.status is allowed by the CHECK", () => {
  const written = writtenLiterals("orders", "status");
  assert.ok(written.length >= 4, "the scanner found the writes (paid, refunded, cancelled, reserved...)");
  // Statuses passed as a parameter to the shared release helpers: their callers' literals.
  const extra = [];
  for (const file of sourceFiles(path.join(ROOT, "src"))) {
    const text = fs.readFileSync(file, "utf8");
    for (const m of text.matchAll(/releaseReservation\([^)]*?\{[^}]*?status:\s*"(\w+)"/g)) extra.push(m[1]);
    for (const m of text.matchAll(/releaseCartHold\([^)]*?,\s*"(\w+)"\)/g)) extra.push(m[1]);
    for (const m of text.matchAll(/async function releaseReservation\(pool, orderId, \{ status = "(\w+)"/g)) extra.push(m[1]);
    for (const m of text.matchAll(/^\s*status:\s*"(\w+)",\s*reason:/gm)) extra.push(m[1]);
  }
  assert.ok(extra.includes("expired") && extra.includes("cancelled"));
  for (const w of written) assert.ok(sets["orders.status"].has(w.value), `${w.where} writes '${w.value}', which the CHECK forbids`);
  for (const v of extra) assert.ok(sets["orders.status"].has(v), `a release helper writes '${v}', which the CHECK forbids`);
  // And the CHECK allows nothing the code never writes (keeps the set honest), except 'pending' (the old online checkout, still in history).
  const all = new Set([...written.map((w) => w.value), ...extra, "pending"]);
  for (const v of sets["orders.status"]) assert.ok(all.has(v), `the CHECK allows '${v}' but no code writes it`);
});

test("every payment method the code can record is allowed by the CHECK", () => {
  for (const m of PAYMENT_METHODS) assert.ok(sets["orders.payment_method"].has(m.value), `${m.value} is a choice in orderActions.PAYMENT_METHODS`);
  const written = writtenLiterals("orders", "payment_method");
  for (const w of written) assert.ok(sets["orders.payment_method"].has(w.value), `${w.where} writes '${w.value}'`);
  // helloasso / online: old online orders (lib/accounting.js still reads them), allowed on purpose.
  for (const v of ["helloasso", "online"]) assert.ok(sets["orders.payment_method"].has(v));
  assert.deepEqual([...sets["orders.payment_method"]].sort(), [...PAYMENT_METHODS.map((m) => m.value), "helloasso", "online"].sort());
});

test("every book_copies.status the code writes is allowed (the six statuses, in_cart included)", () => {
  for (const s of STATUSES) assert.ok(sets["book_copies.status"].has(s.value), `${s.value} is an admin choice (inventory.STATUSES)`);
  const written = writtenLiterals("book_copies", "status");
  assert.ok(written.length >= 5);
  for (const w of written) assert.ok(sets["book_copies.status"].has(w.value), `${w.where} writes '${w.value}'`);
  assert.deepEqual([...sets["book_copies.status"]].sort(), [...STATUSES.map((s) => s.value), "in_cart"].sort());
});

test("every class_dropin_seats.status the code writes is allowed", () => {
  const written = writtenLiterals("class_dropin_seats", "status");
  assert.ok(written.length >= 4);
  for (const w of written) assert.ok(sets["class_dropin_seats.status"].has(w.value), `${w.where} writes '${w.value}'`);
  for (const v of sets["class_dropin_seats.status"]) assert.ok(written.some((w) => w.value === v) || v === "in_cart", `the CHECK allows '${v}' but no code writes it`);
});

test("the scanner really catches a status that is missing from a set (self-check)", () => {
  const fake = new Set(["in_stock"]);
  const written = writtenLiterals("book_copies", "status");
  assert.ok(written.some((w) => !fake.has(w.value)));
});
