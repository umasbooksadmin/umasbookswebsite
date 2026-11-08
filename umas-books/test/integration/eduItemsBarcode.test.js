/* global document */
// Educational items: the barcode (migration 116, lib/barcode.js) and its lookup in Admin > Educational items
// (src/routes/admin/eduItems.js, public/edu-item-form.js). The real router and views on an in-process app with a
// throwaway database; EVERY outside call is stubbed at global.fetch (Open Library, its covers, Open Products Facts,
// UPCitemdb), anything else is refused. Covers:
//   - saving: check digit, ISBN-10 -> ISBN-13, unique among items (also a UPC-A against its EAN-13 form) with the other
//     item named, audit "barcode none -> X", the Open Library picture only after "Use this picture"
//   - GET /admin/edu-items/lookup: ISBN found (title, source, exact-ISBN picture), UPC found (name only, never the
//     third-party image), not found, UPCitemdb 429, a source that times out, invalid, per-admin rate limit, admins only
//   - the duplicate-with-book warning (allowed, not refused)
//   - GET /admin/edu-items/find: to the edit page, or "No item with that barcode" + "Add a new item" pre-filled
//   - in headless Chrome: Enter in the barcode box looks up instead of saving, a typed Name / price is never overwritten
//     ("Use this name" instead), an empty Name is filled, "Use this picture" then Add item saves the picture.
const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");

process.env.SCAN_LOOKUP_SOURCES = "openlibrary"; // the ISBN branch: Open Library only, so the stubs stay small
process.env.SCAN_LOOKUP_TIMEOUT_MS = "1200";
process.env.SCAN_LOOKUP_HEDGE_MS = "0";
delete process.env.ISBNDB_API_KEY;

const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");
const db = prepareDatabase("edu_items_barcode", { isolated: true });
const { pool } = require("../../src/db");
const coverStore = require("../../src/lib/coverStore");
coverStore.setLookupForTests(async () => [{ address: "93.184.216.34", family: 4 }]);
const { lookupCache } = require("../../src/lib/bookLookup");
const { resetProductLookup, setProductTimeoutForTests } = require("../../src/lib/productLookup");
setProductTimeoutForTests(1200);
const { isbn13From, isbn10From } = require("../helpers/isbn");

// ---------- the outside world ----------
const realFetch = global.fetch;
const openLibrary = new Map(); // isbn -> data | "hang"
const covers = new Set(); // ISBN-13s Open Library has a cover for
const opf = new Map(); // code -> product_name
const upc = new Map(); // code -> { title, brand } | 429 | "hang"
const outside = [];
let jpeg;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const hang = (init) => new Promise((resolve, reject) => {
  if (init && init.signal) init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
});
global.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1:")) return realFetch(url, init);
  outside.push(`${init.method || "GET"} ${u}`);
  let m;
  if ((m = u.match(/^https:\/\/openlibrary\.org\/api\/volumes\/brief\/isbn\/([0-9X]+)\.json$/))) {
    const data = openLibrary.get(m[1]);
    if (data === "hang") return hang(init);
    return json(data ? { records: { r: { isbns: [m[1]], data } } } : {});
  }
  if ((m = u.match(/^https:\/\/covers\.openlibrary\.org\/b\/isbn\/([0-9X]+)-L\.jpg\?default=false$/))) {
    if (!covers.has(m[1])) return new Response("", { status: 404 });
    return new Response(init.method === "HEAD" ? null : jpeg, { status: 200, headers: { "content-type": "image/jpeg" } });
  }
  if ((m = u.match(/^https:\/\/world\.openproductsfacts\.org\/api\/v2\/product\/(\d+)\.json/))) {
    return opf.has(m[1]) ? json({ status: 1, product: { product_name: opf.get(m[1]) } }) : json({ status: 0 }, 404);
  }
  if ((m = u.match(/^https:\/\/api\.upcitemdb\.com\/prod\/trial\/lookup\?upc=(\d+)$/))) {
    const a = upc.get(m[1]);
    if (typeof a === "number") return json({ code: a === 429 ? "TOO_FAST" : "ERR", message: "x" }, a);
    if (a === "hang") return hang(init);
    return json(a ? { code: "OK", total: 1, items: [{ ...a, images: ["https://images.example/thirdparty.jpg"] }] } : { code: "OK", total: 0, items: [] });
  }
  throw new Error(`test refused a real outbound request to ${u}`);
};

let server;
let admin;
let seq = 0;
before(async () => {
  db.create();
  jpeg = await require("sharp")({ create: { width: 120, height: 160, channels: 3, background: "#3a6" } }).jpeg().toBuffer();
  const statics = express.static(path.join(__dirname, "..", "..", "public"));
  // The browser posts the form as multipart (it has a picture field): multer, as src/app.js puts in front of the router.
  const gate = express.Router();
  gate.use("/admin/edu-items", require("multer")({ storage: require("multer").memoryStorage() }).fields([{ name: "image", maxCount: 1 }]));
  server = await listen(buildApp([statics, gate, require("../../src/routes/admin/eduItems")]));
  admin = await makeAdmin();
});
after(async () => {
  global.fetch = realFetch;
  await server.close();
  await pool.end();
  db.drop();
});
beforeEach(() => { openLibrary.clear(); covers.clear(); opf.clear(); upc.clear(); outside.length = 0; lookupCache.clear(); resetProductLookup(); coverStore.clearCoverMemo && coverStore.clearCoverMemo(); });

async function makeAdmin(isAdmin = true) {
  const { rows } = await pool.query("INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ($1, 'x', 'Edu Admin', $2) RETURNING id", [`edu-bc-${Date.now()}-${++seq}@example.test`, isAdmin]);
  return { id: rows[0].id, email: "a@example.test", displayName: "Edu Admin", isAdmin, isMember: true };
}
const header = (user) => ({ "x-test-user": JSON.stringify(user) });
async function get(p, user = admin, cookie = "") {
  const res = await realFetch(`${server.base}${p}`, { redirect: "manual", headers: { ...header(user), ...(cookie ? { cookie } : {}) } });
  return { res, status: res.status, location: res.headers.get("location"), text: await res.text(), cookie: res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ") };
}
const lookup = async (code, user = admin, extra = "") => {
  const r = await get(`/admin/edu-items/lookup?barcode=${encodeURIComponent(code)}${extra}`, user);
  return { status: r.status, body: JSON.parse(r.text) };
};
// POST a form and follow the 303 with its session (the flash), like the browser.
async function post(p, fields, user = admin) {
  const res = await realFetch(`${server.base}${p}`, { method: "POST", redirect: "manual", headers: { ...header(user), "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() });
  if (res.status !== 303) return { status: res.status, text: await res.text() };
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const next = await get(res.headers.get("location"), user, cookie);
  return { status: 303, location: res.headers.get("location"), text: next.text };
}
const item = async (fields) => (await pool.query("INSERT INTO edu_items (name, price, stock, barcode) VALUES ($1, $2, $3, $4) RETURNING *", [fields.name, fields.price || 4, fields.stock || 1, fields.barcode || null])).rows[0];
const auditOf = async (action) => (await pool.query("SELECT * FROM admin_audit_log WHERE action = $1 ORDER BY id", [action])).rows;
const fresh13 = () => isbn13From(`978${String(Date.now()).slice(-5)}${String(++seq).padStart(4, "0")}`);
const decode = (s) => s.replace(/&#34;|&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

// ---------- saving ----------

test("migration 116: the column, its digits-only check and the unique index on the 14-digit form", async () => {
  await assert.rejects(pool.query("INSERT INTO edu_items (name, price, barcode) VALUES ('x', 1, '12AB')"), /edu_items_barcode_check/);
  await item({ name: "Index A", barcode: "012345678905" });
  await assert.rejects(pool.query("INSERT INTO edu_items (name, price, barcode) VALUES ('Index B', 1, '0012345678905')"), /edu_items_barcode_key/);
  await pool.query("INSERT INTO edu_items (name, price) VALUES ('No code 1', 1), ('No code 2', 1)"); // NULL many times
});

test("add: the barcode is saved (digits only), audited; a wrong check digit or a bad ISBN-10 is refused with a sentence", async () => {
  const bad = await post("/admin/edu-items", { name: "Bad Code", price: "3", stock: "1", genreId: "", barcode: "5901234123458" });
  assert.match(decode(bad.text), /The last digit of the barcode 5901234123458 should be 7 .* Nothing was saved\./);
  assert.match(bad.text, /value="5901234123458"/, "what was typed is put back in the box");
  const bad10 = await post("/admin/edu-items", { name: "Bad Code", price: "3", stock: "1", genreId: "", barcode: "0306406153" });
  assert.match(bad10.text, /10-digit ISBN/);
  assert.equal((await pool.query("SELECT 1 FROM edu_items WHERE name = 'Bad Code'")).rows.length, 0);

  await post("/admin/edu-items", { name: "Scanned Puzzle", price: "3", stock: "2", genreId: "", barcode: " 590-1234-123457 " });
  assert.equal((await pool.query("SELECT barcode FROM edu_items WHERE name = 'Scanned Puzzle'")).rows[0].barcode, "5901234123457");
  assert.match((await auditOf("edu_item.add")).pop().detail, /barcode 5901234123457/);
});

test("an ISBN-10 is saved as its ISBN-13, like the book intake", async () => {
  const ten = isbn10From(`03${String(++seq).padStart(7, "0")}`);
  await post("/admin/edu-items", { name: "Old Isbn Workbook", price: "5", stock: "1", genreId: "", barcode: ten });
  const { isbn10to13 } = require("../../src/lib/bookSources");
  assert.equal((await pool.query("SELECT barcode FROM edu_items WHERE name = 'Old Isbn Workbook'")).rows[0].barcode, isbn10to13(ten));
});

test("unique among items: the refusal names the other item (also a UPC-A typed as its EAN-13), on add and on edit", async () => {
  const first = await item({ name: "Owner Of Code", barcode: "882319024812" });
  const dup = await post("/admin/edu-items", { name: "Second One", price: "2", stock: "1", genreId: "", barcode: "0882319024812" });
  assert.match(decode(dup.text), /The barcode is already on the item "Owner Of Code"\..*Nothing was saved\./);
  assert.equal((await pool.query("SELECT 1 FROM edu_items WHERE name = 'Second One'")).rows.length, 0);
  const other = await item({ name: "Other Item" });
  const edit = await post(`/admin/edu-items/${other.id}`, { name: "Other Item", price: "4", stock: "1", genreId: "", sortOrder: "0", barcode: "882319024812" });
  assert.match(decode(edit.text), /already on the item "Owner Of Code"/);
  assert.equal((await pool.query("SELECT barcode FROM edu_items WHERE id = $1", [other.id])).rows[0].barcode, null);
  // Saving the owner itself with its own code is fine.
  await post(`/admin/edu-items/${first.id}`, { name: "Owner Of Code", price: "4", stock: "1", genreId: "", sortOrder: "0", barcode: "882319024812" });
  assert.match((await auditOf("edu_item.edit")).pop().detail, /no change/);
});

test("edit: barcode changes are audited like other fields (none -> X, X -> none)", async () => {
  const it = await item({ name: "Audit Me" });
  await post(`/admin/edu-items/${it.id}`, { name: "Audit Me", price: "4", stock: "1", genreId: "", sortOrder: "0", barcode: "96385074" });
  assert.match((await auditOf("edu_item.edit")).pop().detail, /barcode none -> 96385074/);
  const form = await get(`/admin/edu-items/${it.id}/edit`);
  assert.match(form.text, /id="edu-barcode" name="barcode"[^>]*value="96385074"/);
  await post(`/admin/edu-items/${it.id}`, { name: "Audit Me", price: "4", stock: "1", genreId: "", sortOrder: "0", barcode: "" });
  assert.match((await auditOf("edu_item.edit")).pop().detail, /barcode 96385074 -> none/);
  assert.equal((await pool.query("SELECT barcode FROM edu_items WHERE id = $1", [it.id])).rows[0].barcode, null);
});

test("cost (migration 115) and barcode together: both saved on add and edit, both audited, both put back after a refusal", async () => {
  await post("/admin/edu-items", { name: "Cost And Code", price: "4,50", cost: "1,35", stock: "2", genreId: "", barcode: "4006381333948" });
  const row = (await pool.query("SELECT id, cost, barcode FROM edu_items WHERE name = 'Cost And Code'")).rows[0];
  assert.equal(Number(row.cost), 1.35);
  assert.equal(row.barcode, "4006381333948");
  assert.match((await auditOf("edu_item.add")).pop().detail, /cost €1\.35, stock 2, barcode 4006381333948/);
  await post(`/admin/edu-items/${row.id}`, { name: "Cost And Code", price: "4.50", cost: "2", stock: "2", genreId: "", sortOrder: "0", barcode: "73513537" });
  const d = (await auditOf("edu_item.edit")).pop().detail;
  assert.match(d, /cost €1\.35 -> €2\.00/);
  assert.match(d, /barcode 4006381333948 -> 73513537/);
  const after = (await pool.query("SELECT cost, barcode FROM edu_items WHERE id = $1", [row.id])).rows[0];
  assert.deepEqual([Number(after.cost), after.barcode], [2, "73513537"]);
  const bad = await post(`/admin/edu-items/${row.id}`, { name: "Cost And Code", price: "4.50", cost: "3", stock: "2", genreId: "", sortOrder: "0", barcode: "73513538" });
  assert.match(bad.text, /should be 7/);
  assert.match(bad.text, /id="edu-cost" name="cost"[^>]*value="3"/);
  assert.match(bad.text, /id="edu-barcode" name="barcode"[^>]*value="73513538"/);
  const form = (await get(`/admin/edu-items/${row.id}/edit`)).text;
  assert.match(form, /id="edu-cost" name="cost"[^>]*value="2\.00"/);
  assert.match(form, /id="edu-barcode" name="barcode"[^>]*value="73513537"/);
});

// ---------- the lookup ----------

test("lookup, ISBN found: the title as the name, the source, by/publisher, and the exact-ISBN picture as a suggestion", async () => {
  const isbn = fresh13();
  openLibrary.set(isbn, { title: "Spectrum Grade 2 Math", subtitle: "Workbook", authors: [{ name: "Spectrum" }], publishers: [{ name: "Carson Dellosa" }], publish_date: "2014" });
  covers.add(isbn);
  const { status, body } = await lookup(isbn);
  assert.equal(status, 200);
  assert.equal(body.state, "found");
  assert.equal(body.kind, "isbn");
  assert.equal(body.source, "Open Library");
  assert.equal(body.name, "Spectrum Grade 2 Math: Workbook");
  assert.equal(body.details, "by Spectrum, Carson Dellosa, 2014");
  assert.match(body.message, /^Found at Open Library\./);
  assert.match(body.picture, /^\/img\/[0-9a-f]{64}\.jpg$/, "our own stored copy, never an outside address");
  assert.equal(body.bookInShop, null);
  assert.equal(await pool.query("SELECT count(*)::int AS n FROM edu_items WHERE barcode = $1", [isbn]).then((r) => r.rows[0].n), 0, "nothing saved");
});

test("lookup, ISBN-10 typed: answered for its ISBN-13 and the page is told about the conversion", async () => {
  const ten = isbn10From(`19${String(++seq).padStart(7, "0")}`);
  const { isbn10to13 } = require("../../src/lib/bookSources");
  openLibrary.set(isbn10to13(ten), { title: "Old Workbook" });
  const { body } = await lookup(ten);
  assert.equal(body.barcode, isbn10to13(ten));
  assert.equal(body.convertedFrom, ten);
  assert.equal(body.name, "Old Workbook");
  assert.equal(body.picture, null, "no cover for it");
});

test("lookup, UPC found: the NAME only (from UPCitemdb), never its third-party picture", async () => {
  upc.set("882319024812", { title: "Watch Me Learn: Learn to Read (TCR 8407)", brand: "Teacher Created Resources" });
  const { body } = await lookup("882319024812");
  assert.equal(body.state, "found");
  assert.equal(body.kind, "product");
  assert.equal(body.source, "UPCitemdb");
  assert.equal(body.name, "Teacher Created Resources Watch Me Learn: Learn to Read (TCR 8407)");
  assert.equal(body.picture, null);
  assert.ok(!JSON.stringify(body).includes("thirdparty"), "no UPCitemdb image anywhere in the answer");
  assert.ok(outside.some((u) => u.includes("openproductsfacts")), "Open Products Facts was asked first");
  assert.ok(!outside.some((u) => u.includes("images.example")), "the image was never fetched");
});

test("lookup, UPC found at Open Products Facts: UPCitemdb's daily allowance is not spent", async () => {
  opf.set("5901234123457", "Wooden Alphabet Puzzle");
  const { body } = await lookup("5901234123457");
  assert.equal(body.source, "Open Products Facts");
  assert.equal(body.name, "Wooden Alphabet Puzzle");
  assert.ok(!outside.some((u) => u.includes("upcitemdb")));
});

test("lookup, not found anywhere: one plain sentence", async () => {
  const { body } = await lookup("96385074");
  assert.equal(body.state, "missing");
  assert.equal(body.message, "Nothing found for this barcode: type the details in.");
  const isbn = fresh13();
  const r = await lookup(isbn);
  assert.equal(r.body.state, "missing");
});

test("lookup, UPCitemdb answers 429 (free limit): says the free database is limiting this site, and the next scan does not call it", async () => {
  upc.set("036000291452", 429);
  const { status, body } = await lookup("036000291452");
  assert.equal(status, 200);
  assert.equal(body.state, "unavailable");
  assert.equal(body.failure, "limit");
  assert.equal(body.message, "The free barcode database is limiting requests from this site (it allows about 100 a day). Try again later, or type the details in.");
  const before = outside.filter((u) => u.includes("upcitemdb")).length;
  const again = await lookup("036000291452");
  assert.equal(again.body.failure, "limit", "during the pause it says the same");
  assert.equal(outside.filter((u) => u.includes("upcitemdb")).length, before, "paused: no new call");
});

test("lookup, UPCitemdb refuses (403) or fails (500): a specific sentence each, never the generic one", async () => {
  upc.set("036000291452", 403);
  const refused = (await lookup("036000291452")).body;
  assert.equal(refused.failure, "refused");
  assert.match(refused.message, /refused the request/);
  upc.set("036000291452", 500);
  const down = (await lookup("036000291452")).body;
  assert.equal(down.failure, "server");
  assert.match(down.message, /problem on its side/);
});

test("lookup, a barcode UPCitemdb knows while Open Products Facts answers 404 (the real shape): found", async () => {
  upc.set("088231920519", { title: "Shapes and Colors Flash Cards", brand: "Teacher Created Resources" });
  const { body } = await lookup("088231920519");
  assert.equal(body.state, "found");
  assert.equal(body.source, "UPCitemdb");
  assert.equal(body.name, "Teacher Created Resources Shapes and Colors Flash Cards");
});

test("lookup, the shop's own records cannot be checked: the outside lookup still answers in JSON (no bare server error)", async () => {
  const realQuery = pool.query.bind(pool);
  pool.query = async (...a) => { if (/FROM edu_items WHERE barcode IS NOT NULL/.test(String(a[0]))) throw new Error("db down"); return realQuery(...a); };
  try {
    const { status, body } = await lookup("96385074");
    assert.equal(status, 200);
    assert.equal(body.state, "missing", "the outside lookup still ran");
  } finally { pool.query = realQuery; }
});

test("diagnostics: /admin/diagnostics/lookup shows the product sources, the quota, the pause, and no key", async () => {
  const diag = express.Router();
  const alone = await listen(buildApp([diag.use(require("../../src/routes/admin/diagnostics"))]));
  try {
    const get = () => realFetch(`${alone.base}/admin/diagnostics/lookup`, { headers: header(admin) }).then((r) => r.text());
    upc.set("036000291452", 429);
    await lookup("036000291452");
    const html = await get();
    assert.match(html, /Barcode lookup for educational items/);
    assert.match(html, /Last failure: <strong>http 429<\/strong>/);
    assert.match(html, /Paused until/);
    assert.doesNotMatch(html, /036000291452/, "no barcode is kept");
  } finally { await alone.close(); }
});

test("lookup, a source that times out: unavailable, quickly enough, nothing cached", async () => {
  upc.set("4006381333931", "hang");
  const t0 = Date.now();
  const { body } = await lookup("4006381333931");
  assert.equal(body.state, "unavailable");
  assert.ok(Date.now() - t0 < 6000);
  assert.equal(body.failure, "timeout");
  assert.equal(body.message, "The barcode database did not answer in time. Try again, or type the details in.");
  const isbn = fresh13();
  openLibrary.set(isbn, "hang");
  const r = await lookup(isbn);
  assert.equal(r.body.state, "unavailable");
  assert.equal(r.body.message, "Lookup unavailable right now: type the details in.");
  openLibrary.set(isbn, { title: "Now It Answers" });
  assert.equal((await lookup(isbn)).body.name, "Now It Answers", "the timeout was not cached");
});

test("lookup, invalid barcode: a 400 with the sentence, and no outside call", async () => {
  const { status, body } = await lookup("5901234123458");
  assert.equal(status, 400);
  assert.equal(body.state, "invalid");
  assert.match(body.message, /should be 7/);
  assert.equal(outside.length, 0);
});

test("lookup says when the barcode is already on another item (not when it is this item's own)", async () => {
  const it = await item({ name: "Has Seven", barcode: "4006381333924" });
  const r = await lookup("4006381333924");
  assert.deepEqual(r.body.usedBy, { id: it.id, name: "Has Seven", href: `/admin/edu-items/${it.id}/edit` });
  assert.equal((await lookup("4006381333924", admin, `&itemId=${it.id}`)).body.usedBy, null);
});

test("duplicate with a BOOK of the shop (either ISBN form): a gentle warning, and saving is still allowed", async () => {
  const isbn = isbn13From(`9780${String(++seq).padStart(8, "0")}`);
  const { isbn13to10 } = require("../../src/lib/bookSources");
  await pool.query("INSERT INTO books (title, authors, isbn) VALUES ('Shop Copy Of Workbook', 'X', $1)", [isbn13to10(isbn)]);
  openLibrary.set(isbn, { title: "Workbook In Both" });
  const { body } = await lookup(isbn);
  assert.equal(body.bookInShop, 'This ISBN is already a book in the shop ("Shop Copy Of Workbook"). You can still save it here: a workbook with an ISBN stays an educational item, so make sure the same copies are not also counted as books.');
  const saved = await post("/admin/edu-items", { name: "Workbook In Both", price: "6", stock: "3", genreId: "", barcode: isbn });
  assert.match(decode(saved.text), /Added "Workbook In Both"\. This ISBN is already a book in the shop/);
  const row = (await pool.query("SELECT id, barcode FROM edu_items WHERE name = 'Workbook In Both'")).rows[0];
  assert.equal(row.barcode, isbn);
  assert.match(decode((await get(`/admin/edu-items/${row.id}/edit`)).text), /This ISBN is already a book in the shop \("Shop Copy Of Workbook"\)/);
  // A plain product code never gets the warning.
  assert.equal((await lookup("96385074")).body.bookInShop, null);
});

test("lookup is rate limited per admin (30 a minute) with a JSON sentence; another admin is not affected; admins only", async () => {
  const busy = await makeAdmin();
  for (let i = 0; i < 30; i++) assert.equal((await lookup("12345", busy)).status, 400);
  const over = await lookup("12345", busy);
  assert.equal(over.status, 429);
  assert.match(over.body.message, /Too many lookups/);
  assert.equal((await lookup("12345")).status, 400, "the other admin still gets answers");
  const member = await makeAdmin(false);
  const r = await get("/admin/edu-items/lookup?barcode=96385074", member);
  assert.notEqual(r.status, 200);
  assert.equal(outside.length, 0);
  const anon = await realFetch(`${server.base}/admin/edu-items/lookup?barcode=96385074`, { redirect: "manual" });
  assert.notEqual(anon.status, 200);
});

test("'Use this picture': the save fetches Open Library's exact-ISBN cover for the SAVED barcode; without the press, no picture", async () => {
  const isbn = fresh13();
  covers.add(isbn);
  await post("/admin/edu-items", { name: "No Press", price: "2", stock: "1", genreId: "", barcode: isbn });
  assert.equal((await pool.query("SELECT image_url FROM edu_items WHERE name = 'No Press'")).rows[0].image_url, null);
  const isbn2 = fresh13();
  covers.add(isbn2);
  await post("/admin/edu-items", { name: "With Press", price: "2", stock: "1", genreId: "", barcode: isbn2, useIsbnCover: "1" });
  const row = (await pool.query("SELECT id, image_url FROM edu_items WHERE name = 'With Press'")).rows[0];
  assert.match(row.image_url, /^\/img\/[0-9a-f]{64}\.jpg$/);
  assert.match((await auditOf("edu_item.add")).pop().detail, /with the Open Library picture/);
  // Pressed, but the code is not an ISBN: nothing is fetched, the item is saved with a note.
  const res = await post("/admin/edu-items", { name: "Not Isbn Press", price: "2", stock: "1", genreId: "", barcode: "96385074", useIsbnCover: "1" });
  assert.match(res.text, /The Open Library picture could not be fetched: add your own photo\./);
  assert.equal((await pool.query("SELECT image_url FROM edu_items WHERE name = 'Not Isbn Press'")).rows[0].image_url, null);
  assert.ok(!outside.some((u) => u.includes("96385074")));
});

// The Picture card (views/partials/picture_card.ejs, routes/admin/eduItems.js "/image/...") and "Use this picture" together.
async function multipart(p, fields, file, user = admin) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append("image", new Blob([file], { type: "image/jpeg" }), "own.jpg");
  const res = await realFetch(`${server.base}${p}`, { method: "POST", redirect: "manual", headers: header(user), body: form });
  return { status: res.status, location: res.headers.get("location") };
}

test("Picture card + 'Use this picture': an admin's own (edited) photo is never replaced by a plain Save; Open Library's picture only on the press; an own photo sent with the press wins", async () => {
  const isbn = fresh13();
  covers.add(isbn);
  const it = await item({ name: "Workbook With Own Photo", barcode: isbn });
  const own = await require("sharp")({ create: { width: 300, height: 200, channels: 3, background: "#c33" } }).jpeg().toBuffer();
  assert.equal((await multipart(`/admin/edu-items/${it.id}/image/replace`, {}, own)).location, `/admin/edu-items/${it.id}/edit?picture=replaced#picture`);
  await post(`/admin/edu-items/${it.id}/image/rotate`, { direction: "right" });
  const edited = (await pool.query("SELECT image_url FROM edu_items WHERE id = $1", [it.id])).rows[0].image_url;
  assert.match(edited, /^\/img\/[0-9a-f]{64}\.jpg$/);
  const fields = { name: "Workbook With Own Photo", price: "4", stock: "1", genreId: "", barcode: isbn };
  await post(`/admin/edu-items/${it.id}`, fields);
  assert.equal((await pool.query("SELECT image_url FROM edu_items WHERE id = $1", [it.id])).rows[0].image_url, edited, "a plain Save keeps the edited photo");
  assert.ok(!outside.some((u) => u.includes("covers.openlibrary.org")), "nothing fetched without the press");
  // The edit page still offers the lookup's picture and shows the card.
  const page = await get(`/admin/edu-items/${it.id}/edit`);
  assert.match(page.text, /id="picture"/);
  assert.equal((await lookup(isbn, admin, `&itemId=${it.id}`)).body.picture.startsWith("/img/"), true);
  // Own photo and the press in the same Save: the own photo wins.
  const own2 = await require("sharp")({ create: { width: 220, height: 220, channels: 3, background: "#33c" } }).jpeg().toBuffer();
  await multipart(`/admin/edu-items/${it.id}`, { ...fields, useIsbnCover: "1" }, own2);
  const second = (await pool.query("SELECT image_url FROM edu_items WHERE id = $1", [it.id])).rows[0].image_url;
  assert.notEqual(second, edited);
  assert.ok(!(await auditOf("edu_item.edit")).pop().detail.includes("Open Library"), "the own photo was used, not Open Library's");
  // The press alone replaces the picture with Open Library's (the explicit choice), audited as such.
  await post(`/admin/edu-items/${it.id}`, { ...fields, useIsbnCover: "1" });
  assert.match((await auditOf("edu_item.edit")).pop().detail, /new picture \(Open Library, exact ISBN\)/);
  assert.notEqual((await pool.query("SELECT image_url FROM edu_items WHERE id = $1", [it.id])).rows[0].image_url, second);
  // ...and the card can still remove it.
  await post(`/admin/edu-items/${it.id}/image/remove`, {});
  assert.equal((await pool.query("SELECT image_url FROM edu_items WHERE id = $1", [it.id])).rows[0].image_url, null);
});

// ---------- find by barcode ----------

test("find by barcode: to the edit page (any equivalent form); not found shows the sentence and the pre-filled add button", async () => {
  const it = await item({ name: "Findable", barcode: "036000291452" });
  const hit = await get("/admin/edu-items/find?barcode=0036000291452");
  assert.equal(hit.status, 303);
  assert.equal(hit.location, `/admin/edu-items/${it.id}/edit`);
  const miss = await get("/admin/edu-items/find?barcode=4006381333917");
  assert.equal(miss.status, 303);
  const list = await get(miss.location, admin, miss.cookie);
  assert.match(list.text, /No item with that barcode \(4006381333917\)\./);
  assert.match(list.text, /href="\/admin\/edu-items\/new\?barcode=4006381333917">Add a new item with this barcode</);
  const form = await get("/admin/edu-items/new?barcode=4006381333917");
  assert.match(form.text, /name="barcode"[^>]*value="4006381333917"/);
  assert.match(form.text, /data-auto-lookup/, "the add form looks it up at once");
  const bad = await get("/admin/edu-items/find?barcode=123");
  const badList = await get(bad.location, admin, bad.cookie);
  assert.match(badList.text, /this one has 3/);
  // A bad ?barcode= on the add form is simply not pre-filled.
  assert.match((await get("/admin/edu-items/new?barcode=%3Cscript%3E")).text, /name="barcode"[^>]*value=""/);
  const member = await makeAdmin(false);
  assert.notEqual((await get("/admin/edu-items/find?barcode=036000291452", member)).status, 303);
});

test("the list shows the Find by barcode box and each item's barcode", async () => {
  await item({ name: "Listed With Code", barcode: "4006381333900" });
  const list = await get("/admin/edu-items");
  assert.match(list.text, /<form class="edu-find" method="get" action="\/admin\/edu-items\/find"/);
  assert.match(list.text, /<label for="edu-find-barcode">Find by barcode<\/label>/);
  assert.match(list.text, /Listed With Code<\/a><br><span class="muted small">Barcode 4006381333900<\/span>/);
});

test("the list's Search by name box filters by any words of the name (any case) and escapes wildcards", async () => {
  await item({ name: "Colourful Phonics Cards" });
  await item({ name: "Maths Worksheet Pack" });
  const box = await get("/admin/edu-items");
  assert.match(box.text, /<label for="edu-search-name">Search by name<\/label>/);
  const hit = await get("/admin/edu-items?q=phonics%20CARDS");
  assert.match(hit.text, /Colourful Phonics Cards/);
  assert.doesNotMatch(hit.text, /Maths Worksheet Pack/);
  const none = await get("/admin/edu-items?q=zzzz");
  assert.match(none.text, /No item matches &#34;zzzz&#34;\./);
  const wild = await get("/admin/edu-items?q=%25");
  assert.doesNotMatch(wild.text, /Colourful Phonics Cards/, "a typed % is not a wildcard");
});

// ---------- the page's script, in headless Chrome ----------

test("in a browser: Enter looks up instead of saving; a typed Name and price are kept; an empty Name is filled; Use this picture saves it", { timeout: 60000 }, async (t) => {
  let browser;
  try {
    browser = await require("puppeteer").launch({ headless: true, args: ["--no-sandbox"] });
  } catch (err) {
    t.skip(`no headless Chrome available: ${String(err.message).split("\n")[0]}`);
    return;
  }
  try {
    const page = await browser.newPage();
    await page.setExtraHTTPHeaders(header(admin));
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    upc.set("882319024812", { title: "Learn to Read", brand: "Teacher Created Resources" });
    await page.goto(`${server.base}/admin/edu-items/new`);
    await page.type("#edu-name", "My own name");
    await page.type("#edu-price", "3,50");
    await page.type("#edu-barcode", "882319024812");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /Found at UPCitemdb/.test(document.querySelector("[data-edu-lookup-result]").textContent));
    assert.equal(page.url(), `${server.base}/admin/edu-items/new`, "Enter did not send the form");
    assert.equal(await page.$eval("#edu-name", (e) => e.value), "My own name", "the typed name is never overwritten");
    assert.equal(await page.$eval("#edu-price", (e) => e.value), "3,50");
    assert.equal(await page.$eval("#edu-stock", (e) => e.value), "0");
    const text = await page.$eval("[data-edu-lookup-result]", (e) => e.textContent);
    assert.match(text, /Suggested name: "Teacher Created Resources Learn to Read"\. Your Name was kept\./);
    assert.equal((await pool.query("SELECT 1 FROM edu_items WHERE name = 'My own name'")).rows.length, 0, "nothing saved");

    // An empty Name is filled in; the ISBN picture is offered and used only after the press.
    const isbn = fresh13();
    openLibrary.set(isbn, { title: "Phonics Workbook Level 1" });
    covers.add(isbn);
    await page.goto(`${server.base}/admin/edu-items/new`);
    await page.type("#edu-barcode", isbn);
    await page.click("[data-edu-lookup]");
    await page.waitForFunction(() => /Found at Open Library/.test(document.querySelector("[data-edu-lookup-result]").textContent));
    assert.equal(await page.$eval("#edu-name", (e) => e.value), "Phonics Workbook Level 1");
    assert.equal(await page.$eval("#edu-price", (e) => e.value), "", "the price is never filled");
    assert.equal(await page.$eval("[data-edu-use-cover]", (e) => e.value), "");
    await page.click(".edu-lookup-picture button");
    assert.equal(await page.$eval("[data-edu-use-cover]", (e) => e.value), "1");
    await page.type("#edu-price", "4");
    await Promise.all([page.waitForNavigation(), page.click("#edu-item-form button[type=submit]")]);
    const row = (await pool.query("SELECT barcode, image_url FROM edu_items WHERE name = 'Phonics Workbook Level 1'")).rows[0];
    assert.equal(row.barcode, isbn);
    assert.match(row.image_url, /^\/img\//);

    // Unavailable: one plain sentence, and the form still saves.
    upc.set("036000291452", 429);
    await page.goto(`${server.base}/admin/edu-items/new`);
    await page.type("#edu-barcode", "036000291452");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => /limiting requests from this site[\s\S]*type the details in\./.test(document.querySelector("[data-edu-lookup-result]").textContent));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});
