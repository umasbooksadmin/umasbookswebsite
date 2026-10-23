#!/usr/bin/env node
// Writes the accounting files for ONE month or ONE year into a folder. Read-only (SELECTs in a
// READ ONLY transaction); runs with the backup_ro DATABASE_URL in GitHub Actions
// (.github/workflows/accounting-export-monthly.yml and nightly-db-backup.yml).
//
//   node scripts/export-accounting-month.js --out DIR                      previous Paris month
//   node scripts/export-accounting-month.js --month 2026-10 --out DIR
//   node scripts/export-accounting-month.js --year 2026 --out DIR          the year 2026
//   node scripts/export-accounting-month.js --year last --out DIR          the last complete year
//   --fiscal-start-month M   financial year starts in month M (default: env FISCAL_YEAR_START_MONTH, else 1)
//   --force                  allow the current month or a future month (tests only)
//
// Files (same CSV dialect as the admin export: UTF-8 BOM, semicolon, decimal comma, CRLF):
//   accounting_<label>.csv  till_days_<label>.csv  summary_<label>.txt  email_body.txt
// The log shows counts and totals only, never a data row.
require("dotenv").config({ quiet: true });
const fs = require("node:fs");
const path = require("node:path");
const { Client } = require("pg");
const ax = require("../src/lib/accountingExport");
const config = require("../src/lib/config");

function parseArgs(argv) {
  const a = { force: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === "--force") a.force = true;
    else if (["--month", "--year", "--out", "--fiscal-start-month"].includes(k)) {
      if (argv[i + 1] === undefined) throw new Error(`${k} needs a value.`);
      a[k.slice(2)] = argv[++i];
    } else throw new Error(`Unknown option ${k}.`);
  }
  if (a.month && a.year) throw new Error("Use --month or --year, not both.");
  if (!a.out) throw new Error("--out DIR is required.");
  return a;
}

function resolveRange(a, now) {
  const fiscal = a["fiscal-start-month"] || config.get("FISCAL_YEAR_START_MONTH");
  if (a.year) {
    const year = a.year === "last" ? ax.lastFiscalYearStart(now, fiscal) : Number(a.year);
    return ax.yearRange(year, fiscal);
  }
  const label = a.month || ax.previousMonth(now);
  ax.checkMonthAllowed(label, now, a.force);
  return ax.monthRange(label);
}

async function main(argv, now = new Date()) {
  const a = parseArgs(argv);
  const range = resolveRange(a, now);
  if (!config.get("DATABASE_URL")) throw new Error("DATABASE_URL is not set.");
  const client = new Client({
    connectionString: config.get("DATABASE_URL"),
    // Same TLS stance as src/db.js: encrypted, certificate not verified. PGSSLMODE=disable for a local database.
    ssl: config.get("PGSSLMODE") ? false : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000,
  });
  await client.connect();
  let result;
  try {
    await client.query("BEGIN READ ONLY");
    await client.query("SET LOCAL statement_timeout = '120s'");
    result = await ax.buildExport(client, range, { now });
    await client.query("ROLLBACK");
  } finally {
    await client.end().catch(() => {});
  }
  const names = ax.fileNames(range);
  fs.mkdirSync(a.out, { recursive: true });
  fs.writeFileSync(path.join(a.out, names.accounting), result.accountingCsv);
  fs.writeFileSync(path.join(a.out, names.till), result.tillCsv);
  fs.writeFileSync(path.join(a.out, names.summary), result.summary);
  fs.writeFileSync(path.join(a.out, names.email), ax.emailBody(range, result.stats));
  const s = result.stats;
  console.log(`Period ${range.label}: ${range.from} to ${range.to}`);
  console.log(`Accounting rows: ${s.accountingRows}; total ${ax.eurText(s.totalCents)} EUR`);
  console.log(`Till days: ${s.tillDays}; till sales: ${s.sales}; refunded reservations: ${s.refunds}; voided: ${s.voids}; unclosed days with sales: ${s.unclosedDays}`);
  console.log(`Files written: ${names.accounting}, ${names.till}, ${names.summary}, ${names.email}`);
  if (config.get("GITHUB_OUTPUT")) {
    fs.appendFileSync(config.get("GITHUB_OUTPUT"), `label=${range.label}\nfolder=${range.folderYear}\ntotal=${ax.eurText(s.totalCents)}\nrows=${s.accountingRows}\n`);
  }
  return result;
}

if (require.main === module) {
  main(process.argv.slice(2)).then(() => process.exit(0), (e) => {
    console.error(`Export failed, nothing was uploaded: ${e.message}`);
    process.exit(1);
  });
}

module.exports = { main, parseArgs, resolveRange };
