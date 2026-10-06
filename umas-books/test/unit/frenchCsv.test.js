// "Download for French Excel": semicolons, decimal commas, BOM, CRLF; the neutral CSV is unchanged.
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { toCsv, wantsFrenchCsv, csvDecimal, csvDialect } = require("../../src/lib/reports");

const section = {
  columns: [{ key: "d", label: "Date", type: "text" }, { key: "n", label: "Count", type: "int" }, { key: "t", label: "Total (EUR)", type: "eur" }],
  rows: [{ d: "2026-10-01", n: 2, t: 12.5 }, { d: "2026-10-02", n: -1, t: -4 }], totals: { d: "Total", n: 1, t: 8.5 },
};

test("neutral CSV: comma separator and decimal point", () => {
  const csv = toCsv(section);
  assert.ok(csv.startsWith("﻿"));
  assert.equal(csv.split("\r\n")[1], '"2026-10-01",2,12.50');
});

test("French CSV: ; separator, decimal comma, BOM, CRLF", () => {
  const csv = toCsv(section, { locale: "fr" });
  assert.ok(csv.startsWith("﻿"));
  const lines = csv.split("\r\n");
  assert.equal(lines[0].slice(1), '"Date";"Count";"Total (EUR)"');
  assert.equal(lines[1], '"2026-10-01";2;12,50');
  assert.equal(lines[2], '"2026-10-02";-1;-4,00');
  assert.ok(!/\n/.test(csv.replace(/\r\n/g, "")), "only CRLF line ends");
});

test("wantsFrenchCsv and the decimal helper", () => {
  assert.equal(wantsFrenchCsv({ locale: "fr" }), true);
  assert.equal(wantsFrenchCsv({ format: "csv-fr" }), true);
  assert.equal(wantsFrenchCsv({ format: "csv" }), false);
  assert.equal(csvDecimal("3.50", csvDialect("fr")), "3,50");
  assert.equal(csvDecimal("3.50", csvDialect("en")), "3.50");
});

test("the crawler skips both CSV downloads", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "sitemap", "crawler.js"), "utf8");
  const re = new RegExp(src.match(/const DOWNLOAD_QUERY = \/(.*)\/([a-z]*);/)[1], "i");
  for (const q of ["?format=csv", "?format=csv&table=export", "?from=2026-01-01&format=csv&locale=fr", "?format=csv&locale=fr", "?format=csv-fr&from=x"]) assert.ok(re.test(q), q);
  assert.ok(!re.test("?format=html"));
});
