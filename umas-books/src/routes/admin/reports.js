const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { REPORTS, GROUPS, getReport, runReport, toCsv, formatCell, validDay } = require("../../lib/reports");
const { parseTypeFilter, FILTER_LABELS } = require("../../lib/accountTypes");

const router = express.Router();

// Read-only reports for the admins (see lib/reports.js). No email addresses or
// buyer names appear on any page or CSV, except the Accounts report (the list
// of accounts, which needs them); every CSV download is written to the
// admin activity log (slug only).

async function auditAccountsView(req) {
  const adminId = req.session.user.id;
  const { rows } = await pool.query(
    "SELECT 1 FROM admin_audit_log WHERE actor_user_id = $1 AND action = 'reports.accounts.view' AND at > now() - interval '1 hour' LIMIT 1",
    [adminId]
  );
  if (!rows.length) await audit(req, { action: "reports.accounts.view", targetType: "report", detail: "accounts" });
}

router.get("/admin/reports", requireAdmin, (req, res) => {
  res.render("admin/reports/index", { active: "reports", reports: REPORTS });
});

router.get("/admin/reports/:slug", requireAdmin, async (req, res) => {
  let slug = String(req.params.slug || "");
  let wantsCsv = req.query.format === "csv";
  if (slug.endsWith(".csv")) {
    slug = slug.slice(0, -4);
    wantsCsv = true;
  }
  const report = getReport(slug);
  if (!report) return res.status(404).render("404");

  const result = await runReport(pool, report, req.query, new Date(), { csv: wantsCsv });

  if (wantsCsv) {
    // ?table=<section key> picks which table of the report to download.
    const section = result.sections.find((s) => s.key === (req.query.table || report.csvTable)) || result.sections[0];
    await audit(req, { action: "report.csv", targetType: "report", detail: slug });
    const range = report.usesRange ? `-${result.range.from}_${result.range.to}` : "";
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="umas-books-${slug}-${section.key}${range}.csv"`,
      "Cache-Control": "no-store",
    });
    return res.send(toCsv(section));
  }

  // The Accounts report lists every account's email address: viewing the page
  // is logged like the CSV download, once an hour per admin (a refresh or a
  // filter change is not a new entry).
  if (slug === "accounts") await auditAccountsView(req);

  res.render("admin/reports/show", {
    active: "reports", report, result, groups: GROUPS, formatCell,
    query: { from: result.range.from, to: result.range.to, group: result.group },
    accountFilters: report.filters === "accounts" ? {
      type: parseTypeFilter(req.query.type), q: String(req.query.q || "").slice(0, 100),
      from: validDay(req.query.from) || "", to: validDay(req.query.to) || "",
    } : null,
    typeLabels: FILTER_LABELS,
  });
});

module.exports = router;
