// Entry point (`npm start` / `node src/index.js`): validates the environment, builds the
// app (src/app.js createApp), listens, starts the background jobs (src/jobs.js) and
// handles graceful shutdown. Everything with a side effect lives here; the app and the
// job registry have none at require time, so tests can import them.
require("dotenv").config({ quiet: true });
// Site timezone (Europe/Paris) must be set before any date is created.
require("./lib/tz");
// Fail fast (production only) with one clear message, before db.js is loaded.
const envCheck = require("./lib/env").checkEnv();
// Test system (APP_ENV=staging) only: refuse live HelloAsso keys / the production database.
require("./lib/staging").enforceStagingBoot();
const { pool } = require("./db");
const { alertOnError } = require("./lib/errorAlert");
const { createApp } = require("./app");
const { startJobs } = require("./jobs");
const lookupStats = require("./lib/lookupStats"); // flushed at shutdown
const aiUsageStats = require("./lib/aiUsageStats");

const app = createApp();

// Both of these mean some error escaped every other net (route handlers
// are forwarded to the error handler by Express 5; the background jobs below
// already .catch() their own). Log either way; only exit for the
// synchronous case, where Node's own docs say the process is in an
// unknown state and continuing is unsafe — Render restarts it clean.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection:", err);
  alertOnError("Unhandled rejection", err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception:", err);
  // Give the alert email a few seconds, but exit regardless — an
  // uncaught exception means the process is in an unknown state, and
  // that matters more than a best-effort notification landing.
  Promise.race([
    alertOnError("Uncaught exception (process restarting)", err),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]).finally(() => process.exit(1));
});

const { configureServer } = require("./lib/serverConfig"); // keepAliveTimeout above the proxy's (see the file)
const port = process.env.PORT || 3000;
// Express 5 also passes a listen failure (e.g. EADDRINUSE) to this callback;
// the "error" handler below deals with that, so only announce real success.
const server = configureServer(app.listen(port, (err) => {
  if (!err) console.log(`umas-books listening on port ${port}`);
}));

// Launch-guard alerts from lib/env.js (live site with a wrong setup). force skips the throttle so they are never
// swallowed by an unrelated error alert; the text carries no personal data.
// At most once per 24 h per alert (lib/alertFlags.js), not once per deploy or
// restart; while the problem exists a red banner on every admin page shows it.
require("./lib/env").sendLaunchAlerts(envCheck && envCheck.alerts, alertOnError, pool)
  .catch((err) => console.error("Launch alerts failed:", err.message));

// Without a handler, a failed bind (most commonly EADDRINUSE) surfaces as
// an uncaughtException with a stack trace and, in production, an alert
// email that says nothing useful. Say what happened and exit non-zero.
server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${port} is already in use - is another instance of the app running? Exiting.`);
  } else {
    console.error("HTTP server error:", err);
  }
  process.exit(1);
});

// The background jobs: one registry (src/jobs.js) declares and starts them all, and stops them all at shutdown.
const jobs = startJobs(pool);

// Graceful shutdown. Render sends SIGTERM on every deploy and spin-down;
// without a handler the process dies mid-request (an in-flight HelloAsso
// webhook or checkout would be cut off). Order matters:
//   1. stop the maintenance timers (no new background work),
//   2. server.close() stops accepting connections and waits for in-flight
//      requests to finish (idle keep-alive sockets are closed right away),
//   3. only then pool.end(), so those requests can still reach the DB,
//   4. exit 0. A hard-exit timer (unref'd, so it never keeps the process
//      alive by itself) forces exit 1 if requests do not drain in time.
const SHUTDOWN_TIMEOUT_MS = 10 * 1000;
let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received - shutting down gracefully.`);
  jobs.stopAll();
  setTimeout(() => {
    console.error(`Shutdown did not finish within ${SHUTDOWN_TIMEOUT_MS / 1000}s - forcing exit.`);
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS).unref();
  server.close(() => {
    // the lookup counts still in memory go to the database before the pool closes (never fails the shutdown)
    Promise.all([lookupStats.getStats().stop().catch(() => {}), aiUsageStats.getStats().stop().catch(() => {})]).then(() => pool.end()).then(
      () => {
        console.log("Shutdown complete.");
        process.exit(0);
      },
      (err) => {
        console.error("Error closing database pool:", err);
        process.exit(1);
      }
    );
  });
  // A connection that was mid-request when we started closing becomes idle
  // (keep-alive) the moment its response is sent; without this sweep it
  // would hold the process open until Node's 5s keep-alive timeout.
  server.closeIdleConnections();
  setInterval(() => server.closeIdleConnections(), 250).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
