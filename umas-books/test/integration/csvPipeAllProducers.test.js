// Every CSV the system produces uses ONE format: "|" separator, no quote marks around values, decimal
// point, UTF-8 BOM, CRLF. This runs each producer against seeded data that includes a hostile title
// (a pipe, a double quote, a comma, a semicolon, a line break and a leading =) and checks the file
// is still one clean row per record with the same number of columns on every line.
// Set CSV_SAMPLE_DIR to also save the files (test data only) for a human to open.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { tillHarness } = require("../helpers/tillHarness");
const ax = require("../../src/lib/accountingExport");

const HOSTILE = '=Evil | "quoted", semi; colon\r\nnext\tline';
const HOSTILE_SAFE = '\'=Evil / "quoted", semi; colon next line';
let h;
const samples = {};

before(async () => {
  h = await tillHarness({ port: 4498, ip: "10.80.98.98" });
  const day = today();
  const hostile = await h.seedBook(HOSTILE);
  const plain = await h.seedBook("Le Petit Prince");
  const c1 = await h.seedCopy(hostile.id, { price: 8, location: "Shelf | A" });
  const c2 = await h.seedCopy(hostile.id, { price: 12.5 });
  const c3 = await h.seedCopy(plain.id, { price: 4.5 });
  await h.seedCopy(plain.id, { price: 3, status: "sold" });
  for (const c of [c1, c3]) assert.equal((await h.sale([h.book(c)])).status, 200);
  await h.pool.query("UPDATE book_copies SET acquired_at = CURRENT_DATE - 800 WHERE id = $1", [c2]);
  h.day = day;
});
after(async () => { await h.stop(); });

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });

async function fetchBytes(p) {
  const res = await fetch(`${h.app.base}${p}`, { headers: { cookie: h.jar.header(), "x-forwarded-for": h.ip } });
  assert.equal(res.status, 200, p);
  return Buffer.from(await res.arrayBuffer()).toString("utf8");
}

// The format contract, applied to every file.
function assertPipeFormat(name, text) {
  samples[name] = text;
  assert.ok(text.startsWith("﻿"), `${name}: UTF-8 BOM`);
  assert.ok(text.endsWith("\r\n"), `${name}: ends with CRLF`);
  assert.ok(!/[^\r]\n/.test(text) && !/\r[^\n]/.test(text), `${name}: CRLF only, no stray CR or LF inside a row`);
  const lines = text.slice(1).split("\r\n").slice(0, -1);
  assert.ok(lines.length >= 2, `${name}: header and at least one row`);
  assert.ok(!lines[0].includes('"') && !lines[0].includes(";"), `${name}: header has no quotes or semicolons`);
  const cols = lines[0].split("|").length;
  assert.ok(cols > 2, `${name}: more than one column`);
  lines.forEach((l, i) => {
    assert.equal(l.split("|").length, cols, `${name} line ${i}: delimiter count must be columns-1: ${l}`);
    for (const f of l.split("|")) assert.ok(!(f.length > 1 && f.startsWith('"') && f.endsWith('"')), `${name} line ${i}: value wrapped in quotes: ${f}`);
  });
  assert.ok(!/\d,\d\d(\||$)/.test(lines.slice(1).map((l) => l.split("|").filter((f) => /^-?[\d.,]+$/.test(f)).join("|")).join("\n")), `${name}: decimal comma in a number`);
  return lines;
}

test("accounting report, till end of day, and the old French links: same pipe file", async () => {
  const acc = assertPipeFormat("accounting_report", await fetchBytes(`/admin/reports/accounting?from=${h.day}&to=${h.day}&format=csv`));
  assert.ok(acc.some((l) => /\|12\.50\||\|8\.00\||\|4\.50\|/.test(l)), "money with a decimal point");
  assert.equal(await fetchBytes(`/admin/reports/accounting?from=${h.day}&to=${h.day}&format=csv&locale=fr`), samples.accounting_report);
  assert.equal(await fetchBytes(`/admin/reports/accounting?from=${h.day}&to=${h.day}&format=csv-fr`), samples.accounting_report);
  const tillDay = assertPipeFormat("till_day", await fetchBytes(`/admin/till/day?day=${h.day}&format=csv`));
  assert.equal(tillDay.length, 3, "header and two sales");
  assert.ok(tillDay.some((l) => l.includes(HOSTILE_SAFE)), "hostile title is one safe cell in the Items column");
  assert.match(tillDay.join("\n"), /\|8\.00\|/);
  assert.equal(await fetchBytes(`/admin/till/day?day=${h.day}&format=csv&locale=fr`), samples.till_day);
});

test("another report (aging, oldest copies) is the same format", async () => {
  const lines = assertPipeFormat("report_aging_oldest", await fetchBytes("/admin/reports/aging?format=csv&table=oldest"));
  assert.ok(lines.some((l) => l.startsWith(HOSTILE_SAFE)), "hostile title: one row, | replaced, apostrophe on the formula");
});

test("inventory: all copies, all books, filtered results (copies and books)", async () => {
  const copies = assertPipeFormat("inventory_copies", await fetchBytes("/admin/inventory/export.csv"));
  const hostileRows = copies.filter((l) => l.includes(HOSTILE_SAFE));
  assert.equal(hostileRows.length, 2, "two copies of the hostile title, one row each");
  assert.ok(hostileRows.some((l) => l.includes("Shelf / A")), "pipe in a location becomes /");
  assert.ok(copies.some((l) => /\|12\.50\|/.test(l)), "price with decimal point");
  const books = assertPipeFormat("inventory_books", await fetchBytes("/admin/inventory/export.csv?books=1"));
  assert.equal(books.filter((l) => l.includes(HOSTILE_SAFE)).length, 1);
  assertPipeFormat("inventory_results_copies", await fetchBytes("/admin/inventory/results.csv?q=Prince"));
  assertPipeFormat("inventory_results_books", await fetchBytes("/admin/inventory/results.csv?q=Prince&books=1"));
});

test("accounting month files (accounting_<month>.csv and till_days_<month>.csv)", async () => {
  const range = { from: h.day, to: h.day, kind: "month", label: h.day.slice(0, 7), folderYear: h.day.slice(0, 4), startMonth: 1 };
  const out = await ax.buildExport(h.pool, range);
  const acc = assertPipeFormat("accounting_month", out.accountingCsv);
  assert.match(acc.join("\n"), /\|Books used\|Cash\|/);
  const till = assertPipeFormat("till_days_month", out.tillCsv);
  assert.equal(till[0].split("|").length, ax.TILL_HEADER.length);
  assert.match(ax.emailBody(range, out.stats), /Delimiter: Custom/, "the email explains how to open it");
  if (process.env.CSV_SAMPLE_DIR) {
    fs.mkdirSync(process.env.CSV_SAMPLE_DIR, { recursive: true });
    for (const [name, text] of Object.entries(samples)) fs.writeFileSync(path.join(process.env.CSV_SAMPLE_DIR, `${name}.csv`), text);
  }
});
