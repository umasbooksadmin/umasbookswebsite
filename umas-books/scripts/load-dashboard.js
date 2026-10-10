#!/usr/bin/env node
// Load test for the database pool (NOT run in CI; run it by hand against a
// LOCAL database):
//
//   DATABASE_URL=postgres://localhost:5432/some_local_db PGSSLMODE=disable \
//     node scripts/load-dashboard.js [--requests 30] [--outbox 40] [--other 20] [--smtp-ms 2000] [--port 5410]
//
// It mounts the real /admin dashboard router (as an admin, no login) and, at
// the same moment, fires
//   - N concurrent GET /admin requests,
//   - one outbox batch (processOutbox) with the SMTP transport stubbed to take
//     --smtp-ms per message (default 2000), over --outbox queued test rows,
//   - --other lightweight "other visitor" request loops (3 small queries each),
// and prints the pool's waiting/total counts (sampled every 50 ms), the error
// rate (non-200 answers, including "timeout exceeded when trying to connect")
// and request latencies. Use DB_POOL_MAX to try other pool sizes.
//
// Safety: refuses any database that is not on localhost. The test mail rows it
// queues are removed again at the end; nothing else is written.

const path = require("node:path");
process.chdir(path.join(__dirname, ".."));

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? Number(process.argv[i + 1]) : fallback;
}
const REQUESTS = arg("requests", 30);
const OUTBOX_ROWS = arg("outbox", 40);
const OTHER = arg("other", 20);
const SMTP_MS = arg("smtp-ms", 2000);
const PORT = arg("port", 5410);

const url = process.env.DATABASE_URL;
if (!url) { console.error("Set DATABASE_URL to a local database."); process.exit(2); }
let host;
try { host = new URL(url).hostname; } catch { host = ""; }
if (!["localhost", "127.0.0.1", "[::1]", "::1", ""].includes(host)) {
  console.error(`Refusing to load-test ${host}: only a local database is allowed.`);
  process.exit(2);
}
process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
process.env.ADMIN_2FA_REQUIRED = "false";

const { pool } = require("../src/db");
const mailer = require("../src/mailer");
mailer.sendMail = async () => { await new Promise((r) => setTimeout(r, SMTP_MS)); };
const outbox = require("../src/lib/outbox");
const { buildApp } = require("../test/helpers/inProcessApp");

const pct = (arr, p) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))] : 0);

async function main() {
  const app = buildApp([require("../src/routes/admin/dashboard")]);
  const server = await new Promise((resolve) => { const s = app.listen(PORT, "127.0.0.1", () => resolve(s)); });
  const base = `http://127.0.0.1:${PORT}`;
  const admin = JSON.stringify({ id: 1, email: "load@example.test", displayName: "Load", isAdmin: true, isMember: false, isVolunteer: false });

  const tag = `load-${Date.now()}`;
  await pool.query(
    `INSERT INTO email_outbox (to_email, subject, body_text, kind)
     SELECT $1 || '-' || g || '@example.test', 'Load test', 'x', 'contact' FROM generate_series(1, $2) g`,
    [tag, OUTBOX_ROWS]
  );

  let maxWaiting = 0;
  let maxTotal = 0;
  let waitingSamples = 0;
  let samples = 0;
  const sampler = setInterval(() => {
    samples++;
    if (pool.waitingCount > 0) waitingSamples++;
    maxWaiting = Math.max(maxWaiting, pool.waitingCount);
    maxTotal = Math.max(maxTotal, pool.totalCount);
  }, 50);

  const errors = [];
  const latencies = [];
  const t0 = Date.now();
  const dashboard = async () => {
    const start = Date.now();
    try {
      const res = await fetch(`${base}/admin`, { headers: { "x-test-user": admin } });
      await res.text();
      latencies.push(Date.now() - start);
      if (res.status !== 200) errors.push(`HTTP ${res.status}`);
    } catch (e) { errors.push(e.message); }
  };
  let otherErrors = 0;
  let otherDone = 0;
  const visitor = async () => {
    try {
      for (let i = 0; i < 3; i++) await pool.query("SELECT count(*) FROM books WHERE id < 1000");
      otherDone++;
    } catch { otherErrors++; }
  };
  const realError = console.error;
  console.error = () => {};
  let outboxResult = null;
  let outboxError = null;
  const worker = outbox.processOutbox(pool).then((r) => { outboxResult = r; }, (e) => { outboxError = e.message; });
  await new Promise((r) => setTimeout(r, 200)); // the batch is now inside "SMTP"
  await Promise.all([
    ...Array.from({ length: REQUESTS }, dashboard),
    ...Array.from({ length: OTHER }, visitor),
  ]);
  const dashboardsDone = Date.now() - t0;
  await worker;
  console.error = realError;
  clearInterval(sampler);

  await pool.query("DELETE FROM email_outbox WHERE to_email LIKE $1", [`${tag}-%`]);
  server.close(); server.closeAllConnections();
  await pool.end();

  const failed = errors.length;
  console.log(JSON.stringify({
    poolMax: pool.options.max,
    dashboardRequests: REQUESTS,
    otherVisitorLoops: OTHER,
    outboxRows: OUTBOX_ROWS,
    smtpMs: SMTP_MS,
    dashboardErrors: failed,
    dashboardErrorRatePct: Math.round((failed / REQUESTS) * 1000) / 10,
    otherVisitorErrors: otherErrors,
    dashboardLatencyMs: { p50: pct(latencies, 0.5), p95: pct(latencies, 0.95), max: Math.max(0, ...latencies) },
    allDashboardsDoneMs: dashboardsDone,
    poolMaxWaiting: maxWaiting,
    poolMaxTotal: maxTotal,
    pctSamplesWithWaiters: Math.round((waitingSamples / Math.max(1, samples)) * 100),
    outbox: outboxError ? { error: outboxError } : outboxResult,
    errorSamples: [...new Set(errors)].slice(0, 3),
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
