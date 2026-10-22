// Admin Inventory search filters (location, condition, binding, genre, price)
// over HTTP, in-process. See src/lib/inventorySearch.js.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");

const db = prepareDatabase("admin_inv_filters", { isolated: true });
const { pool } = require("../../src/db");
const { parseInventoryFilters, filterQueryString } = require("../../src/lib/inventorySearch");

let server;
let adminId;
before(async () => {
  db.create();
  server = await listen(buildApp([require("../../src/routes/admin/inventory")]));
  const { rows } = await pool.query(
    "INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ('flt-admin@example.test', 'x', 'F', true) RETURNING id");
  adminId = rows[0].id;
});
after(async () => { await server.close(); await pool.end(); db.drop(); });

const hdr = () => ({ "x-test-user": JSON.stringify({ id: adminId, email: "flt-admin@example.test", displayName: "A", isAdmin: true }) });
const get = async (path) => {
  const res = await fetch(`${server.base}${path}`, { headers: hdr(), signal: AbortSignal.timeout(15000) });
  return { status: res.status, text: await res.text() };
};
async function book(title, { binding = null, categories = null, copies = [{}] } = {}) {
  const { rows } = await pool.query("INSERT INTO books (title, authors, binding, categories) VALUES ($1, 'Flt Author', $2, $3) RETURNING id", [title, binding, categories]);
  for (const c of copies) {
    await pool.query("INSERT INTO book_copies (book_id, status, condition, price, location) VALUES ($1, $2, $3, $4, $5)",
      [rows[0].id, c.status || "in_stock", c.condition || "good", c.price === undefined ? 5 : c.price, c.location === undefined ? null : c.location]);
  }
  return rows[0].id;
}
// Titles listed by a search (only this file's books, tagged "FLT").
async function titles(qs) {
  const { status, text } = await get(`/admin/inventory?q=FLT&${qs}`);
  assert.equal(status, 200);
  return [...text.matchAll(/<strong>(FLT [^<]*)<\/strong>\s*<\/a>/g)].map((m) => m[1]).sort();
}
const T = (s) => `FLT ${s}`;

test("seed", async () => {
  await book(T("store-good-5"), { binding: "trade", categories: "Fiction", copies: [{ location: "Store", condition: "good", price: 5 }] });
  await book(T("STORE-new-12"), { binding: "hardcover", categories: "Non-fiction", copies: [{ location: "STORE", condition: "new", price: 12 }] });
  await book(T("shelf-vg-8"), { binding: "mass_market", categories: "Science Fiction, Fantasy", copies: [{ location: "Shelf A", condition: "very_good", price: 8.5 }] });
  await book(T("nowhere"), { binding: null, categories: null, copies: [{ location: null, condition: "good", price: 3 }] });
  await book(T("split"), { binding: "trade", categories: " fiction ,Mystery", copies: [{ location: "Store", condition: "new", price: 20 }, { location: "Shelf A", condition: "good", price: 4 }] });
  await book(T("sold-store"), { binding: "trade", categories: "Fiction", copies: [{ status: "sold", location: "Store", condition: "good", price: 5 }] });
  await book(T("noprice"), { binding: "trade", categories: "", copies: [{ location: "Store", condition: "good", price: null }] });
  assert.equal((await titles("")).length, 7);
});

test("location alone: case-insensitive, in-stock only; No location set", async () => {
  assert.deepEqual(await titles("location=store"), [T("STORE-new-12"), T("noprice"), T("split"), T("store-good-5")]);
  assert.deepEqual(await titles("location=STORE"), await titles("location=Store"));
  assert.deepEqual(await titles("location=__none__"), [T("nowhere")]);
  assert.deepEqual(await titles("location=Shelf%20A"), [T("shelf-vg-8"), T("split")]);
});

test("condition, binding alone", async () => {
  assert.deepEqual(await titles("condition=new"), [T("STORE-new-12"), T("split")]);
  assert.deepEqual(await titles("binding=hardcover"), [T("STORE-new-12")]);
  assert.deepEqual(await titles("binding=mass_market"), [T("shelf-vg-8")]);
  assert.deepEqual(await titles("binding=__none__"), [T("nowhere")]);
  assert.deepEqual(await titles("binding=paperback"), await titles("binding=trade"), "legacy paperback = trade");
});

test("price alone: comma or dot, bounds inclusive, NULL price never matches", async () => {
  assert.deepEqual(await titles("priceMin=8,50"), [T("STORE-new-12"), T("shelf-vg-8"), T("split")]);
  assert.deepEqual(await titles("priceMax=3"), [T("nowhere")]);
  assert.deepEqual(await titles("priceMin=5&priceMax=8.5"), [T("shelf-vg-8"), T("store-good-5")]);
  assert.ok(!(await titles("priceMax=1000")).includes(T("noprice")));
});

test("same-copy semantics: location+condition+price must be met by ONE copy", async () => {
  // split: Store copy is new/20, Shelf A copy is good/4.
  assert.deepEqual(await titles("location=Store&priceMax=5"), [T("store-good-5")], "split has Store and has a 4 euro copy, but not in one copy");
  assert.deepEqual(await titles("location=Shelf%20A&condition=new"), [], "split has Shelf A and a new copy, in two copies");
  assert.deepEqual(await titles("location=Store&condition=new&priceMin=15"), [T("split")]);
});

test("genre: exact token, case/space-insensitive, multi-genre, none", async () => {
  assert.deepEqual(await titles("genre=Fiction"), [T("sold-store"), T("split"), T("store-good-5")], "not Non-fiction, not Science Fiction");
  assert.deepEqual(await titles("genre=Non-fiction"), [T("STORE-new-12")]);
  assert.deepEqual(await titles("genre=Science%20Fiction"), [T("shelf-vg-8")]);
  assert.deepEqual(await titles("genre=Fantasy"), [T("shelf-vg-8")]);
  assert.deepEqual(await titles("genre=Mystery"), [T("split")]);
  assert.deepEqual(await titles("genre=__none__"), [T("noprice"), T("nowhere")], "NULL and empty genres");
});

test("filters combine with text, each other, and genre is book-level", async () => {
  assert.deepEqual(await titles("genre=Fiction&location=Store&priceMax=5"), [T("store-good-5")]);
  assert.deepEqual(await titles("genre=Fiction&binding=trade&condition=new"), [T("split")]);
  const { text } = await get("/admin/inventory?q=split&location=Store");
  assert.ok(text.includes(T("split")));
  assert.ok(!(await get("/admin/inventory?q=zzzz&location=Store")).text.includes(T("split")));
});

test("invalid price is ignored with a message; garbage values never 500", async () => {
  const r = await get("/admin/inventory?q=FLT&priceMin=abc&priceMax=-2");
  assert.equal(r.status, 200);
  assert.match(r.text, /Min price must be a number/);
  assert.match(r.text, /Max price cannot be negative/);
  assert.equal((await titles("priceMin=abc")).length, 7, "ignored bound = no bound");
  for (const qs of ["priceMin=1e999", "priceMin[]=1", "location[]=a&location=b", "condition=zzz", "binding=zzz", "genre=%25", "genre=a%00b", "location=%00", "priceMin=99999999999999999999"]) {
    assert.equal((await get(`/admin/inventory?${qs}`)).status, 200, qs);
  }
  assert.match((await get("/admin/inventory?condition=zzz")).text, /not one of the choices/);
  assert.equal((await titles("genre=%25")).length, 0, "% is literal, not a wildcard");
});

test("matched copies are shown; state stays in the form; Clear filters; count", async () => {
  const { text } = await get("/admin/inventory?q=FLT&location=Store&condition=new&priceMin=15");
  assert.match(text, /Matching copy:/);
  assert.match(text, /<strong>Store<\/strong> &middot; New &middot; €20\.00/);
  assert.ok(!text.includes("€4.00"), "the non-matching copy is not listed");
  assert.match(text, /1 book match/);
  assert.match(text, /Clear filters/);
  assert.match(text, /<option value="new" selected>New<\/option>/);
  assert.match(text, /name="priceMin"[^>]*value="15"/);
  assert.match(text, /<option value="Store" selected>Store<\/option>/, "dropdown shows the most common spelling");
  assert.ok(!/<option value="STORE"/.test(text), "one entry per case-insensitive location");
  assert.match((await get("/admin/inventory?q=FLT&genre=Fiction")).text, /<option value="Fiction" selected>/);
  const plain = await get("/admin/inventory");
  assert.ok(!/Clear filters/.test(plain.text) && !/Matching cop/.test(plain.text));
});

test("parse + query string round trip", () => {
  const f = parseInventoryFilters({ q: " x ", location: "  Shelf   A ", priceMin: "5,5", genre: "Fiction", binding: "hardback", condition: "new" });
  assert.equal(f.location, "Shelf A");
  assert.equal(f.priceMin, 5.5);
  assert.equal(f.binding, "hardcover");
  const qs = new URLSearchParams(filterQueryString(f));
  assert.equal(qs.get("priceMin"), "5,5");
  assert.equal(qs.get("genre"), "Fiction");
  assert.equal(parseInventoryFilters(undefined).errors.length, 0);
});
