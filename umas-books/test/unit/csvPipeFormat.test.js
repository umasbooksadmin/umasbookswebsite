// The ONE CSV format (since 2026-10-30): "|" separator, no quote marks, decimal point, UTF-8 BOM, CRLF.
// (File name kept from the old French-Excel test; the French variant no longer exists.)
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { toCsv, wantsFrenchCsv, csvCell, CSV_SEP } = require("../../src/lib/reports");

const section = {
  columns: [{ key: "d", label: "Date", type: "text" }, { key: "n", label: "Count", type: "int" }, { key: "t", label: "Total (EUR)", type: "eur" }],
  rows: [{ d: "2026-10-01", n: 2, t: 12.5 }, { d: "2026-10-02", n: -1, t: -4 }], totals: { d: "Total", n: 1, t: 8.5 },
};

test("toCsv: | separator, decimal point, no quotes anywhere, BOM, CRLF", () => {
  const csv = toCsv(section);
  assert.ok(csv.startsWith("﻿"));
  const lines = csv.split("\r\n");
  assert.equal(lines[0].slice(1), "Date|Count|Total (EUR)");
  assert.equal(lines[1], "2026-10-01|2|12.50");
  assert.equal(lines[2], "2026-10-02|-1|-4.00");
  assert.equal(lines[3], "Total|1|8.50");
  assert.ok(!/\n/.test(csv.replace(/\r\n/g, "")), "only CRLF line ends");
  assert.ok(!csv.includes('"') && !csv.includes(";"), "no quote marks, no semicolons");
});

test("the old French options are accepted but change nothing", () => {
  assert.equal(CSV_SEP, "|");
  assert.equal(toCsv(section, { locale: "fr" }), toCsv(section));
  assert.equal(wantsFrenchCsv({ locale: "fr" }), true);
  assert.equal(wantsFrenchCsv({ format: "csv" }), false);
});

test("hostile text: | \" , ; newline and a leading = give ONE safe row with the right column count", () => {
  const hostile = '=Evil | "quoted", semi; colon\r\nnext\tline';
  const csv = toCsv({
    columns: [{ key: "a", label: 'Head | "x"', type: "text" }, { key: "b", label: "B", type: "text" }, { key: "t", label: "Total", type: "eur" }],
    rows: [{ a: hostile, b: "ok", t: 3 }],
  });
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines.length, 3, "header, one row, trailing empty");
  for (const l of lines.slice(0, 2)) assert.equal(l.split("|").length, 3, l);
  assert.equal(lines[0], "Head / 'x'|B|Total");
  assert.equal(lines[1], "'=Evil / 'quoted', semi; colon next line|ok|3.00");
  assert.equal(csvCell("|"), "/");
  assert.ok(!csv.includes('"'), "no double quote anywhere, header included");
});

test('double quotes become apostrophes: Le "Petit" Prince, a value starting with a quote, typographic quotes', () => {
  assert.equal(csvCell('Le "Petit" Prince'), "Le 'Petit' Prince");
  assert.equal(csvCell('"Starts with a quote'), "'Starts with a quote");
  assert.equal(csvCell("\u201CCurly\u201D \u201Elow\u201D"), "'Curly' 'low'");
  const csv = toCsv({ columns: [{ key: "a", label: '"H"', type: "text" }], rows: [{ a: '"x,y"' }, { a: 'Le "Petit" Prince' }] });
  assert.ok(!csv.includes('"'));
  assert.deepEqual(csv.slice(1).split("\r\n"), ["'H'", "'x,y'", "Le 'Petit' Prince", ""]);
});

test("the crawler skips both CSV downloads", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "..", "scripts", "sitemap", "crawler.js"), "utf8");
  const re = new RegExp(src.match(/const DOWNLOAD_QUERY = \/(.*)\/([a-z]*);/)[1], "i");
  for (const q of ["?format=csv", "?format=csv&table=export", "?from=2026-01-01&format=csv&locale=fr", "?format=csv&locale=fr", "?format=csv-fr&from=x"]) assert.ok(re.test(q), q);
  assert.ok(!re.test("?format=html"));
});
