#!/usr/bin/env node
// Entry point for `npm run e2e`.
//
//   E2E_BASE_URL=https://umasbooks.org npm run e2e
//   E2E_BASE_URL=... npm run e2e -- --persona guest,account
//   E2E_BASE_URL=... E2E_ONLY=admin npm run e2e
//
// 1. checks the target with the safety guard (helpers/guard.js) and stops if
//    it is refused, 2. runs each persona's scenario file one after the other
//    with node:test, 3. prints the summary table. Exit code is non-zero when
//    any test failed (2 when the guard refused to start).

const path = require("node:path");
const { spawnSync } = require("node:child_process");
const cfg = require("./helpers/config");
const { evaluateTarget } = require("./helpers/guard");

function parseArgs(argv) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--persona" || a === "--only") out.push(argv[++i] || "");
    else if (a.startsWith("--persona=") || a.startsWith("--only=")) out.push(a.slice(a.indexOf("=") + 1));
    else if (a === "--help" || a === "-h") { out.help = true; }
    else if (!a.startsWith("-")) out.push(a);
    else { console.error(`Unknown option ${a}. Use --persona guest,account (choose from ${cfg.PERSONAS.join(", ")}).`); process.exit(2); }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(`Usage: E2E_BASE_URL=<site> npm run e2e [-- --persona ${cfg.PERSONAS.join(",")}]\nSee e2e/README.md.`);
    return 0;
  }
  if (args.length) process.env.E2E_ONLY = args.join(",");
  let personas;
  try {
    personas = cfg.selectedPersonas();
  } catch (err) {
    console.error(err.message);
    return 2;
  }
  const base = cfg.baseUrl();
  if (!base) {
    console.error("E2E_BASE_URL is not set. Example: E2E_BASE_URL=http://localhost:3000 npm run e2e   (see e2e/README.md)");
    return 2;
  }
  const verdict = await evaluateTarget(base);
  if (!verdict.allowed) {
    console.error(`\nE2E SAFETY GUARD: ${verdict.reason}\n`);
    return 2;
  }
  process.env.E2E_RUN_ID = cfg.newRunId();
  const conf = cfg.describeConfig();
  console.log(`Target:      ${base}`);
  console.log(`Allowed by:  rule "${verdict.rule}" (${verdict.reason})`);
  console.log(`Run tag:     ${process.env.E2E_RUN_ID}   (anything the tests create is named with this)`);
  console.log(`Personas:    ${personas.join(", ")}`);
  console.log(`Writes:      ${conf.allowWrites ? "ON (E2E_ALLOW_WRITES=1): tests may create tagged test data and send email" : "off (read-only plus cart add/remove)"}`);
  console.log(`Logins:      account ${conf.account}, member ${conf.member}, volunteer ${conf.volunteer}, admin ${conf.admin}\n`);

  const files = personas.flatMap((p) => cfg.PERSONA_FILES[p].map((f) => path.join(__dirname, "specs", f)));
  const res = spawnSync(process.execPath, [
    "--test", "--test-concurrency=1",
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    `--test-reporter=${path.join(__dirname, "helpers", "summary-reporter.js")}`, "--test-reporter-destination=stdout",
    ...files,
  ], { stdio: "inherit", env: process.env });
  return res.status === null ? 1 : res.status;
}

main().then((code) => process.exit(code), (err) => { console.error(err); process.exit(1); });
