// The "all inventory" CSV: one row per COPY (book_copies joined to books), and a
// smaller one with one row per BOOK (copy totals). Used by the admin button
// (Inventory > Download all inventory) and by scripts/export-inventory-csv.js
// (the nightly job, .github/workflows/inventory-export.yml), so both give
// byte-identical files.
//
// READ-ONLY: SELECTs only (the nightly job connects as the SELECT-only backup
// user). NO PERSONAL DATA: no buyer or reservation-holder name, email or phone,
// no order or user id; a reserved copy is just status "Reserved".
//
// One dialect, the one the accounting export uses for French Excel (reports.js
// csvDialect("fr")): UTF-8 BOM, semicolon separator, decimal comma, CRLF line
// ends, text always quoted, a text cell starting with = + - @ tab or CR gets a
// leading apostrophe. Dates are ISO (YYYY-MM-DD, Paris days).
//
// Streamed: rows are read in batches by id (keyset pagination, so the
// statement timeout never matters) and handed to a sink one chunk at a time.
// Memory stays flat for any inventory size.

const { SITE_TIME_ZONE } = require("./tz");
const { STATUSES, SOURCES, bindingLabel, conditionLabel } = require("./inventory");
const { csvCell, csvDialect, csvDecimal, formatCell } = require("./reports");

const DIALECT = csvDialect("fr");
const BATCH = 2000;

const COPY_COLUMNS = [
  { key: "isbn13", label: "ISBN-13", type: "text" },
  { key: "isbn10", label: "ISBN-10", type: "text" },
  { key: "title", label: "Title", type: "text" },
  { key: "authors", label: "Author(s)", type: "text" },
  { key: "publisher", label: "Publisher", type: "text" },
  { key: "year", label: "Year", type: "int" },
  { key: "binding", label: "Binding", type: "text" },
  { key: "condition", label: "Condition", type: "text" },
  { key: "price", label: "Price (EUR)", type: "eur" },
  { key: "location", label: "Location", type: "text" },
  { key: "source", label: "Source", type: "text" },
  { key: "status", label: "Status", type: "text" },
  { key: "added", label: "Date added", type: "date" },
  { key: "copyId", label: "Copy ID", type: "int" },
  { key: "tillCode", label: "Till code", type: "text" },
  { key: "bookId", label: "Book ID", type: "int" },
  { key: "genres", label: "Genres", type: "text" },
  { key: "clearance", label: "Clearance", type: "text" },
  { key: "publisherPrice", label: "Publisher price (EUR)", type: "eur" },
  { key: "notes", label: "Notes", type: "text" },
  { key: "sold", label: "Date sold", type: "date" },
];

const BOOK_COLUMNS = [
  { key: "bookId", label: "Book ID", type: "int" },
  { key: "isbn13", label: "ISBN-13", type: "text" },
  { key: "isbn10", label: "ISBN-10", type: "text" },
  { key: "title", label: "Title", type: "text" },
  { key: "authors", label: "Author(s)", type: "text" },
  { key: "publisher", label: "Publisher", type: "text" },
  { key: "year", label: "Year", type: "int" },
  { key: "binding", label: "Binding", type: "text" },
  { key: "genres", label: "Genres", type: "text" },
  { key: "copies", label: "Copies (all)", type: "int" },
  { key: "inStock", label: "In store", type: "int" },
  { key: "reserved", label: "Reserved", type: "int" },
  { key: "sold", label: "Sold", type: "int" },
  { key: "other", label: "Donated or withdrawn", type: "int" },
];

// ---------- ISBN ----------

const digits = (isbn) => String(isbn || "").replace(/[^0-9Xx]/g, "").toUpperCase();

function isbn13Check(first12) {
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(first12[i]) * (i % 2 ? 3 : 1);
  return String((10 - (sum % 10)) % 10);
}
function isbn10Check(first9) {
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(first9[i]) * (10 - i);
  const c = (11 - (sum % 11)) % 11;
  return c === 10 ? "X" : String(c);
}

// The books table keeps ONE isbn per book (10 or 13 digits). Both forms are
// shown: the other one is computed (an ISBN-10 only exists for 978-). A value of
// any other length is shown as it is, in the ISBN-13 column, so nothing is lost.
function isbnForms(stored) {
  const d = digits(stored);
  if (d.length === 10 && /^\d{9}[\dX]$/.test(d)) {
    const first12 = "978" + d.slice(0, 9);
    return { isbn13: first12 + isbn13Check(first12), isbn10: d };
  }
  if (d.length === 13 && /^\d{13}$/.test(d)) {
    return { isbn13: d, isbn10: d.startsWith("978") ? d.slice(3, 12) + isbn10Check(d.slice(3, 12)) : "" };
  }
  return { isbn13: d, isbn10: "" };
}

// ---------- rows ----------

const STATUS_LABEL = Object.fromEntries(STATUSES.map((s) => [s.value, s.label]));
const SOURCE_LABEL = Object.fromEntries(SOURCES.map((s) => [s.value, s.label]));

function copyRow(r) {
  const f = isbnForms(r.isbn);
  return {
    ...f,
    title: r.title, authors: r.authors, publisher: r.publisher, year: r.published_year,
    binding: bindingLabel(r.binding) || "",
    condition: conditionLabel(r.condition),
    price: r.price, location: r.location,
    source: r.source ? SOURCE_LABEL[r.source] || r.source : "",
    status: STATUS_LABEL[r.status] || r.status,
    added: r.added, copyId: r.id, tillCode: `UB-${r.id}`, bookId: r.book_id,
    genres: r.categories, clearance: r.is_clearance ? "Yes" : "No",
    publisherPrice: r.publisher_price, notes: r.notes, sold: r.sold,
  };
}

function bookRow(r) {
  return {
    ...isbnForms(r.isbn), bookId: r.id, title: r.title, authors: r.authors, publisher: r.publisher,
    year: r.published_year, binding: bindingLabel(r.binding) || "", genres: r.categories,
    copies: r.copies, inStock: r.in_stock, reserved: r.reserved, sold: r.sold,
    other: r.copies - r.in_stock - r.reserved - r.sold,
  };
}

function csvHeader(columns) {
  return columns.map((c) => csvCell(c.label)).join(DIALECT.sep);
}

// Same cell rules as reports.js toCsv().
function csvLine(columns, row) {
  return columns.map((c) => {
    const cell = formatCell(row[c.key], c.type, { csv: true });
    if (c.type === "text" || c.type === "date") return csvCell(cell);
    return c.type === "int" ? cell : csvDecimal(cell, DIALECT);
  }).join(DIALECT.sep);
}

// ---------- streaming ----------

const PARIS_DAY = (col) => `to_char(${col} AT TIME ZONE '${SITE_TIME_ZONE}', 'YYYY-MM-DD')`;

// Send text to the sink in chunks of about 64 KB.
function chunker(sink) {
  let buf = "";
  return {
    async push(text) {
      buf += text;
      if (buf.length >= 65536) { const out = buf; buf = ""; await sink(out); }
    },
    async end() { if (buf) { const out = buf; buf = ""; await sink(out); } },
  };
}

// db: anything with a pg-style .query(). sink: async (string) => void.
// Returns counts only: { rows, byStatus: {in_stock, reserved, sold, ...} }.
async function writeCopiesCsv(db, sink, { batch = BATCH } = {}) {
  const out = chunker(sink);
  await out.push("﻿" + csvHeader(COPY_COLUMNS) + "\r\n");
  const byStatus = {};
  let rows = 0;
  let after = 0;
  for (;;) {
    const { rows: page } = await db.query(
      `SELECT c.id, c.book_id, c.condition, c.price, c.publisher_price, c.is_clearance, c.location, c.source,
              c.status, c.notes, ${PARIS_DAY("c.created_at")} AS added, ${PARIS_DAY("c.sold_at")} AS sold,
              b.isbn, b.title, b.authors, b.publisher, b.published_year, b.binding, b.categories
       FROM book_copies c JOIN books b ON b.id = c.book_id
       WHERE c.id > $1 ORDER BY c.id LIMIT $2`, [after, batch]
    );
    if (!page.length) break;
    for (const r of page) {
      await out.push(csvLine(COPY_COLUMNS, copyRow(r)) + "\r\n");
      byStatus[r.status] = (byStatus[r.status] || 0) + 1;
    }
    rows += page.length;
    after = page[page.length - 1].id;
    if (page.length < batch) break;
  }
  await out.end();
  return { rows, byStatus };
}

async function writeBooksCsv(db, sink, { batch = BATCH } = {}) {
  const out = chunker(sink);
  await out.push("﻿" + csvHeader(BOOK_COLUMNS) + "\r\n");
  let rows = 0;
  let after = 0;
  for (;;) {
    const { rows: page } = await db.query(
      `SELECT b.id, b.isbn, b.title, b.authors, b.publisher, b.published_year, b.binding, b.categories,
              COUNT(c.id)::int AS copies,
              COUNT(c.id) FILTER (WHERE c.status = 'in_stock')::int AS in_stock,
              COUNT(c.id) FILTER (WHERE c.status = 'reserved')::int AS reserved,
              COUNT(c.id) FILTER (WHERE c.status = 'sold')::int AS sold
       FROM books b LEFT JOIN book_copies c ON c.book_id = b.id
       WHERE b.id > $1 GROUP BY b.id ORDER BY b.id LIMIT $2`, [after, batch]
    );
    if (!page.length) break;
    for (const r of page) await out.push(csvLine(BOOK_COLUMNS, bookRow(r)) + "\r\n");
    rows += page.length;
    after = page[page.length - 1].id;
    if (page.length < batch) break;
  }
  await out.end();
  return { rows };
}

module.exports = { COPY_COLUMNS, BOOK_COLUMNS, DIALECT, isbnForms, copyRow, bookRow, csvHeader, csvLine, writeCopiesCsv, writeBooksCsv };
