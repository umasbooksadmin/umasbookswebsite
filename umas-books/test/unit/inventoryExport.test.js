"use strict";

// The inventory CSV builder (src/lib/inventoryExport.js): the exact column list
// (no personal data), the pipe format shared with every other CSV,
// delimiter and line-break safety, formula neutralisation, decimal points, ISBN forms, and
// batching.

const test = require("node:test");
const assert = require("node:assert/strict");
const x = require("../../src/lib/inventoryExport");
const { toCsv } = require("../../src/lib/reports");

const COPY_HEADER = [
  "ISBN-13", "ISBN-10", "Title", "Author(s)", "Publisher", "Year", "Binding", "Condition", "Price (EUR)", "Location",
  "Source", "Status", "Date added", "Copy ID", "Till code", "Book ID", "Genres", "Clearance", "Publisher price (EUR)", "Notes", "Date sold",
  "Date received", "Cost (EUR)", "Suggested price (EUR)",
];

test("the per-copy header is exactly this list, and has no personal-data column", () => {
  assert.deepEqual(x.COPY_COLUMNS.map((c) => c.label), COPY_HEADER);
  const all = [...x.COPY_COLUMNS, ...x.BOOK_COLUMNS].map((c) => `${c.key} ${c.label}`).join(" ").toLowerCase();
  assert.doesNotMatch(all, /name|e-?mail|phone|buyer|holder|reserved_by|user|order|address|customer/);
});

test("the per-book header", () => {
  assert.deepEqual(x.BOOK_COLUMNS.map((c) => c.label), [
    "Book ID", "ISBN-13", "ISBN-10", "Title", "Author(s)", "Publisher", "Year", "Binding", "Genres",
    "Copies (all)", "In store", "Reserved", "Sold", "Donated or withdrawn",
  ]);
});

const dbRow = {
  id: 42, book_id: 7, condition: "like_new", price: "6.50", publisher_price: null, is_clearance: true, location: "Store",
  source: "donation", status: "in_stock", notes: '=HYPERLINK("http://x")', added: "2026-10-01", sold: null,
  isbn: "978-2-07-036822-8", title: "Le 'Petit' Prince; suite", authors: "A. de Saint-Exupéry", publisher: "Gallimard",
  published_year: 1999, binding: "mass_market", categories: "Fiction, Classics",
  acquired: "2026-09-15", acquisition_cost: "0.00", suggested_price: "5.00",
};

test("one copy line: pipes, decimal point, no quotes, neutralised formula, labels", () => {
  const line = x.csvLine(x.COPY_COLUMNS, x.copyRow(dbRow));
  assert.equal(line, [
    "9782070368228", "207036822X", "Le 'Petit' Prince; suite", "A. de Saint-Exupéry", "Gallimard", "1999", "Mass Market",
    "Like New", "6.50", "Store", "Donation", "In Store", "2026-10-01", "42", "UB-42", "7", "Fiction, Classics", "Yes", "",
    "'=HYPERLINK('http://x')", "",
    "2026-09-15", "0.00", "5.00",
  ].join("|"));
});

test("formula starters are neutralised in every text cell (= + - @ tab CR)", () => {
  for (const bad of ["=1+1", "+1", "-1", "@SUM(A1)", "\tx", "\rx"]) {
    const line = x.csvLine(x.COPY_COLUMNS, x.copyRow({ ...dbRow, title: bad, notes: bad, location: bad }));
    assert.ok(line.includes(`'${bad.replace(/[\t\r]+/g, " ")}`), JSON.stringify(bad));
    assert.equal(line.split("|").length, x.COPY_COLUMNS.length, "still one column per field");
  }
});

test("a title with | \" , ; a line break and a leading = stays one safe row with the right column count", () => {
  const nasty = '=Evil | "quoted", semi; colon\r\nnext\tline';
  const line = x.csvLine(x.COPY_COLUMNS, x.copyRow({ ...dbRow, title: nasty, notes: nasty }));
  assert.ok(!/[\r\n\t]/.test(line), "no line break or tab inside the row");
  assert.equal(line.split("|").length, x.COPY_COLUMNS.length, "delimiter count = columns - 1");
  assert.ok(line.includes("'=Evil / 'quoted', semi; colon next line"), line);
});

test("same cell rules as the accounting export's toCsv (one format)", () => {
  const rows = [x.copyRow(dbRow), x.copyRow({ ...dbRow, id: 43, price: null, status: "sold", sold: "2026-10-02" })];
  const csv = toCsv({ columns: x.COPY_COLUMNS, rows });
  const mine = "\uFEFF" + [x.csvHeader(x.COPY_COLUMNS), ...rows.map((r) => x.csvLine(x.COPY_COLUMNS, r))].join("\r\n") + "\r\n";
  assert.equal(mine, csv);
  assert.ok(!csv.includes(";") || csv.includes("suite"), "no semicolon separators");
});

test("ISBN forms: 13 and 10 computed from either; other values kept as they are", () => {
  assert.deepEqual(x.isbnForms("978-0-306-40615-7"), { isbn13: "9780306406157", isbn10: "0306406152" });
  assert.deepEqual(x.isbnForms("0306406152"), { isbn13: "9780306406157", isbn10: "0306406152" });
  assert.deepEqual(x.isbnForms("080442957X"), { isbn13: "9780804429573", isbn10: "080442957X" });
  assert.deepEqual(x.isbnForms("9791032305089"), { isbn13: "9791032305089", isbn10: "" });
  assert.deepEqual(x.isbnForms("12345"), { isbn13: "12345", isbn10: "" });
  assert.deepEqual(x.isbnForms(null), { isbn13: "", isbn10: "" });
});

function fakeDb(rows) {
  const calls = [];
  return {
    calls,
    async query(sql, [after, limit]) {
      calls.push([after, limit]);
      return { rows: rows.filter((r) => r.id > after).slice(0, limit) };
    },
  };
}

test("copies are read in batches by id and streamed; counts by status; BOM, CRLF", async () => {
  const rows = [1, 2, 3, 4, 5].map((id) => ({ ...dbRow, id, status: id > 3 ? "sold" : "in_stock" }));
  const db = fakeDb(rows);
  let text = "";
  const res = await x.writeCopiesCsv(db, (s) => { text += s; }, { batch: 2 });
  assert.deepEqual(res, { rows: 5, byStatus: { in_stock: 3, sold: 2 } });
  assert.deepEqual(db.calls.map((c) => c[0]), [0, 2, 4]);
  assert.ok(text.startsWith("﻿" + x.csvHeader(x.COPY_COLUMNS) + "\r\n"));
  assert.equal(text.split("\r\n").length, 7); // header + 5 rows + trailing empty
  assert.doesNotMatch(text.replace(/\r\n/g, ""), /\n/);
});

test("zero rows: just the header", async () => {
  let text = "";
  const res = await x.writeCopiesCsv(fakeDb([]), (s) => { text += s; });
  assert.equal(res.rows, 0);
  assert.equal(text, "﻿" + x.csvHeader(x.COPY_COLUMNS) + "\r\n");
});

test("book rows: totals and the donated/withdrawn remainder", async () => {
  const b = { id: 1, isbn: "9780306406157", title: "T", authors: null, publisher: null, published_year: null, binding: null, categories: null, copies: 5, in_stock: 2, reserved: 1, sold: 1 };
  let text = "";
  await x.writeBooksCsv(fakeDb([b]), (s) => { text += s; });
  assert.equal(text.split("\r\n")[1], "1|9780306406157|0306406152|T||||||5|2|1|1|1");
});
