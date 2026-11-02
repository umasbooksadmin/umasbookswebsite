"use strict";

// END-TO-END replays of the nightly database backup's schedule (22:00 Europe/Paris): each run executes
// nightly-db-backup.yml's own steps (the gate .github/scripts/export-gate.sh backup, the dump step with its
// monthly and yearly copies, the yearly accounting export, the "tell the site" step) at a simulated time,
// against one fake Backblaze bucket that remembers each file's LastModified (test/helpers/workflowSim.js).
// pg_dump and age are small fakes that write the real headers; apt-get / download installs are skipped.
// The assertions are about what ends up in the bucket and for which Paris day:
//   - every Paris day gets exactly ONE backup, made at or after 22:00 Paris, in winter and in summer, on the
//     DST change days, when GitHub starts the runs late (after midnight), and around manual runs;
//   - a run before 22:00 Paris never makes the day's backup; a run after midnight still owes yesterday's;
//   - the monthly copy is the first backup of a Paris month, the yearly copy is the backup of 2 January;
//   - the freshness check (09:00 UTC) agrees every morning, and reports a dropped night.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const sim = require("../helpers/workflowSim");

const WF = "nightly-db-backup.yml";
const MANUAL = { force_monthly: "false", force_yearly: "false" };
const RECIPIENT = `age1${"q".repeat(58)}`; // well-formed public key for the fake age
const VARS = { BACKUP_S3_PREFIX: "", BACKUP_AGE_RECIPIENT: RECIPIENT, FISCAL_YEAR_START_MONTH: "" };
const SKIP = /^(Install matching PostgreSQL client tools|Install age \(pinned release)/;
const CRONS = ["0 20 * * *", "0 21 * * *", "0 22 * * *", "0 23 * * *", "0 1 * * *"];
const FULL = "store-backups/full/umas_books_full_";

const parisMs = (day, hhmm) => { // the UTC instant of a Paris wall-clock time
  for (const off of [1, 2]) {
    const ms = Date.parse(`${day}T${hhmm}:00Z`) - off * 3600000;
    if (sim.parisHour(new Date(ms).toISOString()) === `${day} ${hhmm.slice(0, 2)}`) return ms;
  }
  throw new Error(`no Paris time ${day} ${hhmm}`);
};
const iso = (ms) => new Date(ms).toISOString();
const plusDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

function backupRuns(runs, { preset = {}, vars = {} } = {}) {
  const sb = sim.makeSandbox();
  sim.writeState(path.join(sb.dir, "bucket"), preset);
  const results = runs.map(([at, inputs]) => {
    const r = sim.runWorkflow(sb, WF, at, inputs || {}, { vars: { ...VARS, ...vars }, skip: SKIP });
    const full = r.uploaded.filter((k) => k.startsWith(FULL));
    assert.ok(full.length <= 1, `${at}: at most one dump per run`);
    assert.equal(r.dumps, full.length, `${at}: a dump is made only when one is uploaded`);
    const gate = r.steps.gate || {};
    return {
      at, paris: sim.parisHour(at), manual: !!inputs, ran: gate.run === "true", day: full.length ? gate.day : null,
      key: full[0] || null, monthly: r.uploaded.filter((k) => k.includes("/monthly/")),
      yearly: r.uploaded.filter((k) => k.includes("/yearly/")), accounting: r.uploaded.filter((k) => k.startsWith("accounting-exports/")),
      probes: r.probes, nag: (r.steps.enc || {}).nag === "true", log: r.log,
    };
  });
  return { sb, results, bucket: () => sim.readState(path.join(sb.dir, "bucket")) };
}

function freshness(sb, gateNow) {
  const out = path.join(sb.dir, `fresh-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(out, "");
  const r = spawnSync("bash", [path.join(sim.root, ".github", "scripts", "export-freshness.sh"), "backup"], {
    env: { PATH: process.env.PATH, AWS_BIN: sb.aws, S3_STATE: path.join(sb.dir, "bucket"), GITHUB_OUTPUT: out, BUCKET: "b", ENDPOINT: "e", PREFIX: "", GATE_NOW: gateNow }, encoding: "utf8",
  });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  return Object.fromEntries(fs.readFileSync(out, "utf8").split("\n").filter(Boolean).map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

const table = [];
function scenario(name, runs, want, opts) {
  const res = backupRuns(runs, opts);
  const lines = res.results.map((r) => `    ${r.at} (Paris ${r.paris}h${r.manual ? ", manual" : ""}) -> ${r.day ? `backup for ${r.day} (${r.key.slice(FULL.length)})` : "skip"}`);
  table.push(`${name}\n${lines.join("\n")}`);
  assert.deepEqual(res.results.map((r) => r.day), want, `${name}\n${lines.join("\n")}`);
  return res;
}

test("the schedule: 20:00 and 21:00 UTC (22:00 Paris in summer / winter), retries at 22:00, 23:00 and 01:00 UTC", () => {
  const wf = fs.readFileSync(path.join(sim.root, ".github", "workflows", WF), "utf8");
  assert.deepEqual([...wf.matchAll(/^\s+- cron: "([^"]+)"/gm)].map((m) => m[1]), CRONS);
  // every line, in both seasons, lands in the gate's window [22:00, 06:00) Paris or before 22:00 (a clean skip)
  const parisHours = (day) => CRONS.map((c) => sim.parisHour(`${c.split(" ")[1] === "1" ? plusDays(day, 1) : day}T${c.split(" ")[1].padStart(2, "0")}:00:00Z`).slice(-2));
  assert.deepEqual(parisHours("2026-12-15"), ["21", "22", "23", "00", "02"], "winter: 22:00 is the second line");
  assert.deepEqual(parisHours("2027-07-15"), ["22", "23", "00", "01", "03"], "summer: 22:00 is the first line");
});

test("winter (CET): 22:00 Paris = the 21:00 UTC line backs up; 21:00 Paris and the retries skip", () => {
  const { results, sb } = scenario("winter night, all five lines on time", [
    ["2026-11-10T20:00:00Z"], // 21:00 Paris: too early
    ["2026-11-10T21:00:00Z"], // 22:00 Paris: the backup for the 10th
    ["2026-11-10T22:00:00Z"], ["2026-11-10T23:00:00Z"], // retries: done already
    ["2026-11-11T01:00:00Z"], // 02:00 Paris on the 11th: still the 10th's night, done
  ], [null, "2026-11-10", null, null, null]);
  assert.match(results[1].key, /^store-backups\/full\/umas_books_full_2026-11-10T21-\d\d-\d\dZ\.dump\.age$/, "name = UTC time of the dump (unchanged format)");
  assert.match(results[0].log, /before 22h/);
  assert.match(results[2].log, /already in Backblaze/);
  assert.equal(freshness(sb, "2026-11-11 10").missing, "false");
});

test("summer (CEST): 22:00 Paris = the 20:00 UTC line backs up; the 21:00 UTC line (23:00 Paris) skips", () => {
  const { sb } = scenario("summer night, all five lines on time", [
    ["2027-06-15T20:00:00Z"], ["2027-06-15T21:00:00Z"], ["2027-06-15T22:00:00Z"], ["2027-06-15T23:00:00Z"], ["2027-06-16T01:00:00Z"],
  ], ["2027-06-15", null, null, null, null]);
  assert.equal(freshness(sb, "2027-06-16 11").missing, "false");
});

test("a run at 21:59 Paris does not make the day's backup; the 22:00 run then does", () => {
  scenario("21:59 then 22:00 (winter)", [["2026-11-10T20:59:00Z"], ["2026-11-10T21:00:00Z"]], [null, "2026-11-10"]);
  scenario("21:59 then 22:00 (summer)", [["2027-06-15T19:59:00Z"], ["2027-06-15T20:00:00Z"]], [null, "2027-06-15"]);
  // and a backup written before 22:00 Paris (a manual run at 21:45, uploaded a few minutes later) does not count for that night
  scenario("manual at 21:45, then the 22:00 run still backs up", [["2026-11-10T20:45:00Z", MANUAL], ["2026-11-10T21:00:00Z"], ["2026-11-10T22:00:00Z"]],
    ["2026-11-10", "2026-11-10", null]);
});

test("a run GitHub delayed to 01:30 Paris still makes YESTERDAY's backup (once); the next evening makes its own", () => {
  const { results, sb } = scenario("only delayed runs after midnight, then the next evening", [
    ["2026-11-11T00:30:00Z"], // 01:30 Paris on the 11th: owes the 10th
    ["2026-11-11T01:30:00Z"], // 02:30: the 10th is done
    ["2026-11-11T05:00:00Z"], // 06:00 Paris: nothing owed any more
    ["2026-11-11T21:00:00Z"], // 22:00 on the 11th
  ], ["2026-11-10", null, null, "2026-11-11"]);
  assert.match(results[2].log, /It is 6h in Paris, before 22h/);
  assert.equal(freshness(sb, "2026-11-11 10").missing, "false", "the 10th's backup was made at 01:30 on the 11th");
  assert.equal(freshness(sb, "2026-11-12 10").missing, "false");
  scenario("summer: 01:30 CEST", [["2027-06-15T23:30:00Z"], ["2027-06-16T20:00:00Z"]], ["2027-06-15", "2027-06-16"]);
});

test("a manual run always backs up (any hour, file present or not); a daytime one does not cancel the night's backup", () => {
  const { results } = scenario("manual runs around a night", [
    ["2026-11-10T10:00:00Z", MANUAL], // 11:00 Paris
    ["2026-11-10T10:30:00Z", MANUAL], // again: still runs
    ["2026-11-10T21:00:00Z"], // 22:00: the night's backup is still made
    ["2026-11-10T21:30:00Z", MANUAL], // 22:30 manual: runs as well
    ["2026-11-10T22:00:00Z"], // retry: done
  ], ["2026-11-10", "2026-11-10", "2026-11-10", "2026-11-10", null]);
  assert.deepEqual(results.map((r) => r.probes), [[], [], ["X-Umas-Probe: backup"], [], []], "only the scheduled night's backup reports to the site");
  assert.ok(results[0].nag === false, "encrypted: no reminder");
  // a manual run from 22:00 on is a complete backup after 22:00: it counts for that night
  scenario("manual at 22:30, then the retries", [["2026-11-10T21:30:00Z", MANUAL], ["2026-11-10T22:00:00Z"], ["2026-11-11T01:00:00Z"]],
    ["2026-11-10", null, null]);
  // a manual run after midnight is labelled with today's date and does not count for the night before
  scenario("manual at 00:30, then a delayed scheduled run", [["2026-11-10T23:30:00Z", MANUAL], ["2026-11-11T00:15:00Z"]], ["2026-11-11", null]);
});

test("autumn DST (Sat 24 -> Sun 25 Oct 2026): one backup each evening, on both sides of the change", () => {
  const { sb } = scenario("DST autumn", [
    ["2026-10-24T20:00:00Z"], // 22:00 CEST on the 24th
    ["2026-10-24T21:00:00Z"], ["2026-10-24T22:00:00Z"], ["2026-10-24T23:00:00Z"],
    ["2026-10-25T00:30:00Z"], // 02:30 CEST on the 25th
    ["2026-10-25T01:30:00Z"], // 02:30 CET (the same wall-clock hour again)
    ["2026-10-25T20:00:00Z"], // 21:00 CET: too early on the first winter evening
    ["2026-10-25T21:00:00Z"], // 22:00 CET
    ["2026-10-25T22:00:00Z"], ["2026-10-25T23:00:00Z"], ["2026-10-26T01:00:00Z"],
  ], ["2026-10-24", null, null, null, null, null, null, "2026-10-25", null, null, null]);
  assert.equal(freshness(sb, "2026-10-25 10").missing, "false");
  assert.equal(freshness(sb, "2026-10-26 10").missing, "false");
  scenario("DST autumn, only delayed runs after the change", [["2026-10-25T01:30:00Z"], ["2026-10-25T03:30:00Z"]], ["2026-10-24", null]);
});

test("spring DST (Sat 27 -> Sun 28 Mar 2027): one backup each evening, on both sides of the change", () => {
  const { sb } = scenario("DST spring", [
    ["2027-03-27T20:00:00Z"], // 21:00 CET: too early
    ["2027-03-27T21:00:00Z"], // 22:00 CET on the 27th
    ["2027-03-27T22:00:00Z"], ["2027-03-27T23:00:00Z"],
    ["2027-03-28T01:00:00Z"], // 03:00 CEST on the 28th (02:00 CET never happened)
    ["2027-03-28T20:00:00Z"], // 22:00 CEST: the first summer evening
    ["2027-03-28T21:00:00Z"], ["2027-03-28T22:00:00Z"], ["2027-03-28T23:00:00Z"], ["2027-03-29T01:00:00Z"],
  ], [null, "2027-03-27", null, null, null, "2027-03-28", null, null, null, null]);
  assert.equal(freshness(sb, "2027-03-28 11").missing, "false");
  assert.equal(freshness(sb, "2027-03-29 11").missing, "false");
});

test("three weeks across the autumn change with GitHub delays of 0 to 4 hours and dropped lines: exactly one backup per Paris day, each from 22:00 Paris", () => {
  // Deterministic "random" delays and drops, so a failure can be replayed.
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const runs = [];
  const days = [];
  for (let d = "2026-10-14"; d <= "2026-11-03"; d = plusDays(d, 1)) {
    days.push(d);
    for (const c of CRONS) {
      const h = Number(c.split(" ")[1]);
      if (rnd() < 0.25) continue; // GitHub dropped this line
      const base = Date.parse(`${h === 1 ? plusDays(d, 1) : d}T${String(h).padStart(2, "0")}:00:00Z`);
      runs.push([iso(base + Math.floor(rnd() * 4 * 3600) * 1000)]);
    }
  }
  runs.sort((a, b) => Date.parse(a[0]) - Date.parse(b[0]));
  const { results, sb } = backupRuns(runs);
  const per = {};
  for (const r of results.filter((x) => x.day)) (per[r.day] = per[r.day] || []).push(r.at);
  const lines = results.map((r) => `    ${r.at} (Paris ${r.paris}h) -> ${r.day ? `backup for ${r.day}` : "skip"}`);
  table.push(`3 weeks, ${runs.length} runs with delays/drops\n${lines.join("\n")}`);
  const wrong = days.filter((d) => (per[d] || []).length !== 1).map((d) => `${d}: ${(per[d] || []).length}`);
  assert.deepEqual(wrong, [], `exactly one backup per day\n${lines.join("\n")}`);
  for (const [d, [at]] of Object.entries(per)) {
    const t = Date.parse(at);
    assert.ok(t >= parisMs(d, "22:00") && t < parisMs(d, "22:00") + 8 * 3600000, `${d}: made at ${at}, inside 22:00-06:00 Paris`);
  }
  for (const d of days) assert.equal(freshness(sb, `${plusDays(d, 1)} 10`).missing, "false", `freshness the morning after ${d}`);
});

test("freshness: a dropped night is reported the next morning (and a daytime manual backup does not hide it)", () => {
  const { sb } = backupRuns([["2026-11-10T21:00:00Z"], ["2026-11-11T10:00:00Z", MANUAL]]); // the 11th's night: nothing
  const f = freshness(sb, "2026-11-12 10");
  assert.equal(f.missing, "true");
  assert.equal(f.label, "2026-11-11");
  assert.match(f.reason, /nightly backup for 2026-11-11 is missing: the newest file under store-backups\/full\/ was written 2026-11-11 11:0\d Paris time, before 22:00 Paris on 2026-11-11/);
  assert.equal(freshness(sb, "2026-11-11 10").missing, "false", "the 10th was fine");
  assert.equal(freshness(sb, "2026-11-12 04").missing, "false", "before 06:00 the night is not over: it checks the night before");
  const empty = backupRuns([]);
  assert.equal(freshness(empty.sb, "2026-11-12 10").missing, "true");
});

test("monthly copy: the first backup of a Paris month (the evening of the 1st); a delayed run after midnight on the 1st is still last month's", () => {
  const preset = { "store-backups/monthly/umas_books_full_2026-11-01T03-00-12Z.dump.age": "2026-11-01T03:04:00+00:00" }; // the old 03:00 UTC copy
  const { results } = backupRuns([
    ["2026-11-30T21:00:00Z"], // 22:00 on 30 Nov
    ["2026-12-01T00:30:00Z"], // 01:30 Paris on 1 Dec: owes 30 Nov (done): skip
    ["2026-12-01T21:00:00Z"], // 22:00 on 1 Dec: the December copy
    ["2026-12-02T21:00:00Z"], // 2 Dec: none
  ], { preset });
  assert.deepEqual(results.map((r) => r.monthly.length), [0, 0, 1, 0]);
  assert.equal(results[2].monthly[0], results[2].key.replace("/full/", "/monthly/"));
  // 30 Nov's 22:00 run dropped; GitHub starts a retry at 01:30 Paris on 1 Dec (00:30 UTC, already December in UTC too):
  // that is 30 Nov's backup, so it does NOT take December's copy; the evening of 1 Dec does
  const dropped = backupRuns([["2026-12-01T00:30:00Z"], ["2026-12-01T21:00:00Z"]], { preset });
  assert.deepEqual(dropped.results.map((r) => [r.day, r.monthly.length]), [["2026-11-30", 0], ["2026-12-01", 1]]);
  // the 1st's run failed / dropped: the next night writes it
  const late = backupRuns([["2026-12-02T21:00:00Z"], ["2026-12-03T21:00:00Z"]], { preset });
  assert.deepEqual(late.results.map((r) => r.monthly.length), [1, 0]);
  // summer: a copy written at 01:30 CEST on 1 July (23:30 UTC on 30 June) is July's in Paris time... and here belongs to 30 June
  const summer = backupRuns([["2027-06-30T23:30:00Z"], ["2027-07-01T20:00:00Z"], ["2027-07-02T20:00:00Z"]], { preset: { "store-backups/monthly/umas_books_full_2027-06-01T20-01-00Z.dump.age": "2027-06-01T20:02:00+00:00" } });
  assert.deepEqual(summer.results.map((r) => [r.day, r.monthly.length]), [["2027-06-30", 0], ["2027-07-01", 1], ["2027-07-02", 0]]);
});

test("yearly copy and previous-year accounting export: the backup of 2 January (Paris day), once, even when GitHub runs it after midnight", () => {
  const { results } = backupRuns([
    ["2027-01-01T21:00:00Z"], // 22:00 on 1 Jan: no
    ["2027-01-02T03:00:00Z"], // 04:00 Paris on 2 Jan = the OLD backup time: owes 1 Jan (done), skip
    ["2027-01-02T21:00:00Z"], // 22:00 on 2 Jan: the yearly copy
    ["2027-01-02T23:00:00Z"], // retry: done
    ["2027-01-03T21:00:00Z"], // 3 Jan: no
  ]);
  assert.deepEqual(results.map((r) => r.yearly), [[], [], ["store-backups/yearly/umas_books_full_2027-01-02.dump.age"], [], []]);
  assert.deepEqual(results[2].accounting, ["accounting-exports/2026/accounting_2026-full-year.csv", "accounting-exports/2026/till_days_2026-full-year.csv", "accounting-exports/2026/summary_2026-full-year.txt"]);
  assert.deepEqual(results.filter((r) => r !== results[2]).map((r) => r.accounting.length), [0, 0, 0, 0]);
  // the 22:00 run of 2 January was dropped; GitHub starts a retry at 00:30 Paris on the 3rd: still 2 January's copy
  const delayed = backupRuns([["2027-01-02T23:30:00Z"], ["2027-01-03T21:00:00Z"]]);
  assert.deepEqual(delayed.results.map((r) => r.yearly), [["store-backups/yearly/umas_books_full_2027-01-02.dump.age"], []]);
  // once per year: a copy of this year already there (a forced bootstrap) is not written again
  const once = backupRuns([["2027-01-02T21:00:00Z"]], { preset: { "store-backups/yearly/umas_books_full_2027-01-01.dump.age": "2027-01-01T12:00:00+00:00" } });
  assert.deepEqual(once.results[0].yearly, []);
  // force_yearly on a manual run: now, labelled with today's Paris date
  const forced = backupRuns([["2026-11-10T10:00:00Z", { force_monthly: "false", force_yearly: "true" }]]);
  assert.deepEqual(forced.results[0].yearly, ["store-backups/yearly/umas_books_full_2026-11-10.dump.age"]);
});

test("unencrypted: the weekly reminder goes with the backup of a Monday evening (Paris day), not a delayed Sunday one", () => {
  const { results } = backupRuns([
    ["2026-11-15T21:00:00Z"], // Sunday 22:00
    ["2026-11-16T00:30:00Z", null], // skip (done)
    ["2026-11-16T21:00:00Z"], // Monday 22:00
  ], { vars: { BACKUP_AGE_RECIPIENT: "" } });
  assert.deepEqual(results.map((r) => [r.day, r.nag]), [["2026-11-15", false], [null, false], ["2026-11-16", true]]);
  assert.match(results[0].key, /\.dump$/);
  const sundayLate = backupRuns([["2026-11-16T00:30:00Z"]], { vars: { BACKUP_AGE_RECIPIENT: "" } }); // Monday 01:30 Paris, Sunday's backup
  assert.deepEqual(sundayLate.results.map((r) => [r.day, r.nag]), [["2026-11-15", false]]);
});

test.after(() => { if (process.env.BACKUP_SCENARIOS) console.log(table.join("\n")); });
