"use strict";

// Runs the export workflows' OWN shell steps (inventory-export.yml, accounting-export-monthly.yml,
// nightly-db-backup.yml) against a fake Backblaze bucket, at a simulated time, so a test can replay a sequence of runs
// (late scheduled runs, manual runs, DST nights) and look at which files end up in the bucket.
//
// What is real: export-gate.sh, every `run:` step of the workflow file as written (parsed from the
// YAML, with its env and `${{ }}` values), and the export scripts themselves
// (export-inventory-csv.js / export-accounting-month.js, run by `node` with the database replaced
// by an empty one and the clock set to the simulated time: test/helpers/exportSimPreload.js).
// What is fake: the `date [-u] +FORMAT` clock (the step's simulated time), the `aws` command (a bucket kept in a state file, with a LastModified per key, set
// to the simulated time when a file is uploaded), `npm` (no-op), `pg_dump` and `age` (the backup:
// a small file with the real header, see makeSandbox), and the `uses:` steps (checkout,
// setup-node, the mail action), which are skipped. Steps run in a per-run workspace that links to
// the repository's .github and umas-books folders, so files a step writes stay out of the repository.
//
// The fake aws answers ONLY the list-objects-v2 queries it knows (and fails loudly on any other),
// so a change of query in the scripts cannot pass silently against a fake that guesses.

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const root = path.join(__dirname, "..", "..", "..");

const FAKE_AWS = path.join(__dirname, "fake-aws.sh");
const FAKE_DATE = `#!/usr/bin/env bash
t="\${FAKE_CLOCK:-\${SIM_NOW:-}}"
for a in "$@"; do case "$a" in +*|-u) ;; *) exec /bin/date "$@" ;; esac; done
[ -n "$t" ] || exec /bin/date "$@"
e=$(/bin/date -u -d "$t" +%s 2>/dev/null) || e=$(/bin/date -u -j -f "%Y-%m-%dT%H:%M:%S" "\${t:0:19}" +%s)
/bin/date -d "@$e" "$@" 2>/dev/null || /bin/date -r "$e" "$@"
`;

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-sim-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "aws"), `#!/usr/bin/env bash\nexec bash "${FAKE_AWS}" "$@"\n`, { mode: 0o755 });
  // `curl` (the "tell the site this job ran" step) never leaves the machine: it records the header it was given
  // (X-Umas-Probe: <name>) in $PROBE_LOG, which runWorkflow returns as `probes`.
  fs.writeFileSync(path.join(bin, "curl"), `#!/usr/bin/env bash\nwhile [ $# -gt 0 ]; do if [ "$1" = "-H" ]; then echo "$2" >> "$PROBE_LOG"; shift; fi; shift; done\nexit 0\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  // `date [-u] +FORMAT` (no other option) answers the simulated time of the step, like the export scripts'
  // clock: the workflow's "taken" time (or the backup's file name) would otherwise be the real time the test
  // runs. Any other use of date (date -d, date -r, date -j ...) is the real command, untouched.
  fs.writeFileSync(path.join(bin, "date"), FAKE_DATE, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "node"), `#!/usr/bin/env bash\nexec "${process.execPath}" -r "${path.join(__dirname, "exportSimPreload.js")}" "$@"\n`, { mode: 0o755 });
  // The nightly backup: `pg_dump ... --file=F <url>` writes a small custom-format-looking file (PGDMP header)
  // and logs one line per dump to $DUMP_LOG; `age -r R ... -o OUT IN` writes the age header + the input.
  // (The workflow calls /usr/lib/postgresql/18/bin/pg_dump: runWorkflow points that path here.)
  fs.writeFileSync(path.join(bin, "pg_dump"), `#!/usr/bin/env bash\nf=""\nfor a in "$@"; do case "$a" in --file=*) f="\${a#--file=}" ;; esac; done\n[ -n "$f" ] || exit 2\nprintf 'PGDMP sim dump %s\\n' "\${SIM_NOW:-}" > "$f"\n[ -z "\${DUMP_LOG:-}" ] || echo "$f" >> "$DUMP_LOG"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "age"), `#!/usr/bin/env bash\nout=""\nwhile [ $# -gt 1 ]; do case "$1" in -o) out="$2"; shift ;; esac; shift; done\n[ -n "$out" ] || exit 2\n{ printf 'age-encryption.org/v1\\n'; cat "$1"; } > "$out"\n`, { mode: 0o755 });
  return { dir, bin, aws: path.join(bin, "aws") };
}

// ---- the bucket ----
function writeState(file, objects) { // objects: { key: lastModifiedIso }
  fs.writeFileSync(file, Object.entries(objects).map(([k, v]) => `${k}\t${v}\n`).join(""));
}
function readState(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => l.split("\t")));
}

// ---- time ----
function parisHour(iso) { // "2026-10-27T19:03:00Z" -> "2026-10-27 21"
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}`;
}
const awsTime = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, "+00:00"); // what `aws s3api` prints

// ---- the workflow file ----
function parseSteps(file) {
  const lines = fs.readFileSync(path.join(root, ".github", "workflows", file), "utf8").split("\n");
  const steps = [];
  let cur = null;
  let block = null; // "env" | "run" | "with"
  for (const line of lines) {
    if (/^ {6}- /.test(line)) { cur = { env: {}, run: null }; steps.push(cur); block = null; }
    if (!cur) continue;
    const body = line.replace(/^ {6}- /, "        ");
    const key = body.match(/^ {8}([a-z-]+):(?: (.*))?$/);
    if (key) {
      block = null;
      const [, k, v] = key;
      if (k === "env") block = "env";
      else if (k === "with") block = "with";
      else if (k === "run") { if (v === "|") { block = "run"; cur.run = ""; } else cur.run = v; }
      else cur[k] = v;
      continue;
    }
    if (block === "env") { const m = body.match(/^ {10}([A-Z_]+): (.*)$/); if (m) cur.env[m[1]] = m[2]; }
    else if (block === "run" && (/^ {10}/.test(line) || line.trim() === "")) cur.run += line.slice(10) + "\n";
  }
  return steps;
}

function evalExpr(expr, ctx) { // the small subset the executed steps use: paths, 'literals', ||, github.event_name [== 'x']
  let m;
  if ((m = expr.match(/^github\.event_name == '([^']*)'$/))) return String(ctx.github.event_name === m[1]);
  return expr.split("||").map((s) => s.trim()).reduce((acc, part) => {
    if (acc) return acc;
    if ((m = part.match(/^'([^']*)'$/))) return m[1];
    if (part === "github.event_name") return ctx.github.event_name;
    if ((m = part.match(/^steps\.(\w+)\.outputs\.(\w+)$/))) return (ctx.steps[m[1]] || {})[m[2]] || "";
    if ((m = part.match(/^(inputs|secrets|vars)\.(\w+)$/))) return ctx[m[1]][m[2]] || "";
    throw new Error(`workflowSim: unsupported expression ${expr}`);
  }, "");
}
const subst = (text, ctx) => text.replace(/\$\{\{\s*(.*?)\s*\}\}/g, (_, e) => evalExpr(e, ctx));

function stepWanted(step, ctx) {
  if (!step.if) return true;
  if (/failure\(\)/.test(step.if)) return false;
  return step.if.split("&&").every((c) => {
    if (c.trim() === "success()") return true; // the simulation stops at the first failing step, so every step it reaches follows successes
    const m = c.trim().match(/^steps\.(\w+)\.outputs\.(\w+) (==|!=) '([^']*)'$/);
    if (!m) throw new Error(`workflowSim: unsupported if: ${step.if}`);
    const same = ((ctx.steps[m[1]] || {})[m[2]] || "") === m[4];
    return m[3] === "==" ? same : !same;
  });
}

function readOutputs(file) {
  return Object.fromEntries(fs.readFileSync(file, "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

// Runs one workflow run at the simulated time `iso` (UTC). `inputs` = the workflow_dispatch inputs
// (as GitHub passes them: strings), or {} for a scheduled run; `event` defaults to workflow_dispatch
// when inputs are given, else schedule. `vars` overrides repository variables (the others are "fake-<NAME>").
// `skip` = a regexp of step names not to run (e.g. the apt-get / download installs). Returns the step outputs and log.
const PG_DUMP_PATH = "/usr/lib/postgresql/18/bin/pg_dump";
function runWorkflow(sandbox, file, iso, inputs = {}, { failAws = false, event, vars = {}, skip = null } = {}) {
  const startMs = Date.parse(iso);
  const steps = parseSteps(file);
  const runDir = fs.mkdtempSync(path.join(sandbox.dir, "run-"));
  const ws = path.join(runDir, "workspace");
  const tmp = path.join(runDir, "runner-temp");
  fs.mkdirSync(ws); fs.mkdirSync(tmp);
  for (const d of [".github", "umas-books"]) fs.symlinkSync(path.join(root, d), path.join(ws, d));
  const ctx = {
    steps: {}, inputs,
    github: { event_name: event || (Object.keys(inputs).length ? "workflow_dispatch" : "schedule") },
    secrets: new Proxy({}, { get: (_, k) => (k === "DATABASE_URL" ? "postgres://sim/sim" : `fake-${String(k)}`) }),
    vars: new Proxy({}, { get: (_, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? vars[k] : `fake-${String(k)}`) }),
  };
  const dumpLog = path.join(runDir, "dumps");
  const uploaded = [];
  const probeLog = path.join(runDir, "probes");
  let log = "";
  steps.forEach((step, i) => {
    if (step.uses || step.run === null || (skip && skip.test(step.name || "")) || !stepWanted(step, ctx)) return;
    const out = path.join(runDir, `out-${i}`);
    const s3log = path.join(runDir, `s3-${i}`);
    fs.writeFileSync(out, "");
    const env = {
      PATH: `${sandbox.bin}:${process.env.PATH}`, HOME: process.env.HOME || os.homedir(), LANG: "C.UTF-8",
      GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: path.join(runDir, "summary"), GITHUB_WORKSPACE: ws, RUNNER_TEMP: tmp,
      S3_STATE: path.join(sandbox.dir, "bucket"), S3_LOG: s3log, PROBE_LOG: probeLog, DUMP_LOG: dumpLog,
      GATE_NOW: parisHour(iso), SIM_NOW: iso,
      FAKE_CLOCK: awsTime(startMs + 60000 * (i + 1)), // each step a minute later than the one before
      ...(failAws ? { FAIL: "1" } : {}),
    };
    for (const [k, v] of Object.entries(step.env)) env[k] = subst(v, ctx);
    const script = subst(step.run, ctx).split(PG_DUMP_PATH).join("pg_dump");
    const cwd = step["working-directory"] ? path.join(ws, step["working-directory"]) : ws;
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], { cwd, env, encoding: "utf8" });
    log += `--- ${step.name || step.id}\n${r.stdout}${r.stderr}`;
    if (r.status !== 0) throw new Error(`workflowSim: step "${step.name}" failed (${r.status}) at ${iso}:\n${r.stdout}${r.stderr}`);
    if (step.id) ctx.steps[step.id] = readOutputs(out);
    if (fs.existsSync(s3log)) uploaded.push(...fs.readFileSync(s3log, "utf8").split("\n").filter(Boolean));
  });
  const probes = fs.existsSync(probeLog) ? fs.readFileSync(probeLog, "utf8").split("\n").filter(Boolean) : [];
  const dumps = fs.existsSync(dumpLog) ? fs.readFileSync(dumpLog, "utf8").split("\n").filter(Boolean).length : 0;
  return { steps: ctx.steps, uploaded, probes, dumps, log };
}

module.exports = { makeSandbox, writeState, readState, parisHour, awsTime, parseSteps, runWorkflow, root };
