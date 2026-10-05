// A node:test reporter that prints the end-of-run summary: per persona how
// many tests passed, failed, were skipped as manual-only, were skipped for
// another reason (missing credentials, writes not allowed), or are known
// issues (todo). It also lists steps of the manual script that no test
// covers and the test records the run left on the site.

const fs = require("node:fs");
const path = require("node:path");
const { stepIdOf, manualStepIds } = require("./steps");

const PERSONA_ORDER = ["guest", "account", "member", "volunteer", "admin", "edge"];
// node:test reports the file that CALLED test() (the harness), not the spec
// file, so the persona comes from the test name's prefix: G guest, AC account
// holder, M member, VO volunteer, A admin, E and X edge and cross-cutting.
const personaOf = (name) => {
  const n = String(name);
  if (/^VO[\d-]/.test(n)) return "volunteer";
  if (/^AC[\d-]/.test(n)) return "account";
  return { G: "guest", M: "member", A: "admin", E: "edge", X: "edge" }[n[0]] || "other";
};
const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

module.exports = async function* summary(source) {
  const rows = {};
  const failures = [];
  const todos = [];
  const seenIds = new Set();
  const autoIds = new Set(); // step ids with at least one automated (not manual-only) test
  const row = (p) => (rows[p] || (rows[p] = { pass: 0, fail: 0, manual: 0, other: 0, todo: 0 }));
  const otherSkips = {};

  for await (const ev of source) {
    if (ev.type !== "test:pass" && ev.type !== "test:fail") continue;
    const d = ev.data;
    if (d.nesting !== 0) continue;
    const persona = personaOf(d.name);
    const isFileLevel = /\.e2e\.js$/.test(String(d.name));
    if (isFileLevel && ev.type === "test:pass") continue;
    const r = row(persona);
    const id = stepIdOf(d.name);
    if (id) seenIds.add(id);
    const skip = typeof d.skip === "string" ? d.skip : d.skip ? "skipped" : null;
    if (id && !(skip && /^manual:/i.test(skip))) autoIds.add(id);
    if (d.todo) {
      r.todo++;
      todos.push({ name: d.name, note: typeof d.todo === "string" ? d.todo : "", passed: ev.type === "test:pass" });
    } else if (skip && /^manual:/i.test(skip)) r.manual++;
    else if (skip) { r.other++; otherSkips[skip] = (otherSkips[skip] || 0) + 1; }
    else if (ev.type === "test:fail") {
      r.fail++;
      const err = d.details && d.details.error;
      const cause = err && (err.cause || err);
      failures.push({ name: d.name, persona, message: String((cause && cause.message) || err || "failed").split("\n")[0] });
    } else r.pass++;
  }

  const personas = PERSONA_ORDER.filter((p) => rows[p]).concat(Object.keys(rows).filter((p) => !PERSONA_ORDER.includes(p)));
  const total = { pass: 0, fail: 0, manual: 0, other: 0, todo: 0 };
  let out = "\n==================== End-to-end summary ====================\n";
  out += `${pad("Persona", 12)}${num("Pass", 6)}${num("Fail", 6)}${num("Not run", 9)}${num("Known", 7)}${num("Manual", 8)}${num("Total", 7)}\n`;
  for (const p of personas) {
    const r = rows[p];
    for (const k of Object.keys(total)) total[k] += r[k];
    out += `${pad(p, 12)}${num(r.pass, 6)}${num(r.fail, 6)}${num(r.other, 9)}${num(r.todo, 7)}${num(r.manual, 8)}${num(r.pass + r.fail + r.other + r.todo + r.manual, 7)}\n`;
  }
  const all = total.pass + total.fail + total.other + total.todo + total.manual;
  out += `${pad("ALL", 12)}${num(total.pass, 6)}${num(total.fail, 6)}${num(total.other, 9)}${num(total.todo, 7)}${num(total.manual, 8)}${num(all, 7)}\n`;
  out += "(Not run = skipped for missing credentials or because E2E_ALLOW_WRITES is not set. Known = known issue, shown but not failing.)\n";
  out += `\nCoverage: automated ${all - total.manual} / manual ${total.manual} / total ${all} tests.\n`;
  const ran = total.pass + total.fail + total.todo;
  out += `Of the automated tests, ${ran} ran and ${total.other} were not run.\n`;

  if (Object.keys(otherSkips).length) {
    out += "\nNot run, and why:\n";
    for (const [why, n] of Object.entries(otherSkips)) out += `  ${num(n, 3)}  ${why}\n`;
  }
  if (failures.length) {
    out += `\nFAILED (${failures.length}):\n`;
    for (const f of failures) out += `  [${f.persona}] ${f.name}\n      ${f.message}\n`;
  }
  if (todos.length) {
    out += `\nKnown issues (not counted as failures):\n`;
    for (const t of todos) out += `  ${t.passed ? "NOW PASSES, remove the todo: " : ""}${t.name}${t.note ? `\n      ${t.note}` : ""}\n`;
  }

  // How the steps of the manual script are covered (full runs only).
  const stepIds = manualStepIds();
  if (stepIds.length && Object.keys(rows).length === PERSONA_ORDER.length) {
    const automated = stepIds.filter((id) => autoIds.has(id));
    const manualOnly = stepIds.filter((id) => seenIds.has(id) && !autoIds.has(id));
    const missing = stepIds.filter((id) => !seenIds.has(id));
    out += `\nSteps of docs/testing/manual-test-scripts.md: ${stepIds.length} in all, ${automated.length} with an automated test, ${manualOnly.length} manual-only (${manualOnly.join(", ")})${missing.length ? `, NO TEST AT ALL: ${missing.join(", ")}` : ""}.\n`;
  }

  const runId = process.env.E2E_RUN_ID;
  if (runId) {
    const file = path.join(__dirname, "..", "artifacts", `created-${runId}.jsonl`);
    if (fs.existsSync(file)) {
      const lines = fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
      out += `\nRecords this run created on the site (tag ${runId}), see e2e/README.md "Cleaning up":\n`;
      for (const c of lines) out += `  - ${c.kind}: ${c.label}${c.where ? `  (${c.where})` : ""}\n`;
    }
  }
  out += failures.length ? "\nRESULT: FAILED\n" : "\nRESULT: no failures\n";
  yield out;
};
