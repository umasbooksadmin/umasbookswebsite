const express = require("express");
const config = require("../../lib/config");
const { requireAdmin } = require("../../middleware/auth");
const { resolveTrustProxyHops } = require("../../lib/trustProxy");
const { pool } = require("../../db");
const { listJobRuns } = require("../../lib/jobRuns");
const { checkNodeVersion } = require("../../lib/nodeVersion");

const router = express.Router();

// Shows what the app sees for the admin's OWN request, so the maintainer can
// check after a deploy that req.ip is the real public IP and not a Cloudflare
// address (see docs/runbook.md "Check the real client IP"). Read-only, nothing
// is stored. English only (admin area).
router.get("/admin/diagnostics/client-ip", requireAdmin, (req, res) => {
  res.set("Cache-Control", "no-store");
  const header = (name) => {
    const v = req.headers[name];
    return v === undefined ? "(not sent)" : String(v);
  };
  res.render("admin/diagnostics_client_ip", {
    active: "diagnostics",
    reqIp: req.ip,
    reqIps: req.ips,
    socketAddress: req.socket && req.socket.remoteAddress,
    xForwardedFor: header("x-forwarded-for"),
    cfConnectingIp: header("cf-connecting-ip"),
    trueClientIp: header("true-client-ip"),
    trustProxyHops: resolveTrustProxyHops().hops,
    node: checkNodeVersion(),
  });
});

// The background jobs (timers in src/index.js): when each last ran and last
// succeeded, how many times in a row it has failed, and the last (scrubbed)
// error. Read-only. English only (admin area). See docs/runbook.md, "Background jobs".
router.get("/admin/diagnostics/jobs", requireAdmin, async (req, res) => {
  res.set("Cache-Control", "no-store");
  res.render("admin/diagnostics_jobs", {
    active: "diagnostics",
    jobs: await listJobRuns(pool),
    alerts: await pool.query("SELECT key, last_sent_at FROM alert_flags ORDER BY key").then((r) => r.rows).catch(() => []),
  });
});

// The catalogs behind the ISBN lookup of the scan page: which are on, and whether the paid one (ISBNdb, only with
// ISBNDB_API_KEY) is working: this is where "key refused" or "quota used up" shows, not on the scanning screen.
// Read-only, never shows the key. English only (admin area). See docs/runbook.md, "Scan speed".
router.get("/admin/diagnostics/lookup", requireAdmin, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const { isbndbStatus, isbndbDailyUsage, googleStatus } = require("../../lib/bookSources");
  res.render("admin/diagnostics_lookup", {
    active: "diagnostics",
    isbndb: isbndbStatus(),
    isbndbToday: await isbndbDailyUsage(pool),
    google: googleStatus(),
    googleKey: Boolean(config.get("GOOGLE_BOOKS_API_KEY")),
    sources: String(config.get("SCAN_LOOKUP_SOURCES")),
  });
});

// The database size: how full the database is against the plan's limit (DB_PLAN_STORAGE_MB), what takes the room
// (the images table first: covers and photos are stored there), and the growth since the last weekly snapshot.
// Read-only. English only (admin area). See docs/runbook.md, "Database size monitoring".
router.get("/admin/diagnostics/database", requireAdmin, async (req, res) => {
  res.set("Cache-Control", "no-store");
  const dbSize = require("../../lib/dbSize");
  const sizes = await dbSize.readSizes(pool);
  res.render("admin/diagnostics_database", {
    active: "diagnostics",
    sizes,
    assessment: dbSize.assess(sizes.dbBytes),
    fmtBytes: dbSize.fmtBytes,
  });
});

module.exports = router;
