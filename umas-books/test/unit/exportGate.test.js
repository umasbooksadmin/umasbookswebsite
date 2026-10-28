"use strict";

// The idempotent gates (.github/scripts/export-gate.sh) and the freshness checks
// (.github/scripts/export-freshness.sh) run for real here, with a fake clock (GATE_NOW) and a fake
// `aws` (test/helpers/fake-aws.sh) whose bucket holds keys WITH their LastModified, so the rule
// "a file only counts if it was written after the period it covers ended" is exercised for real.
// The whole-workflow replays (late runs, manual runs, DST nights, the real run times) are in
// exportSchedule.test.js.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { makeSandbox, writeState } = require("../helpers/workflowSim");

const scripts = path.join(__dirname, "..", "..", "..", ".github", "scripts");
const sandbox = makeSandbox();

// objects: { key: LastModified ISO } in the fake bucket.
function run(script, kind, env, objects = {}) {
  const out = path.join(sandbox.dir, `out-${Math.random().toString(36).slice(2)}`);
  const state = path.join(sandbox.dir, `state-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(out, "");
  writeState(state, objects);
  const r = spawnSync("bash", [path.join(scripts, script), kind], {
    env: { PATH: process.env.PATH, AWS_BIN: sandbox.aws, GITHUB_OUTPUT: out, S3_STATE: state, BUCKET: "b", ENDPOINT: "e", ...env }, encoding: "utf8",
  });
  const outputs = Object.fromEntries(fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  return { code: r.status, outputs, log: r.stdout + r.stderr };
}
const gate = (kind, env, objects) => run("export-gate.sh", kind, env, objects);
const fresh = (kind, env, objects) => run("export-freshness.sh", kind, env, objects);

const FILE = "accounting-exports/2026/accounting_2026-09.csv";
const AFTER_SEPT = { [FILE]: "2026-10-01T05:03:00+00:00" }; // written on the 1st: the real export

test("accounting gate: the six cases of the brief", () => {
  const cases = [
    ["1st at 07:05 Paris, file absent", { GATE_NOW: "2026-10-01 07" }, {}, "true"],
    ["1st at 09:30 Paris (late run), file absent", { GATE_NOW: "2026-10-01 09" }, {}, "true"],
    ["2nd, file absent (retry the next day)", { GATE_NOW: "2026-10-02 06" }, {}, "true"],
    ["2nd, file present", { GATE_NOW: "2026-10-02 06" }, AFTER_SEPT, "false"],
    ["15th, file absent", { GATE_NOW: "2026-10-15 07" }, {}, "false"],
    ["manual dispatch (ignore_time_check true), 15th, file present", { GATE_NOW: "2026-10-15 07", IGNORE: "true" }, AFTER_SEPT, "true"],
  ];
  for (const [name, env, objects, want] of cases) {
    const r = gate("accounting", env, objects);
    assert.equal(r.code, 0, name);
    assert.equal(r.outputs.run, want, `${name}: ${r.log}`);
  }
});

test("accounting gate: a file written BEFORE the month ended (a current-month test run) does not count", () => {
  // 30 Sept 23:59 Paris (CEST) = 21:59 UTC: still September. 1 Oct 00:00 Paris = 30 Sept 22:00 UTC.
  const at = (lm) => gate("accounting", { GATE_NOW: "2026-10-01 07" }, { [FILE]: lm });
  const early = at("2026-09-15T10:00:00+00:00");
  assert.equal(early.outputs.run, "true", early.log);
  assert.match(early.log, /before the end of 2026-09/);
  assert.equal(at("2026-09-30T21:59:59+00:00").outputs.run, "true", "one second before midnight Paris");
  assert.equal(at("2026-09-30T22:00:00+00:00").outputs.run, "false", "midnight Paris, summer time");
  // winter: 1 Dec 00:00 Paris = 30 Nov 23:00 UTC
  const nov = "accounting-exports/2026/accounting_2026-11.csv";
  assert.equal(gate("accounting", { GATE_NOW: "2026-12-01 07" }, { [nov]: "2026-11-30T22:30:00+00:00" }).outputs.run, "true", "23:30 Paris on 30 Nov");
  assert.equal(gate("accounting", { GATE_NOW: "2026-12-01 07" }, { [nov]: "2026-11-30T23:00:00.000Z" }).outputs.run, "false", "midnight Paris, winter time (Backblaze's .000Z form)");
});

test("accounting gate: a month typed by hand always runs; January looks at December of the year before", () => {
  assert.equal(gate("accounting", { GATE_NOW: "2026-10-15 07", MONTH_INPUT: "2026-09" }, AFTER_SEPT).outputs.run, "true");
  assert.equal(gate("accounting", { GATE_NOW: "2027-01-02 08" }, { "accounting-exports/2026/accounting_2026-12.csv": "2027-01-01T06:02:00+00:00" }).outputs.run, "false");
  assert.equal(gate("accounting", { GATE_NOW: "2027-01-02 08" }, AFTER_SEPT).outputs.run, "true", "Dec 2026 file is absent (only Sept present)");
  assert.equal(gate("accounting", { GATE_NOW: "2026-10-03 23" }).outputs.run, "true", "3rd, any hour");
  assert.equal(gate("accounting", { GATE_NOW: "2026-10-04 06" }).outputs.run, "false", "4th: the freshness check takes over");
});

test("accounting gate: only that month's accounting file counts (other files, months or longer names do not)", () => {
  const lm = "2026-10-01T05:03:00+00:00";
  const others = { "accounting-exports/2026/till_days_2026-09.csv": lm, "accounting-exports/2026/accounting_2026-08.csv": lm, "inventory-exports/accounting_2026-09.csv": lm, [`${FILE}.bak`]: lm };
  assert.equal(gate("accounting", { GATE_NOW: "2026-10-02 06" }, others).outputs.run, "true");
});

test("gates: if Backblaze cannot be asked, the export runs anyway (with a warning)", () => {
  const a = gate("accounting", { GATE_NOW: "2026-10-01 07", FAIL: "1" });
  assert.equal(a.outputs.run, "true");
  assert.match(a.log, /::warning title=Export gate could not read Backblaze/);
  const i = gate("inventory", { GATE_NOW: "2026-10-27 21", FAIL: "1" });
  assert.equal(i.outputs.run, "true");
  assert.equal(i.outputs.day, "2026-10-27", "still says which day to export");
});

test("inventory gate: decides for ONE day and says which; only an evening file (from 21:00 Paris that day) counts", () => {
  const books = (d) => `inventory-exports/inventory_books_${d}.csv`;
  const g = (hour, objects = {}, ignore = "") => gate("inventory", { GATE_NOW: `2026-10-27 ${hour}`, IGNORE: ignore }, objects).outputs;
  // 27 Oct 2026 is winter time (CET, UTC+1): 21:00 Paris = 20:00 UTC.
  const evening27 = { [books("2026-10-27")]: "2026-10-27T20:04:00+00:00" };
  const daytime27 = { [books("2026-10-27")]: "2026-10-27T12:33:00+00:00" }; // the manual run of 13:31 Paris
  const evening26 = { [books("2026-10-26")]: "2026-10-26T23:02:00+00:00" }; // a delayed run, 00:02 Paris on the 27th
  assert.deepEqual(g("21"), { run: "true", day: "2026-10-27", manual: "false" });
  assert.equal(g("22").run, "true", "late run, tolerated");
  assert.equal(g("23").run, "true");
  assert.equal(g("20").run, "false", "the winter-time duplicate line one hour early");
  assert.equal(g("6").run, "false", "morning: nothing owed");
  assert.deepEqual(g("22", evening27), { run: "false", day: "2026-10-27", manual: "false" }, "already done tonight");
  assert.deepEqual(g("21", daytime27), { run: "true", day: "2026-10-27", manual: "false" }, "a daytime manual run does NOT cancel the evening export");
  assert.equal(g("21", { [books("2026-10-27")]: "2026-10-27T19:59:59+00:00" }).run, "true", "20:59:59 Paris is not the evening yet");
  assert.equal(g("21", { [books("2026-10-27")]: "2026-10-27T20:00:00+00:00" }).run, "false", "21:00:00 Paris is");
  assert.equal(g("21", evening26).run, "true", "yesterday's file is not tonight's");
  // after midnight: the day is yesterday
  assert.deepEqual(g("0"), { run: "true", day: "2026-10-26", manual: "false" }, "a run GitHub delayed past midnight still owes yesterday's export");
  assert.deepEqual(g("1", evening26), { run: "false", day: "2026-10-26", manual: "false" }, "yesterday's evening file exists");
  assert.equal(g("1", { [books("2026-10-26")]: "2026-10-26T10:00:00+00:00" }).run, "true", "yesterday's DAYTIME file does not count");
  assert.equal(g("5", evening27).run, "true", "today's file is not yesterday's");
  // manual
  assert.deepEqual(g("10", evening27, "true"), { run: "true", day: "2026-10-27", manual: "true" });
  assert.deepEqual(g("0", {}, "true"), { run: "true", day: "2026-10-27", manual: "true" }, "manual after midnight: today's date");
});

test("freshness accounting: required from the 3rd, names the month, ignores a file written during the month", () => {
  const f = (now, objects) => fresh("accounting", { GATE_NOW: now }, objects);
  assert.equal(f("2026-10-02 09").outputs.missing, "false", "the 2nd: not required yet");
  const m = f("2026-10-03 09");
  assert.equal(m.outputs.missing, "true");
  assert.equal(m.outputs.label, "2026-09");
  assert.match(m.outputs.reason, /accounting export for 2026-09 is missing/);
  assert.equal(f("2026-10-03 09", AFTER_SEPT).outputs.missing, "false");
  const early = f("2026-10-03 09", { [FILE]: "2026-09-20T10:00:00+00:00" });
  assert.equal(early.outputs.missing, "true", "only a test run's file, from before the month ended");
  assert.match(early.outputs.reason, /before the month ended/);
  assert.equal(f("2026-10-20 09").outputs.missing, "true", "stays an alert until fixed");
  assert.equal(f("2027-01-05 09").outputs.label, "2026-12");
  assert.equal(fresh("accounting", { GATE_NOW: "2026-10-05 09", FAIL: "1" }).outputs.missing, "true", "cannot check = report");
});

test("freshness inventory: last night's END-OF-DAY export must be there (a daytime run does not count)", () => {
  const books26 = "inventory-exports/inventory_books_2026-10-26.csv";
  const f = (now, objects) => fresh("inventory", { GATE_NOW: now }, objects).outputs;
  // the check runs at 09:00 UTC = 10:00 Paris
  assert.equal(f("2026-10-27 10", { [books26]: "2026-10-26T23:02:00+00:00" }).missing, "false", "exported 00:02 Paris (a delayed run)");
  assert.equal(f("2026-10-27 10", { [books26]: "2026-10-26T20:00:00+00:00" }).missing, "false", "exported at 21:00 Paris");
  const day = f("2026-10-27 10", { [books26]: "2026-10-26T14:00:00+00:00", "inventory-exports/inventory_latest.csv": "2026-10-27T08:00:00+00:00" });
  assert.equal(day.missing, "true", "only a daytime manual run on the 26th, however fresh the latest file is");
  assert.equal(day.label, "2026-10-26");
  assert.match(day.reason, /only written by a run during the day/);
  const none = f("2026-10-27 10", { "inventory-exports/inventory_books_2026-10-25.csv": "2026-10-25T20:03:00+00:00" });
  assert.equal(none.missing, "true", "the evening before does not count for last night");
  assert.match(none.reason, /end-of-day inventory export for 2026-10-26 is missing/);
  assert.equal(f("2026-10-27 03", { "inventory-exports/inventory_books_2026-10-25.csv": "2026-10-25T20:03:00+00:00" }).missing, "false",
    "before 06:00 the night is not over: it checks the evening before");
  assert.equal(fresh("inventory", { GATE_NOW: "2026-10-27 10", FAIL: "1" }).outputs.missing, "true", "cannot check = report");
});

test("the fake aws refuses a query it does not know (so the tests cannot pass against a guess)", () => {
  const r = spawnSync("bash", [sandbox.aws, "s3api", "list-objects-v2", "--prefix", "x", "--query", "Contents[0].Key", "--output", "text"],
    { env: { PATH: process.env.PATH, S3_STATE: path.join(sandbox.dir, "unused") }, encoding: "utf8" });
  assert.equal(r.status, 3);
  assert.match(r.stderr, /unsupported query/);
});
