const express = require("express");
const { requireAdmin } = require("../../middleware/auth");
const { resolveTrustProxyHops } = require("../../lib/trustProxy");

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

module.exports = router;
