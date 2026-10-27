"use strict";

// END-TO-END replays of the scheduled exports: each run executes the workflow file's own steps
// (export-gate.sh, then the export, upload and email-text steps as written in the YAML, with the
// real export scripts against an empty database) at a simulated time, against one fake Backblaze
// bucket that remembers each file's LastModified (test/helpers/workflowSim.js). The assertions are
// about what ends up in the bucket and under which date, not about the gate's own outputs:
//   - every Paris evening gets exactly ONE end-of-day inventory export, dated that evening, even when
//     GitHub starts the runs after midnight, around a summer/winter time change, or after a manual run;
//   - a test run of an unfinished accounting month never stands in for the real export on the 1st.
// The last inventory test replays the REAL start times of the workflow's runs (from `gh run list`).

const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const sim = require("../helpers/workflowSim");
const REAL_RUNS = require("../fixtures/inventory-export-runs.json").runs;

const MANUAL = { ignore_time_check: "true" };
const parisMs = (day, hhmm) => { // the UTC instant of a Paris wall-clock time (tz database via Intl)
  for (const off of [1, 2]) {
    const ms = Date.parse(`${day}T${hhmm}:00Z`) - off * 3600000;
    if (sim.parisHour(new Date(ms).toISOString()) === `${day} ${hhmm.slice(0, 2)}`) return ms;
  }
  throw new Error(`no Paris time ${day} ${hhmm}`);
};

function inventoryRuns(runs, preset = {}) {
  const sb = sim.makeSandbox();
  sim.writeState(path.join(sb.dir, "bucket"), preset);
  const results = runs.map(([iso, inputs]) => {
    const r = sim.runWorkflow(sb, "inventory-export.yml", iso, inputs || {});
    const books = r.uploaded.filter((k) => /inventory_books_/.test(k));
    const copies = r.uploaded.filter((k) => /inventory_\d/.test(k));
    assert.ok(books.length <= 1);
    const exported = books.length ? books[0].match(/inventory_books_(.+)\.csv$/)[1] : null;
    if (exported) assert.deepEqual(copies, [`inventory-exports/inventory_${exported}.csv`], "the per-copy file has the same date");
    return { iso, paris: sim.parisHour(iso), manual: !!inputs, exported, attach: r.steps.attach || {} };
  });
  return { sb, results, bucket: () => sim.readState(path.join(sb.dir, "bucket")) };
}

function freshness(sb, kind, gateNow) {
  const out = path.join(sb.dir, `fresh-${Math.random().toString(36).slice(2)}`);
  require("node:fs").writeFileSync(out, "");
  spawnSync("bash", [path.join(sim.root, ".github", "scripts", "export-freshness.sh"), kind], {
    env: { PATH: process.env.PATH, AWS_BIN: sb.aws, S3_STATE: path.join(sb.dir, "bucket"), GITHUB_OUTPUT: out, BUCKET: "b", ENDPOINT: "e", GATE_NOW: gateNow }, encoding: "utf8",
  });
  return Object.fromEntries(require("node:fs").readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

const table = [];
function scenario(name, runs, want, preset) {
  const { results, sb, bucket } = inventoryRuns(runs, preset);
  const got = results.map((r) => r.exported);
  table.push(`${name}\n${results.map((r) => `    ${r.iso} (Paris ${r.paris}h${r.manual ? ", manual" : ""}) -> ${r.exported ? `export ${r.exported}` : "skip"}`).join("\n")}`);
  assert.deepEqual(got, want, `${name}\n${table[table.length - 1]}`);
  return { results, sb, bucket };
}

test("inventory: a daytime manual run, then the 21h scheduled runs (27 Oct 2026, winter time)", () => {
  const { results, sb } = scenario("daytime manual run, then 21h scheduled", [
    ["2026-10-27T12:31:27Z", MANUAL], // the real manual run of 27 Oct, 13:31 Paris
    ["2026-10-27T19:00:00Z"], // 20:00 Paris: too early
    ["2026-10-27T20:00:00Z"], // 21:00 Paris: MUST run, the manual file does not count
    ["2026-10-27T21:00:00Z"], ["2026-10-27T22:00:00Z"],
  ], ["2026-10-27", null, "2026-10-27", null, null]);
  // the email does not pretend a manual daytime run is the 21:00 export
  assert.match(results[0].attach.subject, /manual run/);
  assert.doesNotMatch(results[0].attach.intro, /21:00/);
  assert.match(results[0].attach.intro, /as of 2026-10-27 \d\d:\d\d Paris time \(a manual run/);
  assert.match(results[2].attach.intro, /end-of-day inventory of Uma's Books for 2026-10-27/);
  assert.doesNotMatch(results[2].attach.subject, /manual/);
  assert.equal(freshness(sb, "inventory", "2026-10-28 10").missing, "false");
});

test("inventory: the manual run alone (evening runs dropped) is reported missing the next morning", () => {
  const { sb } = scenario("manual run only, evening runs dropped", [["2026-10-27T12:31:27Z", MANUAL]], ["2026-10-27"]);
  const f = freshness(sb, "inventory", "2026-10-28 10");
  assert.equal(f.missing, "true", "the old 36-hour check called this fresh");
  assert.equal(f.label, "2026-10-27");
});

test("inventory: a 21h run when that evening's file already exists does nothing", () => {
  scenario("21h run when the evening file exists", [["2026-10-27T21:00:00Z"], ["2026-10-27T22:00:00Z"]], [null, null],
    { "inventory-exports/inventory_books_2026-10-27.csv": "2026-10-27T20:03:00+00:00" });
});

test("inventory: only post-midnight runs on a night (the real night of 26 Oct), then the next evening", () => {
  const { bucket, sb } = scenario("only post-midnight runs, then the next evening", [
    ["2026-10-26T23:00:55Z"], // 00:00 Paris on the 27th: exports the 26th
    ["2026-10-26T23:31:30Z"], // 00:31: the 26th is done, skip (no second email)
    ["2026-10-27T20:00:00Z"], // that evening, 21:00: MUST run for the 27th
  ], ["2026-10-26", null, "2026-10-27"]);
  const written = Date.parse(bucket()["inventory-exports/inventory_books_2026-10-26.csv"]);
  assert.ok(written > Date.parse("2026-10-26T23:00:55Z") && written < Date.parse("2026-10-26T23:31:30Z"), "the 26th's file was written once, by the first run");
  assert.equal(freshness(sb, "inventory", "2026-10-27 10").missing, "false");
});

test("inventory: autumn DST night (Sat 24 -> Sun 25 Oct 2026, 03:00 CEST becomes 02:00 CET)", () => {
  scenario("DST autumn night, delayed runs on both sides of the change", [
    ["2026-10-24T22:12:28Z"], // 00:12 CEST on the 25th: exports the 24th
    ["2026-10-25T00:30:00Z"], // 02:30 CEST
    ["2026-10-25T01:30:00Z"], // 02:30 CET (the same wall-clock hour again)
    ["2026-10-25T19:00:00Z"], // 20:00 CET: too early on the first winter evening
    ["2026-10-25T20:00:00Z"], // 21:00 CET
  ], ["2026-10-24", null, null, null, "2026-10-25"]);
  scenario("DST autumn: a manual run at 20:30 CET (after 21:00 summer time!) does not count", [
    ["2026-10-25T19:30:00Z", MANUAL], ["2026-10-25T20:00:00Z"], ["2026-10-25T21:00:00Z"],
  ], ["2026-10-25", "2026-10-25", null]);
});

test("inventory: spring DST night (Sat 27 -> Sun 28 Mar 2027, 02:00 CET becomes 03:00 CEST)", () => {
  scenario("DST spring night, delayed runs on both sides of the change", [
    ["2027-03-27T23:10:00Z"], // 00:10 CET on the 28th: exports the 27th
    ["2027-03-28T00:59:00Z"], // 01:59 CET
    ["2027-03-28T01:30:00Z"], // 03:30 CEST
    ["2027-03-28T19:00:00Z"], // 21:00 CEST: the first summer evening
    ["2027-03-28T20:00:00Z"],
  ], ["2027-03-27", null, null, "2027-03-28", null]);
  scenario("DST spring: a manual run at 21:30 CEST counts as that evening's export", [
    ["2027-03-28T19:30:00Z", MANUAL], ["2027-03-28T20:00:00Z"], ["2027-03-28T21:00:00Z"],
  ], ["2027-03-28", null, null]);
});

test("inventory: month and year boundaries", () => {
  scenario("month and year boundaries", [
    ["2026-10-31T23:40:00Z"], // 00:40 Paris on 1 Nov: exports 31 Oct
    ["2026-11-01T01:10:00Z"],
    ["2026-11-01T20:00:00Z"], // 21:00 on 1 Nov
    ["2026-12-31T23:30:00Z"], // 00:30 on 1 Jan 2027: exports 31 Dec 2026
    ["2027-01-01T02:00:00Z"],
    ["2027-01-01T20:00:00Z"],
  ], ["2026-10-31", null, "2026-11-01", "2026-12-31", null, "2027-01-01"]);
});

test("inventory: replay of the REAL run start times (gh run list) plus tonight's schedule: one export per Paris evening", () => {
  const tonight = ["2026-10-27T19:00:00Z", "2026-10-27T20:00:00Z", "2026-10-27T21:00:00Z", "2026-10-27T22:00:00Z"];
  const runs = [...REAL_RUNS.map((r) => [r.createdAt, r.event === "workflow_dispatch" ? MANUAL : null]), ...tonight.map((t) => [t, null])];
  const { results, sb, bucket } = inventoryRuns(runs);
  const lines = results.map((r) => `    ${r.iso} (Paris ${r.paris}h${r.manual ? ", manual" : ""}) -> ${r.exported ? `export ${r.exported}` : "skip"}`);
  const evenings = [];
  for (let d = Date.parse("2026-10-09T12:00:00Z"); d <= Date.parse("2026-10-27T12:00:00Z"); d += 86400000) evenings.push(new Date(d).toISOString().slice(0, 10));
  const scheduled = {};
  for (const r of results.filter((x) => !x.manual && x.exported)) (scheduled[r.exported] = scheduled[r.exported] || []).push(r.iso);
  const wrong = evenings.filter((d) => (scheduled[d] || []).length !== 1).map((d) => `${d}: ${(scheduled[d] || []).length} exports`);
  assert.deepEqual(wrong, [], `every evening must have exactly one scheduled export\n${lines.join("\n")}`);
  assert.deepEqual(Object.keys(scheduled).sort(), evenings, `exports dated outside the evenings\n${lines.join("\n")}`);
  for (const r of results.filter((x) => !x.manual && x.exported)) {
    const t = Date.parse(r.iso);
    assert.ok(t >= parisMs(r.exported, "21:00") && t < parisMs(r.exported, "21:00") + 9 * 3600000, `${r.iso} exported ${r.exported} outside its evening`);
  }
  // in the bucket, each evening's file was written at or after 21:00 Paris that day
  const b = bucket();
  for (const d of evenings) assert.ok(Date.parse(b[`inventory-exports/inventory_books_${d}.csv`]) >= parisMs(d, "21:00"), d);
  // and the daily freshness check (09:00 UTC) is happy every morning
  for (const d of evenings) {
    const next = new Date(Date.parse(`${d}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
    assert.equal(freshness(sb, "inventory", `${next} 10`).missing, "false", `morning after ${d}`);
  }
  table.push(`replay of ${REAL_RUNS.length} real runs + tonight's 4 schedules: ${evenings.length} evenings, ${results.filter((r) => r.exported && !r.manual).length} scheduled exports, ${results.filter((r) => !r.exported).length} skips\n${lines.join("\n")}`);
});

// ---------- accounting ----------

function accountingRuns(runs, preset = {}) {
  const sb = sim.makeSandbox();
  sim.writeState(path.join(sb.dir, "bucket"), preset);
  const results = runs.map(([iso, inputs]) => {
    const r = sim.runWorkflow(sb, "accounting-export-monthly.yml", iso, inputs || {});
    return { iso, ran: (r.steps.gate || {}).run === "true", label: (r.steps.export || {}).label, stored: r.uploaded };
  });
  return { sb, results, bucket: () => sim.readState(path.join(sb.dir, "bucket")) };
}
const TEST_RUN = { month: "2026-10", ignore_time_check: "true", allow_current_month: "true" };
const OCT = "accounting-exports/2026/accounting_2026-10.csv";

test("accounting: a current-month test run, then the scheduled runs on the 1st: the real export still runs, once", () => {
  const { results, sb, bucket } = accountingRuns([
    ["2026-10-27T10:00:00Z", TEST_RUN], // test of the unfinished month: emailed, NOT stored
    ["2026-11-01T05:00:00Z"], // 06:00 CET on the 1st
    ["2026-11-01T06:00:00Z"], // 07:00 CET (the retry line)
    ["2026-11-02T05:30:00Z"],
  ]);
  table.push(`accounting: current-month test run, then the 1st\n${results.map((r) => `    ${r.iso} -> ${r.ran ? `export ${r.label}, stored ${r.stored.length} file(s)` : "skip"}`).join("\n")}`);
  assert.equal(results[1].ran, true, "the 1st MUST export October");
  assert.deepEqual(results[0].stored, [], "the test run stores nothing");
  assert.deepEqual(results[1].stored, [OCT, "accounting-exports/2026/till_days_2026-10.csv", "accounting-exports/2026/summary_2026-10.txt"]);
  assert.equal(results[2].ran, false);
  assert.equal(results[3].ran, false);
  const written = Date.parse(bucket()[OCT]);
  assert.ok(written > Date.parse("2026-11-01T05:00:00Z") && written < Date.parse("2026-11-01T06:00:00Z"), "written by the 1st's run");
  assert.equal(freshness(sb, "accounting", "2026-11-03 10").missing, "false");
});

test("accounting: a canonical file left by an OLD test run (before this fix) does not cancel the 1st", () => {
  const { results, sb } = accountingRuns([["2026-11-01T05:00:00Z"], ["2026-11-01T06:00:00Z"]], { [OCT]: "2026-10-27T10:05:00+00:00" });
  assert.deepEqual(results.map((r) => r.ran), [true, false]);
  assert.equal(freshness(sb, "accounting", "2026-11-03 10").missing, "false");
  const stale = accountingRuns([], { [OCT]: "2026-10-27T10:05:00+00:00" });
  assert.equal(freshness(stale.sb, "accounting", "2026-11-03 10").missing, "true", "only the old test file: alert");
});

test("accounting: a manual run of a FINISHED month mid-month is stored as usual", () => {
  const { results } = accountingRuns([["2026-10-15T10:00:00Z", { month: "2026-09", ignore_time_check: "true", allow_current_month: "false" }]]);
  assert.deepEqual(results[0].stored, ["accounting-exports/2026/accounting_2026-09.csv", "accounting-exports/2026/till_days_2026-09.csv", "accounting-exports/2026/summary_2026-09.txt"]);
});

test.after(() => { if (process.env.EXPORT_SCENARIOS) console.log(table.join("\n")); });
