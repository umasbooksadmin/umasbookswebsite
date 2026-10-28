"use strict";

// Runs the export workflows' OWN shell steps (inventory-export.yml, accounting-export-monthly.yml)
// against a fake Backblaze bucket, at a simulated time, so a test can replay a sequence of runs
// (late scheduled runs, manual runs, DST nights) and look at which files end up in the bucket.
//
// What is real: export-gate.sh, every `run:` step of the workflow file as written (parsed from the
// YAML, with its env and `${{ }}` values), and the export scripts themselves
// (export-inventory-csv.js / export-accounting-month.js, run by `node` with the database replaced
// by an empty one and the clock set to the simulated time: test/helpers/exportSimPreload.js).
// What is fake: the `date +FORMAT` clock (the step's simulated time), the `aws` command (a bucket kept in a state file, with a LastModified per key, set
// to the simulated time when a file is uploaded), `npm` (no-op), and the `uses:` steps (checkout,
// setup-node, the mail action), which are skipped.
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
for a in "$@"; do case "$a" in +*) ;; *) exec /bin/date "$@" ;; esac; done
[ -n "$t" ] || exec /bin/date "$@"
e=$(/bin/date -u -d "$t" +%s 2>/dev/null) || e=$(/bin/date -u -j -f "%Y-%m-%dT%H:%M:%S" "\${t:0:19}" +%s)
/bin/date -d "@$e" "$@" 2>/dev/null || /bin/date -r "$e" "$@"
`;

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "export-sim-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "aws"), `#!/usr/bin/env bash\nexec bash "${FAKE_AWS}" "$@"\n`, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "npm"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  // `date +FORMAT` (no other option) answers the simulated time of the step, like the export scripts'
  // clock: the workflow's "taken" time would otherwise be the real day the test runs. Any other use of
  // date (date -d, date -r, date -u ...) is the real command, untouched.
  fs.writeFileSync(path.join(bin, "date"), FAKE_DATE, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, "node"), `#!/usr/bin/env bash\nexec "${process.execPath}" -r "${path.join(__dirname, "exportSimPreload.js")}" "$@"\n`, { mode: 0o755 });
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

function evalExpr(expr, ctx) { // the small subset the executed steps use: paths, 'literals', ||
  return expr.split("||").map((s) => s.trim()).reduce((acc, part) => {
    if (acc) return acc;
    let m;
    if ((m = part.match(/^'([^']*)'$/))) return m[1];
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
    const m = c.trim().match(/^steps\.(\w+)\.outputs\.(\w+) == '([^']*)'$/);
    if (!m) throw new Error(`workflowSim: unsupported if: ${step.if}`);
    return ((ctx.steps[m[1]] || {})[m[2]] || "") === m[3];
  });
}

function readOutputs(file) {
  return Object.fromEntries(fs.readFileSync(file, "utf8").split("\n").filter((l) => l.includes("="))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
}

// Runs one workflow run at the simulated time `iso` (UTC). `inputs` = the workflow_dispatch inputs
// (as GitHub passes them: strings), or {} for a scheduled run. Returns the step outputs and log.
function runWorkflow(sandbox, file, iso, inputs = {}, { failAws = false } = {}) {
  const startMs = Date.parse(iso);
  const steps = parseSteps(file);
  const runDir = fs.mkdtempSync(path.join(sandbox.dir, "run-"));
  const ws = path.join(runDir, "workspace");
  const tmp = path.join(runDir, "runner-temp");
  fs.mkdirSync(ws); fs.mkdirSync(tmp);
  const ctx = {
    steps: {}, inputs,
    secrets: new Proxy({}, { get: (_, k) => (k === "DATABASE_URL" ? "postgres://sim/sim" : `fake-${String(k)}`) }),
    vars: new Proxy({}, { get: (_, k) => `fake-${String(k)}` }),
  };
  const uploaded = [];
  let log = "";
  steps.forEach((step, i) => {
    if (step.uses || step.run === null || !stepWanted(step, ctx)) return;
    const out = path.join(runDir, `out-${i}`);
    const s3log = path.join(runDir, `s3-${i}`);
    fs.writeFileSync(out, "");
    const env = {
      PATH: `${sandbox.bin}:${process.env.PATH}`, HOME: process.env.HOME || os.homedir(), LANG: "C.UTF-8",
      GITHUB_OUTPUT: out, GITHUB_STEP_SUMMARY: path.join(runDir, "summary"), GITHUB_WORKSPACE: ws, RUNNER_TEMP: tmp,
      S3_STATE: path.join(sandbox.dir, "bucket"), S3_LOG: s3log,
      GATE_NOW: parisHour(iso), SIM_NOW: iso,
      FAKE_CLOCK: awsTime(startMs + 60000 * (i + 1)), // each step a minute later than the one before
      ...(failAws ? { FAIL: "1" } : {}),
    };
    for (const [k, v] of Object.entries(step.env)) env[k] = subst(v, ctx);
    const script = subst(step.run, ctx);
    const cwd = step["working-directory"] ? path.join(root, step["working-directory"]) : root;
    const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], { cwd, env, encoding: "utf8" });
    log += `--- ${step.name || step.id}\n${r.stdout}${r.stderr}`;
    if (r.status !== 0) throw new Error(`workflowSim: step "${step.name}" failed (${r.status}) at ${iso}:\n${r.stdout}${r.stderr}`);
    if (step.id) ctx.steps[step.id] = readOutputs(out);
    if (fs.existsSync(s3log)) uploaded.push(...fs.readFileSync(s3log, "utf8").split("\n").filter(Boolean));
  });
  return { steps: ctx.steps, uploaded, log };
}

module.exports = { makeSandbox, writeState, readState, parisHour, awsTime, parseSteps, runWorkflow, root };
