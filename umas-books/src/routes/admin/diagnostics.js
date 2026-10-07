const express = require("express");
const { requireAdmin } = require("../../middleware/auth");
const { resolveTrustProxyHops } = require("../../lib/trustProxy");
const { pool } = require("../../db");
const { listJobRuns } = require("../../lib/jobRuns");

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
  });
});

module.exports = router;
