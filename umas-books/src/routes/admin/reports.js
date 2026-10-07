const express = require("express");
const { pool } = require("../../db");
const { requireAdmin } = require("../../middleware/auth");
const { audit } = require("../../lib/audit");
const { REPORTS, GROUPS, getReport, runReport, toCsv, formatCell, validDay, wantsFrenchCsv } = require("../../lib/reports");
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

// ---------- the accounting export's account mapping ----------

const accounting = require("../../lib/accounting");

async function renderMapping(req, res, { status = 200, error = null, notice = null } = {}) {
  res.status(status).render("admin/reports/accounting_mapping", {
    active: "reports", title: "Accounting mapping", pageTitle: "Accounting mapping", pageSub: "Which accounts each kind of sale goes to in the accounting export",
    rows: await accounting.loadMapping(pool), defaults: accounting.defaultMapping, error, notice,
  });
}

router.get("/admin/reports/accounting/mapping", requireAdmin, (req, res) => renderMapping(req, res, { notice: req.query.saved === "1" ? "Saved." : null }));

router.post("/admin/reports/accounting/mapping", requireAdmin, async (req, res) => {
  const current = await accounting.loadMapping(pool);
  const changes = [];
  for (let i = 0; i < current.length; i++) {
    const row = current[i];
    const get = (f) => String((req.body[`${f}_${i}`] ?? "")).trim();
    const next = { debit: get("debit"), credit: get("credit"), journal: get("journal") };
    if (!accounting.ACCOUNT_RE.test(next.debit) || !accounting.ACCOUNT_RE.test(next.credit) || !accounting.JOURNAL_RE.test(next.journal)) {
      return renderMapping(req, res, { status: 400, error: `Row "${row.category} / ${row.method}": accounts are letters and digits only (at most 20), the journal at most 10.` });
    }
    if (next.debit !== row.debit || next.credit !== row.credit || next.journal !== row.journal) changes.push({ row, next });
  }
  for (const { row, next } of changes) {
    await pool.query(
      `INSERT INTO accounting_map (category, method, debit_account, credit_account, journal) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (category, method) DO UPDATE SET debit_account = $3, credit_account = $4, journal = $5, updated_at = now()`,
      [row.category, row.method, next.debit, next.credit, next.journal]
    );
    await audit(req, {
      action: "accounting.map_edit", targetType: "accounting_map",
      detail: `${row.category} / ${row.method}: ${row.debit}|${row.credit}|${row.journal} -> ${next.debit}|${next.credit}|${next.journal}`,
    });
  }
  res.redirect("/admin/reports/accounting/mapping?saved=1");
});

router.get("/admin/reports/:slug", requireAdmin, async (req, res) => {
  let slug = String(req.params.slug || "");
  let wantsCsv = req.query.format === "csv" || req.query.format === "csv-fr";
  const french = wantsFrenchCsv(req.query);
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
    await audit(req, { action: "report.csv", targetType: "report", detail: french ? `${slug} (French Excel)` : slug });
    const range = report.usesRange ? `-${result.range.from}_${result.range.to}` : "";
    res.set({
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="umas-books-${slug}-${section.key}${range}${french ? "-fr" : ""}.csv"`,
      "Cache-Control": "no-store",
    });
    return res.send(toCsv(section, { locale: french ? "fr" : "en" }));
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
