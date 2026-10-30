// "Download these results (CSV)" (/admin/inventory/results.csv): exactly the books/copies the search shows, from the same
// shared filter code, in the same French-Excel format as the full export. Own throwaway database.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");

const h = adminHarness("inventory_results_export", ["inventory"], { isolated: true });
async function get(p, user = h.admin) {
  const res = await fetch(`${h.base}${p}`, { redirect: "manual", headers: user ? { "x-test-user": JSON.stringify(user) } : {} });
  return { res, text: Buffer.from(await res.arrayBuffer()).toString("utf8") };
}
const rowsOf = (text) => text.split("\r\n").slice(1).filter(Boolean);
const copyIds = (text) => rowsOf(text).map((l) => Number(l.split("|")[13])).sort((a, b) => a - b);
// Book ids the on-screen list shows (links to /admin/inventory/<id>).
const listedBookIds = (html) => [...new Set([...html.matchAll(/href="\/admin\/inventory\/(\d+)"/g)].map((m) => Number(m[1])))].sort((a, b) => a - b);
const bookIdsOfCopies = (text) => [...new Set(rowsOf(text).map((l) => Number(l.split("|")[15])))].sort((a, b) => a - b);

before(async () => {
  await h.start();
  const mk = async (title, binding, categories, copies) => {
    const { rows: [b] } = await h.pool.query("INSERT INTO books (title, authors, binding, categories) VALUES ($1,'RX Author',$2,$3) RETURNING id", [title, binding, categories]);
    for (const c of copies) await h.pool.query("INSERT INTO book_copies (book_id, condition, price, status, location) VALUES ($1,$2,$3,$4,$5)", [b.id, c.cond || "good", c.price ?? 5, c.status || "in_stock", c.loc ?? null]);
  };
  await mk("RX split", "trade", "Fiction", [{ loc: "Storage", cond: "new", price: 20 }, { loc: "Shelf A", cond: "good", price: 4 }, { status: "sold", loc: "Storage" }]);
  await mk("RX hard", "hardcover", "Non-fiction", [{ loc: "Storage", cond: "good", price: 9 }]);
  await mk("RX none", null, null, [{ loc: null, cond: "good", price: 3 }]);
  await mk("=RX formula", "trade", "Fiction", [{ loc: "Shelf A", cond: "good", price: 7 }]);
  // more than the 200 the screen shows
  await h.pool.query(`WITH b AS (INSERT INTO books (title, authors) SELECT 'RXBULK ' || g, 'Bulk' FROM generate_series(1, 230) g RETURNING id)
    INSERT INTO book_copies (book_id, condition, price, status, location) SELECT id, 'good', 6, 'in_stock', 'Bulk' FROM b`);
});
after(async () => { await h.stop(); });

const FILTERS = ["", "q=RX", "q=split", "location=storage", "condition=new", "binding=hardcover", "genre=fiction", "priceMin=5", "priceMax=5", "priceMin=5&priceMax=10",
  "location=Storage&condition=good", "q=RX&location=Shelf%20A&binding=trade&genre=Fiction&priceMin=1&priceMax=10", "location=__none__", "binding=__none__", "genre=__none__", "q=zzzz-nothing",
  "receivedNone=1", "receivedFrom=2000-01-01", "receivedTo=2000-01-01", "location=Storage&receivedNone=1"];

test("each filter alone and combined: the download holds the same books as the screen", async () => {
  for (const f of FILTERS) {
    const screen = listedBookIds((await get(`/admin/inventory?${f}`)).text);
    const csv = await get(`/admin/inventory/results.csv?${f}`);
    assert.equal(csv.res.status, 200, f);
    const csvBooks = f.includes("q=RX") && !f.includes("q=RXBULK") && !/location|condition|binding|genre|price/.test(f) ? null : bookIdsOfCopies(csv.text);
    if (screen.length < 200) {
      // Without a copy filter a book with no copies is listed on screen but has no copy row: compare with the per-book file below.
      if (csvBooks) assert.deepEqual(csvBooks, screen.filter((id) => csvBooks.includes(id)), f);
    } else assert.ok(screen.every((id) => bookIdsOfCopies(csv.text).includes(id)), f);
    const perBook = await get(`/admin/inventory/results.csv?${f}&books=1`);
    const ids = rowsOf(perBook.text).map((l) => Number(l.split("|")[0])).sort((a, b) => a - b);
    if (screen.length < 200) assert.deepEqual(ids, screen, `${f} per book`);
  }
});

test("copy-level filters list only the copies that match (in stock); no filter lists every copy", async () => {
  const { text: loc } = await get("/admin/inventory/results.csv?location=storage&q=RX%20split");
  assert.equal(rowsOf(loc).length, 1);
  assert.match(loc, /\|Storage\|/);
  assert.ok(!/\|Shelf A\|/.test(loc) && !/\|Sold\|/.test(loc));
  const { text: all } = await get("/admin/inventory/results.csv?q=RX%20split");
  assert.equal(rowsOf(all).length, 3);
});

test("more than 200 matches: the download holds all of them", async () => {
  const { text } = await get("/admin/inventory/results.csv?q=RXBULK");
  assert.equal(rowsOf(text).length, 230);
  assert.equal((await get("/admin/inventory/results.csv?q=RXBULK&books=1")).text.split("\r\n").filter(Boolean).length, 231);
});

test("same format as the full export: header, BOM, decimal point, formula guard; file name has date and 'filtered'", async () => {
  const full = await get("/admin/inventory/export.csv");
  const part = await get("/admin/inventory/results.csv?q=RX%20formula");
  assert.ok(part.text.startsWith("﻿"));
  assert.equal(part.text.split("\r\n")[0], full.text.split("\r\n")[0]);
  assert.match(part.text, /\|'=RX formula\|/);
  assert.match(part.text, /\|7\.00\|/);
  assert.match(part.res.headers.get("content-disposition"), /attachment; filename="umas-inventory-filtered-\d{4}-\d\d-\d\d\.csv"/);
  // a row is byte-identical to the same copy's row in the full export
  const line = rowsOf(part.text)[0];
  assert.ok(rowsOf(full.text).includes(line));
  assert.match((await get("/admin/inventory/results.csv?books=1&q=RX")).res.headers.get("content-disposition"), /umas-inventory-books-filtered-/);
  // with no filter the copy rows equal the full export's
  assert.deepEqual(copyIds((await get("/admin/inventory/results.csv")).text), copyIds(full.text));
});

test("hostile parameters never give a 500", async () => {
  for (const f of ["q[]=a&q[]=b", "location[a]=1", "condition=%00", "priceMin=abc&priceMax=%27%3B--", "priceMin=9&priceMax=1", "genre=" + "x".repeat(500), "books[]=1", "binding=zz", "q=%25%5C_", "priceMin=1e999"]) {
    const { res } = await get(`/admin/inventory/results.csv?${f}`);
    assert.ok(res.status < 500, `${f} -> ${res.status}`);
  }
});

test("admin only, and each download is audited", async () => {
  for (const user of [null, h.member]) {
    const { res, text } = await get("/admin/inventory/results.csv?q=RX", user);
    assert.notEqual(res.status, 200);
    assert.ok(!text.includes("RX Author"));
  }
  const rows = await h.q("SELECT detail FROM admin_audit_log WHERE action = 'inventory.csv' AND detail LIKE 'filtered%'");
  assert.ok(rows.length >= 1);
});

test("the page offers both buttons and carries the search into the link", async () => {
  const { text } = await get("/admin/inventory?q=RX&location=Storage");
  assert.match(text, /Download all inventory \(CSV\)/);
  assert.match(text, /href="\/admin\/inventory\/results\.csv\?q=RX&amp;location=Storage"[^>]*>Download these results \(CSV\)/);
});
