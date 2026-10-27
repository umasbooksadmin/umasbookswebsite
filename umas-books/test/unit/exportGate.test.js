"use strict";

// The idempotent gates (.github/scripts/export-gate.sh) and the freshness checks
// (.github/scripts/export-freshness.sh) run for real here, with a fake clock (GATE_NOW) and a fake
// `aws` that answers from a list of "keys in Backblaze". This is the proof that a delayed or
// dropped scheduled run is recovered, and that the exports never run twice for the same period.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const scripts = path.join(__dirname, "..", "..", "..", ".github", "scripts");
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gate-"));
const fakeAws = path.join(dir, "aws");
fs.writeFileSync(fakeAws, `#!/usr/bin/env bash
# fake aws s3api list-objects-v2: KEYS = newline list of keys, LASTMOD = LastModified of the newest key, FAIL=1 = error
[ "\${FAIL:-}" = "1" ] && { echo "boom" >&2; exit 255; }
prefix=""; q=""
while [ $# -gt 0 ]; do case "$1" in --prefix) prefix="$2"; shift ;; --query) q="$2"; shift ;; esac; shift; done
case "$q" in
  *LastModified*) [ -n "\${KEYS:-}" ] && echo "\${LASTMOD:-None}" || echo None ;;
  *) n=0; while IFS= read -r k; do case "$k" in "$prefix"*) n=$((n+1)) ;; esac; done <<< "\${KEYS:-}"; echo "$n" ;;
esac
`, { mode: 0o755 });

function run(script, kind, env) {
  const out = path.join(dir, `out-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(out, "");
  const r = spawnSync("bash", [path.join(scripts, script), kind], {
    env: { PATH: process.env.PATH, AWS_BIN: fakeAws, GITHUB_OUTPUT: out, BUCKET: "b", ENDPOINT: "e", ...env }, encoding: "utf8",
  });
  const outputs = Object.fromEntries(fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  return { code: r.status, outputs, log: r.stdout + r.stderr };
}
const gate = (kind, env) => run("export-gate.sh", kind, env);
const fresh = (kind, env) => run("export-freshness.sh", kind, env);

const FILE = "accounting-exports/2026/accounting_2026-09.csv";

test("accounting gate: the six cases of the brief", () => {
  const cases = [
    ["1st at 07:05 Paris, file absent", { GATE_NOW: "2026-10-01 07" }, "true"],
    ["1st at 09:30 Paris (late run), file absent", { GATE_NOW: "2026-10-01 09" }, "true"],
    ["2nd, file absent (retry the next day)", { GATE_NOW: "2026-10-02 06" }, "true"],
    ["2nd, file present", { GATE_NOW: "2026-10-02 06", KEYS: FILE }, "false"],
    ["15th, file absent", { GATE_NOW: "2026-10-15 07" }, "false"],
    ["manual dispatch (ignore_time_check true), 15th, file present", { GATE_NOW: "2026-10-15 07", KEYS: FILE, IGNORE: "true" }, "true"],
  ];
  for (const [name, env, want] of cases) {
    const r = gate("accounting", env);
    assert.equal(r.code, 0, name);
    assert.equal(r.outputs.run, want, `${name}: ${r.log}`);
    console.log(`  ${name} -> run=${r.outputs.run}`);
  }
});

test("accounting gate: a month typed by hand always runs; January looks at December of the year before", () => {
  assert.equal(gate("accounting", { GATE_NOW: "2026-10-15 07", KEYS: FILE, MONTH_INPUT: "2026-09" }).outputs.run, "true");
  assert.equal(gate("accounting", { GATE_NOW: "2027-01-02 08", KEYS: "accounting-exports/2026/accounting_2026-12.csv" }).outputs.run, "false");
  assert.equal(gate("accounting", { GATE_NOW: "2027-01-02 08", KEYS: FILE }).outputs.run, "true", "Dec 2026 file is absent (only Sept present)");
  assert.equal(gate("accounting", { GATE_NOW: "2026-10-03 23" }).outputs.run, "true", "3rd, any hour");
  assert.equal(gate("accounting", { GATE_NOW: "2026-10-04 06" }).outputs.run, "false", "4th: the freshness check takes over");
});

test("accounting gate: only that month's accounting file counts (other files or months do not)", () => {
  const others = ["accounting-exports/2026/till_days_2026-09.csv", "accounting-exports/2026/accounting_2026-08.csv", "inventory-exports/accounting_2026-09.csv"].join("\n");
  assert.equal(gate("accounting", { GATE_NOW: "2026-10-02 06", KEYS: others }).outputs.run, "true");
});

test("gates: if Backblaze cannot be asked, the export runs anyway (with a warning)", () => {
  const a = gate("accounting", { GATE_NOW: "2026-10-01 07", FAIL: "1" });
  assert.equal(a.outputs.run, "true");
  assert.match(a.log, /::warning title=Export gate could not read Backblaze/);
  assert.equal(gate("inventory", { GATE_NOW: "2026-10-27 21", FAIL: "1" }).outputs.run, "true");
});

test("inventory gate: 21h-23h run only while today's file is absent; earlier hours never", () => {
  const today = "inventory-exports/inventory_books_2026-10-27.csv";
  const want = (hour, keys, ignore) => gate("inventory", { GATE_NOW: `2026-10-27 ${hour}`, KEYS: keys || "", IGNORE: ignore || "" }).outputs.run;
  assert.equal(want("21"), "true");
  assert.equal(want("22"), "true", "late run, tolerated");
  assert.equal(want("23"), "true");
  assert.equal(want("20"), "false", "the winter-time duplicate line one hour early");
  assert.equal(want("0"), "true", "a run GitHub delayed past midnight still owes yesterday's file");
  assert.equal(want("0", "inventory-exports/inventory_books_2026-10-26.csv"), "false", "yesterday's file exists");
  assert.equal(want("1", today), "true", "today's file is not yesterday's");
  assert.equal(want("6"), "false", "morning: nothing owed");
  assert.equal(want("22", today), "false", "already done tonight");
  assert.equal(want("21", "inventory-exports/inventory_books_2026-10-26.csv"), "true", "yesterday's file is not tonight's");
  assert.equal(want("10", today, "true"), "true", "manual");
});

test("freshness accounting: required from the 3rd, names the month in the alert", () => {
  const f = (now, keys) => fresh("accounting", { GATE_NOW: now, KEYS: keys || "" });
  assert.equal(f("2026-10-02 09").outputs.missing, "false", "the 2nd: not required yet");
  const m = f("2026-10-03 09");
  assert.equal(m.outputs.missing, "true");
  assert.equal(m.outputs.label, "2026-09");
  assert.match(m.outputs.reason, /accounting export for 2026-09 is missing/);
  assert.equal(f("2026-10-03 09", FILE).outputs.missing, "false");
  assert.equal(f("2026-10-20 09").outputs.missing, "true", "stays an alert until fixed");
  assert.equal(f("2027-01-05 09").outputs.label, "2026-12");
  assert.equal(fresh("accounting", { GATE_NOW: "2026-10-05 09", FAIL: "1" }).outputs.missing, "true", "cannot check = report");
});

test("freshness inventory: newest file under 36 hours", () => {
  const now = Date.parse("2026-10-27T10:00:00Z") / 1000;
  const f = (lastmod, keys) => fresh("inventory", { FRESH_NOW_EPOCH: String(now), KEYS: keys === undefined ? "inventory-exports/inventory_latest.csv" : keys, LASTMOD: lastmod });
  assert.equal(f("2026-10-26T19:00:12+00:00").outputs.missing, "false");
  assert.equal(f("2026-10-25T22:30:00+00:00").outputs.missing, "false", "35.5 hours");
  const old = f("2026-10-25T21:00:00+00:00");
  assert.equal(old.outputs.missing, "true");
  assert.match(old.outputs.reason, /37 hours old/);
  assert.equal(f(undefined, "").outputs.missing, "true", "folder empty");
});
