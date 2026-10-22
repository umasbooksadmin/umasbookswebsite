#!/usr/bin/env node
// Developer tool: proves two builds of src/index.js start, behave and shut down the same.
// Written for the job-registry / createApp() refactor (the old index.js wired everything
// by hand), reusable for any later change to the entry point.
//
//   node scripts/verify-startup-equivalence.js [--old-ref origin/main] [--old-dir DIR] [--new-dir DIR]
//
//   --old-ref  git ref whose umas-books/ is the baseline (default origin/main): extracted
//              with `git archive` into a temp dir, node_modules symlinked in
//   --old-dir  OR an already prepared umas-books directory as the baseline
//   --new-dir  the build under test (default: this checkout's umas-books/)
//
// For each scenario (test env, defaults, fake production env, staging, boot failures...) it
// boots BOTH builds against a throwaway database (cloned from a migrated template, dropped
// afterwards) on a free port, with a preload that records:
//   - the ordered middleware / route stack of the Express app (layer kind, method, path or
//     regexp, handler name and a whitespace-insensitive hash of its source, nested routers),
//     plus app settings and app.locals keys;
//   - every setInterval / setTimeout (kind, delay, unref'd or not, in creation order),
//     taken after the first seconds and again at shutdown (what is still pending);
//   - the process 'SIGTERM' / 'SIGINT' listeners;
// plus the whole stdout/stderr (startup banners, job lines, the shutdown log) and the exit code.
// Ports, database names, temp paths and timestamps are normalised, then the two are diffed.
// Exit status 0 = every scenario identical, 1 = a difference (printed), 2 = a harness error.
//
// Needs a local Postgres (createdb/dropdb/psql on PATH). It never touches a real database.

const { spawn, execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const NEW_DIR = path.resolve(opt("--new-dir", path.join(__dirname, "..")));
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), "equiv-"));
const RUN_ID = `${process.pid}_${Date.now() % 100000}`;

const PRELOAD = `
const fs = require("fs");
const crypto = require("crypto");
const out = __OUT__;
const timers = [];
// Where a timer was created: "app" (src/**, scripts), or the npm package. Timers of the pg driver / pool
// follow the requests the probe makes, so they are left out of the comparison (they are not app wiring).
const origin = () => {
  const frames = (new Error().stack || "").split(String.fromCharCode(10)).slice(2);
  for (const f of frames) {
    if (f.includes("node:internal") || f.includes("preload.js")) continue;
    const i = f.indexOf("node_modules/");
    if (i === -1) return "app";
    const rest = f.slice(i + 13).split("/");
    return rest[0].startsWith("@") ? rest[0] + "/" + rest[1] : rest[0];
  }
  return "node";
};
const rec = (kind, ms) => { const e = { kind, ms: typeof ms === "number" ? ms : null, unref: false, cleared: false, from: origin() }; if (!/^(pg|pg-pool|node)$/.test(e.from)) timers.push(e); return e; };
for (const kind of ["setInterval", "setTimeout"]) {
  const orig = global[kind];
  global[kind] = function (fn, ms, ...rest) {
    // Randomised library timers (connect-pg-simple prune) have no fixed delay: record the kind only.
    const e = rec(kind, ms);
    const t = orig.call(this, fn, ms, ...rest);
    if (t && t.unref) { const u = t.unref.bind(t); t.unref = () => { e.unref = true; return u(); }; }
    t.__equiv = e;
    return t;
  };
}
for (const [clearName] of [["clearInterval"], ["clearTimeout"]]) {
  const orig = global[clearName];
  global[clearName] = function (t) { if (t && t.__equiv) t.__equiv.cleared = true; return orig.apply(this, arguments); };
}
const hash = (fn) => crypto.createHash("sha1").update(String(fn).replace(/\\s+/g, "")).digest("hex").slice(0, 8);
// Express 5 keeps no mount path on a layer, only a matcher closure: so record WHICH probe paths each layer matches.
const PROBES = new Set(["/", "/admin/inventory", "/admin/inventory/x", "/admin/announcements/1", "/admin/charities/1", "/admin/blog/1", "/admin/collections/1", "/collections/x", "/fr/collections/x", "/img/x", "/assets/x", "/healthz"]);
const gather = (stack) => stack.forEach((l) => { if (l.route && typeof l.route.path === "string") PROBES.add(l.route.path.replace(/:[A-Za-z]+/g, "1")); if (l.handle && l.handle.stack) gather(l.handle.stack); });
function dump(stack, probes) {
  return stack.map((l) => {
    const e = { name: l.name, h: l.handle ? hash(l.handle) : null };
    if (l.route) { e.route = l.route.path; e.methods = Object.keys(l.route.methods).sort(); e.handlers = l.route.stack.map((s) => s.name + ":" + hash(s.handle)); }
    else if (l.handle && l.handle.stack) { e.nested = dump(l.handle.stack, probes); }
    e.matches = probes.map((p) => (l.matchers || []).some((m) => m(p)) ? 1 : 0).join("");
    e.slash = l.slash;
    return e;
  });
}
const express = require(require.resolve("express", { paths: [process.cwd()] }));
const origListen = express.application.listen;
express.application.listen = function (...a) {
  try {
    const router = this.router || this._router;
    gather(router.stack);
    const settings = {};
    for (const k of ["trust proxy", "view engine", "views", "x-powered-by", "etag", "query parser", "env"]) settings[k] = String(this.get(k));
    fs.writeFileSync(out + ".stack.json", JSON.stringify({ settings, locals: Object.keys(this.locals).sort(), probes: [...PROBES].sort(), stack: dump(router.stack, [...PROBES].sort()) }, null, 1));
  } catch (err) { fs.writeFileSync(out + ".stack.json", "STACK DUMP FAILED: " + err.stack); }
  return origListen.apply(this, a);
};
const dumpTimers = (phase) => fs.writeFileSync(out + "." + phase + ".timers.json", JSON.stringify(timers, null, 1));
process.on("message", () => {});
setTimeout(() => dumpTimers("running"), 4000).unref();
process.on("exit", () => {
  dumpTimers("exit");
  fs.writeFileSync(out + ".signals.json", JSON.stringify({ SIGTERM: process.listenerCount("SIGTERM"), SIGINT: process.listenerCount("SIGINT"), uncaughtException: process.listenerCount("uncaughtException"), unhandledRejection: process.listenerCount("unhandledRejection") }));
});
`;

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { stdio: ["ignore", "pipe", "pipe"], ...opts }).toString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); }); });

function prepareOld() {
  if (opt("--old-dir")) return path.resolve(opt("--old-dir"));
  const ref = opt("--old-ref", "origin/main");
  const dir = path.join(SCRATCH, "old");
  fs.mkdirSync(dir);
  const top = sh("git", ["rev-parse", "--show-toplevel"], { cwd: NEW_DIR }).trim();
  const prefix = path.relative(top, NEW_DIR);
  execFileSync(`git -C "${top}" archive ${ref} "${prefix}" | tar -x -C "${dir}"`, { shell: true });
  const appDir = path.join(dir, prefix);
  fs.symlinkSync(path.join(NEW_DIR, "node_modules"), path.join(appDir, "node_modules"));
  // the marketing root (repo root, one level above umas-books) is read for /assets, /logo.png
  return appDir;
}

const SCENARIOS = [
  { name: "test env (COVER_BACKFILL=off, as the integration tests)", env: { NODE_ENV: "test", COVER_BACKFILL: "off", AWARDS_LOOKUPS: "off" }, healthy: true },
  { name: "defaults (cover backfill on, trust proxy default)", env: { NODE_ENV: "test", AWARDS_LOOKUPS: "off" }, healthy: true },
  { name: "bad TRUST_PROXY_HOPS and admin-session warnings", env: { NODE_ENV: "test", COVER_BACKFILL: "off", AWARDS_LOOKUPS: "off", TRUST_PROXY_HOPS: "banana", ADMIN_IDLE_HOURS: "-3" }, healthy: true },
  {
    name: "production (fake env; no Gmail/HelloAsso, so warnings and launch alerts print)",
    env: { NODE_ENV: "production", COVER_BACKFILL: "off", AWARDS_LOOKUPS: "off", TOTP_ENCRYPTION_KEY: "x".repeat(32), APP_BASE_URL: "https://example.org", PGSSLMODE: "disable" },
    healthy: true,
  },
  {
    name: "production with trust proxy 2 + preview mode",
    env: { NODE_ENV: "production", COVER_BACKFILL: "off", AWARDS_LOOKUPS: "off", TOTP_ENCRYPTION_KEY: "x".repeat(32), APP_BASE_URL: "https://example.org", PREVIEW_MODE: "on", TRUST_PROXY_HOPS: "1" },
    healthy: true,
  },
  { name: "staging (valid)", env: { NODE_ENV: "test", APP_ENV: "staging", PRODUCTION_DATABASE_HOST: "dpg-not-this-one", COVER_BACKFILL: "off", AWARDS_LOOKUPS: "off" }, healthy: true },
  { name: "staging refused (no PRODUCTION_DATABASE_HOST)", env: { NODE_ENV: "test", APP_ENV: "staging" }, expectExit: true },
  { name: "production refused (required vars missing)", env: { NODE_ENV: "production" }, expectExit: true, noSecret: true },
  { name: "SESSION_SECRET missing (test env)", env: { NODE_ENV: "test" }, expectExit: true, noSecret: true },
  { name: "DATABASE_URL missing", env: { NODE_ENV: "test" }, expectExit: true, noDb: true },
  { name: "port already in use (EADDRINUSE)", env: { NODE_ENV: "test", COVER_BACKFILL: "off", AWARDS_LOOKUPS: "off" }, expectExit: true, busyPort: true },
];

function normalise(text, ctx) {
  return text
    .split(ctx.dbName).join("<DB>")
    .split(String(ctx.port)).join("<PORT>")
    .split(fs.realpathSync(ctx.dir)).join("<APP>")
    .split(ctx.dir).join("<APP>")
    .replace(/\u001b\[[0-9;]*m/g, "") // eslint-disable-line no-control-regex
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<TS>")
    .replace(/\(node:\d+\)/g, "(node:<PID>)")
    .replace(/\n\s+at .*/g, "") // stack frames carry file:line numbers that legitimately differ
    .replace(/<APP>\/src\/[\w./-]+:\d+(:\d+)?/g, "<APP>/src/<file>:<line>");
}

async function runOne(side, dir, scenario, template) {
  const port = await freePort();
  const dbName = `equiv_${RUN_ID}_${side}_${Math.floor(Math.random() * 1e6)}`;
  sh("createdb", ["-T", template, dbName]);
  const outBase = path.join(SCRATCH, `${side}-${Math.floor(Math.random() * 1e9)}`);
  const preloadFile = `${outBase}.preload.js`;
  fs.writeFileSync(preloadFile, PRELOAD.replace("__OUT__", JSON.stringify(outBase)));
  const env = { ...process.env, PORT: String(port), PGSSLMODE: "disable", SESSION_SECRET: "equiv-session-secret", ...scenario.env };
  // The two runs must not inherit anything from the caller's shell that changes behaviour.
  for (const k of ["PREVIEW_MODE", "APP_ENV", "TRUST_PROXY_HOPS", "COVER_BACKFILL", "NODE_ENV", "GMAIL_USER", "GMAIL_APP_PASSWORD", "HELLOASSO_CLIENT_ID", "HELLOASSO_CLIENT_SECRET", "HELLOASSO_ORG_SLUG", "HELLOASSO_API_BASE", "ADMIN_IDLE_HOURS", "APP_BASE_URL", "RENDER_EXTERNAL_URL", "PRODUCTION_DATABASE_HOST", "TOTP_ENCRYPTION_KEY"]) {
    if (!(k in scenario.env)) delete env[k];
  }
  env.DATABASE_URL = `postgres://localhost:5432/${dbName}`;
  if (scenario.noDb) delete env.DATABASE_URL;
  if (scenario.noSecret) delete env.SESSION_SECRET;
  let blocker = null;
  if (scenario.busyPort) { blocker = net.createServer().listen(port); await new Promise((r) => blocker.once("listening", r)); }

  const lines = [];
  const child = spawn("node", ["-r", preloadFile, "src/index.js"], { cwd: dir, env });
  const cap = (tag) => (d) => d.toString().split("\n").forEach((l) => l.trim() && lines.push(`${tag} ${l}`));
  child.stdout.on("data", cap("out"));
  child.stderr.on("data", cap("err"));
  const exited = new Promise((r) => child.once("exit", (code, sig) => r({ code, sig })));
  let result;
  if (scenario.expectExit) {
    result = await Promise.race([exited, sleep(15000).then(() => "timeout")]);
    if (result === "timeout") { child.kill("SIGKILL"); result = { code: "TIMEOUT" }; }
  } else {
    let healthy = false;
    for (let i = 0; i < 60 && !healthy; i++) {
      try { const r = await fetch(`http://127.0.0.1:${port}/healthz`); healthy = r.status > 0; } catch { await sleep(250); }
    }
    if (!healthy) throw new Error(`${side}: never answered on :${port}\n${lines.join("\n")}`);
    await sleep(4800); // past the 4 s timer snapshot; boot-time job lines have printed by now
    // a couple of requests so request logging (if any) is part of the transcript
    for (const p of ["/", "/healthz", "/api/session", "/nope-404"]) await fetch(`http://127.0.0.1:${port}${p}`).then((r) => r.text()).catch(() => {});
    child.kill("SIGTERM");
    result = await Promise.race([exited, sleep(15000).then(() => "timeout")]);
    if (result === "timeout") { child.kill("SIGKILL"); result = { code: "TIMEOUT" }; }
  }
  if (blocker) blocker.close();
  await sleep(200);
  const ctx = { dbName, port, dir };
  const readJson = (suffix) => { try { return normalise(fs.readFileSync(`${outBase}.${suffix}`, "utf8"), ctx); } catch { return "(none)"; } };
  try { sh("dropdb", ["--if-exists", dbName]); } catch { /* best effort */ }
  // node's source excerpt of an uncaught throw and its stack frames carry file:line numbers: only the message is compared
  const transcript = lines.map((l) => normalise(l, ctx)).filter((l) => !/^err\s+(at |throw |\^$|<APP>)/.test(l));
  // Concurrent boot jobs may print in a different order run to run; keep boot order for the
  // synchronous prefix (everything up to "listening") and compare the rest as a sorted set.
  const idx = transcript.findIndex((l) => l.includes("listening on port"));
  const head = idx === -1 ? transcript : transcript.slice(0, idx + 1);
  const tail = idx === -1 ? [] : transcript.slice(idx + 1);
  return {
    "exit": `code=${result.code} signal=${result.sig || ""}`,
    "log (ordered up to and including listening)": head.join("\n"),
    "log (after listening, sorted)": tail.slice().sort().join("\n"),
    "middleware/route stack + app settings": readJson("stack.json"),
    "timers after 4 s (kind, delay, unref, cleared)": readJson("running.timers.json"),
    "timers at exit (kind, delay, unref, cleared)": ignoreKnownShutdownDifference(readJson("exit.timers.json")),
    "process signal / error listeners": readJson("signals.json"),
  };
}

// KNOWN, INTENTIONAL DIFFERENCE (job-registry refactor): the old shutdown handler cleared the "first run" setTimeout of
// only two jobs (Order follow-up, Cover backfill) and left the other four (Email outbox 15 s, Order phone cleanup 60 s,
// Contact mailbox reminder 90 s, Guest session prune 20 s) pending, so one could fire in the up-to-10 s drain window
// after SIGTERM and query a pool that is about to close. The registry's stopAll() clears every first-run timer. All of
// them are unref'd, so exit timing is unchanged. The "cleared" flag of unref'd timeouts is therefore not compared.
function ignoreKnownShutdownDifference(json) {
  try {
    return JSON.stringify(JSON.parse(json).map((t) => (t.kind === "setTimeout" && t.unref ? { ...t, cleared: "n/a" } : t)), null, 1);
  } catch { return json; }
}

function diffText(a, b) {
  const f1 = path.join(SCRATCH, "a.txt"), f2 = path.join(SCRATCH, "b.txt");
  fs.writeFileSync(f1, a + "\n"); fs.writeFileSync(f2, b + "\n");
  try { execFileSync("diff", ["-u", f1, f2]); return ""; } catch (e) { return e.stdout ? e.stdout.toString() : String(e); }
}

(async () => {
  const oldDir = prepareOld();
  console.log(`baseline: ${oldDir}\nunder test: ${NEW_DIR}\n`);
  const template = `equiv_tpl_${RUN_ID}`;
  sh("createdb", [template]);
  try {
    execFileSync("node", ["src/migrate.js"], { cwd: NEW_DIR, env: { ...process.env, DATABASE_URL: `postgres://localhost:5432/${template}`, PGSSLMODE: "disable" }, stdio: "ignore" });
    let differences = 0;
    for (const sc of SCENARIOS) {
      const a = await runOne("old", oldDir, sc, template);
      const b = await runOne("new", NEW_DIR, sc, template);
      let scenarioDiff = "";
      for (const key of Object.keys(a)) {
        const d = diffText(a[key], b[key]);
        if (d) scenarioDiff += `--- ${key}\n${d}\n`;
      }
      const size = `${a["log (ordered up to and including listening)"].split("\n").length + a["log (after listening, sorted)"].split("\n").length} log lines, ${(a["middleware/route stack + app settings"].match(/"name"/g) || []).length} layers, ${(a["timers after 4 s (kind, delay, unref, cleared)"].match(/"kind"/g) || []).length} timers, ${a.exit}`;
      console.log(`${scenarioDiff ? "DIFF " : "same "} ${sc.name}  [${size}]`);
      if (scenarioDiff) { differences++; console.log(scenarioDiff); }
    }
    console.log(differences ? `\n${differences} scenario(s) differ.` : "\nDIFF OUTPUT EMPTY: old and new are identical in every scenario.");
    process.exitCode = differences ? 1 : 0;
  } finally {
    try { sh("dropdb", ["--if-exists", template]); } catch { /* best effort */ }
    fs.rmSync(SCRATCH, { recursive: true, force: true });
  }
})().catch((err) => { console.error(err); process.exit(2); });
