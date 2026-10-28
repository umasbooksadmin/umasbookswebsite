// Admin Inventory "date received" filter (book_copies.acquired_at, the copy's Acquisition Date): Received from / Received
// to (inclusive calendar days, either optional) and "No date received set", through the real route and database, on the
// screen and in "Download these results (CSV)". A copy-level filter: ONE in-stock copy must match it together with
// location / condition / price. See src/lib/inventorySearch.js.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");

const db = prepareDatabase("admin_inv_received", { isolated: true });
const { pool } = require("../../src/db");
const { parseInventoryFilters, filterQueryString } = require("../../src/lib/inventorySearch");

let server;
let adminId;
before(async () => {
  db.create();
  server = await listen(buildApp([require("../../src/routes/admin/inventory")]));
  const { rows } = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ('rcv-admin@example.test', 'x', 'R', true) RETURNING id");
  adminId = rows[0].id;
});
after(async () => { await server.close(); await pool.end(); db.drop(); });

const hdr = () => ({ "x-test-user": JSON.stringify({ id: adminId, email: "rcv-admin@example.test", displayName: "A", isAdmin: true }) });
const get = async (path) => {
  const res = await fetch(`${server.base}${path}`, { headers: hdr(), signal: AbortSignal.timeout(15000) });
  return { status: res.status, text: Buffer.from(await res.arrayBuffer()).toString("utf8") };
};
const T = (s) => `RCV ${s}`;
const copyIdsByTitle = new Map();
async function book(title, copies) {
  const { rows } = await pool.query("INSERT INTO books (title, authors) VALUES ($1, 'Rcv Author') RETURNING id", [T(title)]);
  const ids = [];
  for (const c of copies) {
    const { rows: [cp] } = await pool.query(
      "INSERT INTO book_copies (book_id, status, condition, price, location, acquired_at) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
      [rows[0].id, c.status || "in_stock", c.condition || "good", c.price ?? 5, c.location ?? null, c.at ?? null]);
    ids.push(cp.id);
  }
  copyIdsByTitle.set(T(title), ids);
}
async function titles(qs) {
  const { status, text } = await get(`/admin/inventory?q=RCV&${qs}`);
  assert.equal(status, 200, qs);
  return [...text.matchAll(/<strong>(RCV [^<]*)<\/strong>\s*<\/a>/g)].map((m) => m[1]).sort();
}
// Copy ids in the per-copy results CSV (column 14 is the copy id) and book titles in the per-book file.
const csvRows = (text) => text.split("\r\n").slice(1).filter(Boolean);
const csvCopyIds = async (qs) => csvRows((await get(`/admin/inventory/results.csv?q=RCV&${qs}`)).text).map((l) => Number(l.split(";")[13])).sort((a, b) => a - b);

test("seed", async () => {
  await book("sep30", [{ at: "2026-09-30" }]);
  await book("oct01", [{ at: "2026-10-01" }]);
  await book("oct15", [{ at: "2026-10-15" }]);
  await book("oct31", [{ at: "2026-10-31" }]);
  await book("nov01", [{ at: "2026-11-01" }]);
  await book("undated", [{ at: null }]);
  await book("sold-oct10", [{ at: "2026-10-10", status: "sold" }]);
  // Two copies: an old Store copy in New, and an October Shelf copy in Good.
  await book("split", [{ at: "2026-01-05", location: "Store", condition: "new", price: 20 }, { at: "2026-10-20", location: "Shelf", condition: "good", price: 4 }]);
  assert.equal((await titles("")).length, 8);
});

test("from only, to only, both; both ends inclusive", async () => {
  assert.deepEqual(await titles("receivedFrom=2026-10-31"), [T("nov01"), T("oct31")], "from is inclusive");
  assert.deepEqual(await titles("receivedTo=2026-10-01"), [T("oct01"), T("sep30"), T("split")], "to is inclusive (split has a January copy)");
  assert.deepEqual(await titles("receivedFrom=2026-10-01&receivedTo=2026-10-31"), [T("oct01"), T("oct15"), T("oct31"), T("split")]);
  assert.deepEqual(await titles("receivedFrom=2026-10-15&receivedTo=2026-10-15"), [T("oct15")], "a single day");
  assert.deepEqual(await titles("receivedFrom=2026-10-02&receivedTo=2026-10-14"), []);
  assert.ok(!(await titles("receivedFrom=2026-10-01&receivedTo=2026-10-31")).includes(T("sold-oct10")), "in-stock copies only");
  assert.ok(!(await titles("receivedFrom=1900-01-01")).includes(T("undated")), "a copy with no date never matches a date range");
});

test("No date received set", async () => {
  assert.deepEqual(await titles("receivedNone=1"), [T("undated")]);
  assert.equal((await titles("receivedNone=0")).length, 8, "only 1 turns it on");
});

test("combined with condition/location: one copy must match all (never across copies)", async () => {
  // split: Store/new copy is from January, Shelf/good copy from October.
  assert.deepEqual(await titles("location=Store&receivedFrom=2026-10-01"), [], "Store copy is old, October copy is on Shelf");
  assert.deepEqual(await titles("condition=new&receivedFrom=2026-10-01&receivedTo=2026-10-31"), [], "new copy is old, October copy is good");
  assert.deepEqual(await titles("location=Shelf&condition=good&receivedFrom=2026-10-20&receivedTo=2026-10-20"), [T("split")]);
  assert.deepEqual(await titles("location=Store&receivedTo=2026-01-05"), [T("split")]);
  assert.deepEqual(await titles("priceMax=5&receivedTo=2026-06-30"), [], "split's 4 euro copy is from October, its January copy costs 20");
  assert.deepEqual(await titles("location=__none__&receivedNone=1"), [T("undated")]);
});

test("matched copies show the date received; state stays in the form; Clear filters; CSV links carry it", async () => {
  const { text } = await get("/admin/inventory?q=RCV&receivedFrom=2026-10-01&receivedTo=2026-10-31&location=Shelf");
  assert.match(text, /<strong>Shelf<\/strong> &middot; Good &middot; €4\.00 &middot; received 2026-10-20/);
  assert.ok(!text.includes("received 2026-01-05"), "the non-matching copy is not listed");
  assert.match(text, /name="receivedFrom" type="date" value="2026-10-01"/);
  assert.match(text, /name="receivedTo" type="date" value="2026-10-31"/);
  assert.match(text, /Clear filters/);
  assert.match(text, /results\.csv\?q=RCV&amp;location=Shelf&amp;receivedFrom=2026-10-01&amp;receivedTo=2026-10-31"/);
  assert.match(text, /results\.csv\?q=RCV&amp;location=Shelf&amp;receivedFrom=2026-10-01&amp;receivedTo=2026-10-31&amp;books=1"/);
  const none = await get("/admin/inventory?q=RCV&receivedNone=1");
  assert.match(none.text, /name="receivedNone" type="checkbox" value="1" checked/);
  assert.match(none.text, /no date received/);
  assert.match(none.text, /Clear filters/);
  assert.match(none.text, /results\.csv\?q=RCV&amp;receivedNone=1"/);
  // Received to alone also counts as a filter.
  assert.match((await get("/admin/inventory?receivedTo=2026-10-01")).text, /Clear filters/);
  const plain = await get("/admin/inventory?q=RCV");
  assert.ok(!/name="receivedNone"[^>]*checked/.test(plain.text) && !/received 20/.test(plain.text));
});

test("CSV of the results honours the date filter (per copy and per book)", async () => {
  const [oldSplit, octSplit] = copyIdsByTitle.get(T("split"));
  assert.deepEqual(await csvCopyIds("receivedFrom=2026-10-01&receivedTo=2026-10-31"),
    [copyIdsByTitle.get(T("oct01"))[0], copyIdsByTitle.get(T("oct15"))[0], copyIdsByTitle.get(T("oct31"))[0], octSplit].sort((a, b) => a - b),
    "only the matching copies (not split's January copy, not the sold copy)");
  assert.ok(!(await csvCopyIds("receivedFrom=2026-10-01")).includes(oldSplit));
  assert.deepEqual(await csvCopyIds("receivedNone=1"), copyIdsByTitle.get(T("undated")));
  assert.deepEqual(await csvCopyIds("location=Store&receivedFrom=2026-10-01"), []);
  const perBook = await get("/admin/inventory/results.csv?q=RCV&receivedFrom=2026-10-31&books=1");
  assert.equal(perBook.status, 200);
  assert.equal(csvRows(perBook.text).length, 2);
  assert.match(perBook.text, /RCV nov01/);
  assert.match(perBook.text, /RCV oct31/);
});

test("invalid dates and from > to: a filter message, never a 500", async () => {
  const bad = await get("/admin/inventory?q=RCV&receivedFrom=2026-02-31&receivedTo=yesterday");
  assert.equal(bad.status, 200);
  assert.match(bad.text, /class="error-box"/);
  assert.match(bad.text, /Received from must be a real date, like 2026-07-15\. It was ignored\./);
  assert.match(bad.text, /Received to must be a real date/);
  assert.equal((await titles("receivedFrom=2026-02-31")).length, 8, "ignored bound = no bound");
  const rev = await get("/admin/inventory?q=RCV&receivedFrom=2026-10-31&receivedTo=2026-10-01");
  assert.equal(rev.status, 200);
  assert.match(rev.text, /Received from is later than Received to, so no copy can match\./);
  assert.deepEqual(await titles("receivedFrom=2026-10-31&receivedTo=2026-10-01"), []);
  const both = await get("/admin/inventory?q=RCV&receivedNone=1&receivedFrom=2026-10-01");
  assert.match(both.text, /cannot be combined with Received from/);
  assert.deepEqual(await titles("receivedNone=1&receivedFrom=2026-10-01"), [T("undated")], "No date set wins, the dates are ignored");
  for (const qs of ["receivedFrom=99999-01-01", "receivedFrom[]=2026-10-01", "receivedFrom=2026-10-01&receivedFrom=2026-10-02", "receivedTo=1899-12-31",
    "receivedTo=%00", "receivedFrom=2026-10-01%27%3B--", "receivedNone[]=1", "receivedFrom=01/10/2026"]) {
    const r = await get(`/admin/inventory?${qs}`);
    assert.equal(r.status, 200, qs);
    assert.equal((await get(`/admin/inventory/results.csv?${qs}`)).status, 200, `csv ${qs}`);
  }
  assert.match((await get("/admin/inventory/results.csv?receivedFrom=2026-13-01")).text, /;/, "CSV still served");
});

test("parse + query string round trip", () => {
  const f = parseInventoryFilters({ receivedFrom: " 2026-10-01 ", receivedTo: "2026-10-31" });
  assert.equal(f.receivedFrom, "2026-10-01");
  assert.equal(f.receivedTo, "2026-10-31");
  assert.equal(f.errors.length, 0);
  const qs = new URLSearchParams(filterQueryString(f));
  assert.equal(qs.get("receivedFrom"), "2026-10-01");
  assert.equal(qs.get("receivedTo"), "2026-10-31");
  assert.equal(qs.get("receivedNone"), null);
  assert.equal(new URLSearchParams(filterQueryString(parseInventoryFilters({ receivedNone: "1" }))).get("receivedNone"), "1");
});
