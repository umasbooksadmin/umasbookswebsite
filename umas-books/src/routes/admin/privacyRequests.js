// Admin "Privacy requests" (English only, like the rest of /admin): answer a
// request for access to, or erasure of, everything held under an EMAIL ADDRESS,
// including people with no account. See lib/privacyRequests.js and the runbook
// section "A data request (access or erasure)". Every step is in the audit log
// with a keyed hash of the address, never the address itself. The address is
// only ever sent in a POST body (never in a URL, which would reach logs).
const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const pr = require("../../lib/privacyRequests");

const router = express.Router();

function show(res, extra = {}) {
  res.set("Cache-Control", "no-store");
  res.render("admin/privacy_requests", { active: "privacy", email: "", records: null, error: null, mode: "search", ...extra });
}

router.get("/admin/privacy", requireAdmin, (req, res) => show(res));

// Look an address up: nothing is changed.
router.post("/admin/privacy/search", requireAdmin, async (req, res) => {
  const email = pr.normaliseAddress(req.body.email);
  if (!email) return show(res, { error: "Enter one valid email address." });
  const records = await pr.findRecords(pool, email);
  await audit(req, { action: "privacy.lookup", targetType: "address", detail: `${pr.auditToken(email)} records=${records.total}` });
  show(res, { email, records });
});

router.post("/admin/privacy/export", requireAdmin, async (req, res) => {
  const email = pr.normaliseAddress(req.body.email);
  if (!email) return show(res, { error: "Enter one valid email address." });
  const data = await pr.buildAddressExport(pool, email);
  await audit(req, { action: "privacy.export", targetType: "address", detail: pr.auditToken(email) });
  res.set({
    "Content-Type": "application/json; charset=utf-8",
    "Content-Disposition": 'attachment; filename="umas-books-data-request.json"',
    "Cache-Control": "no-store",
  });
  res.send(JSON.stringify(data, null, 2));
});

// Step 1 of erasure: a confirmation page that asks for the address to be typed again.
router.post("/admin/privacy/erase-confirm", requireAdmin, async (req, res) => {
  const email = pr.normaliseAddress(req.body.email);
  if (!email) return show(res, { error: "Enter one valid email address." });
  const records = await pr.findRecords(pool, email);
  show(res, { email, records, mode: "confirm" });
});

// Step 2: only with the address typed again, exactly.
router.post("/admin/privacy/erase", requireAdmin, async (req, res) => {
  const email = pr.normaliseAddress(req.body.email);
  if (!email) return show(res, { error: "Enter one valid email address." });
  if (pr.normaliseAddress(req.body.confirmEmail) !== email) {
    const records = await pr.findRecords(pool, email);
    return show(res, { email, records, mode: "confirm", error: "The address you typed does not match. Nothing was erased." });
  }
  const result = await pr.eraseEverythingFor(pool, email);
  if (!result.ok) {
    const records = await pr.findRecords(pool, email);
    return show(res, { email, records, error: "This address belongs to an administrator account. Remove the administrator role in Accounts first, then repeat. Nothing was erased." });
  }
  await audit(req, { action: "privacy.erase", targetType: "address", detail: `${pr.auditToken(email)} accounts=${result.accounts} outbox=${result.outbox}` });
  console.log(`Privacy request: address erased by admin ${req.session.user.id}.`);
  show(res, { email: "", done: true });
});

module.exports = router;
