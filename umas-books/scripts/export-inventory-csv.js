#!/usr/bin/env node
// Writes the "all inventory" CSV files into a directory (the nightly job,
// .github/workflows/inventory-export.yml, runs this; docs/runbook.md, "Nightly
// inventory export"):
//   inventory_YYYY-MM-DD.csv        one row per copy
//   inventory_latest.csv            the same file, under a fixed name
//   inventory_books_YYYY-MM-DD.csv  one row per book, with copy totals
// Usage: DATABASE_URL=... node scripts/export-inventory-csv.js --out <dir> [--date YYYY-MM-DD]
//
// Read-only SELECTs (works with the SELECT-only backup user). Prints COUNTS
// and file sizes as key=value lines, never a data row. Format and columns:
// src/lib/inventoryExport.js.

const fs = require("node:fs");
const path = require("node:path");
const { once } = require("node:events");

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

// A writable file as an async sink that respects backpressure.
function fileSink(file) {
  const stream = fs.createWriteStream(file);
  const failed = new Promise((_, reject) => stream.once("error", reject));
  return {
    sink: async (text) => { if (!stream.write(text)) await Promise.race([once(stream, "drain"), failed]); },
    close: async () => { stream.end(); await Promise.race([once(stream, "finish"), failed]); },
  };
}

async function main() {
  const outDir = arg("out");
  if (!outDir) throw new Error("Usage: export-inventory-csv.js --out <directory> [--date YYYY-MM-DD]");
  const { pool } = require("../src/db");
  const { todayParis, validDay } = require("../src/lib/reports");
  const { writeCopiesCsv, writeBooksCsv } = require("../src/lib/inventoryExport");
  const date = arg("date") ? validDay(arg("date")) : todayParis();
  if (!date) throw new Error("--date must be a real day, YYYY-MM-DD");
  fs.mkdirSync(outDir, { recursive: true });

  const copiesFile = path.join(outDir, `inventory_${date}.csv`);
  const booksFile = path.join(outDir, `inventory_books_${date}.csv`);
  const latestFile = path.join(outDir, "inventory_latest.csv");
  try {
    // The three reads see one consistent moment: a read-only repeatable-read transaction.
    const client = await pool.connect();
    let copies, books;
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const a = fileSink(copiesFile);
      copies = await writeCopiesCsv(client, a.sink);
      await a.close();
      const b = fileSink(booksFile);
      books = await writeBooksCsv(client, b.sink);
      await b.close();
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    fs.copyFileSync(copiesFile, latestFile);
    const n = (k) => copies.byStatus[k] || 0;
    const other = copies.rows - n("in_stock") - n("reserved") - n("sold");
    const lines = {
      date, copies: copies.rows, in_stock: n("in_stock"), reserved: n("reserved"), sold: n("sold"), other,
      books: books.rows, copies_bytes: fs.statSync(copiesFile).size, books_bytes: fs.statSync(booksFile).size,
    };
    for (const [k, v] of Object.entries(lines)) console.log(`${k}=${v}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(`Inventory export failed: ${err.message}`);
  process.exit(1);
});
