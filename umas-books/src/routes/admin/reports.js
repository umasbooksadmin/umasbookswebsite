const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { REPORTS, GROUPS, getReport, runReport, toCsv, formatCell } = require("../../lib/reports");

const router = express.Router();

// Read-only reports for the admins (see lib/reports.js). No email addresses or
// buyer names appear on any page or CSV; every CSV download is written to the
// admin activity log (slug only).

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

  const result = await runReport(pool, report, req.query);

  if (wantsCsv) {
    // ?table=<section key> picks which table of the report to download.
    const section = result.sections.find((s) => s.key === req.query.table) || result.sections[0];
    await audit(req, { action: "report.csv", targetType: "report", detail: slug });
    const range = report.usesRange ? `-${result.range.from}_${result.range.to}` : "";
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="umas-books-${slug}-${section.key}${range}.csv"`,
      "Cache-Control": "no-store",
    });
    return res.send(toCsv(section));
  }

  res.render("admin/reports/show", {
    active: "reports", report, result, groups: GROUPS, formatCell,
    query: { from: result.range.from, to: result.range.to, group: result.group },
  });
});

module.exports = router;
