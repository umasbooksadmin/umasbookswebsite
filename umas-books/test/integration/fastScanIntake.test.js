// The one-screen "Add a book" page used to scan many books in a row:
// GET /admin/inventory/lookup (JSON, src/routes/admin/inventoryLookup.js), the
// defaults of the form (Store, Donation, the binding of the last book), the
// redirect after Save, and the markup the script and the phone depend on.
// Outbound HTTP is stubbed at global.fetch: Open Library answers from a table,
// anything else is refused.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const multer = require("multer");
const { prepareDatabase, buildApp, listen } = require("../helpers/inProcessApp");

const db = prepareDatabase("fast_scan_intake", { isolated: true });
const { pool } = require("../../src/db");
const { BINDINGS } = require("../../src/lib/inventory");
const { requireAdmin } = require("../../src/middleware/auth");
const coverStore = require("../../src/lib/coverStore");
coverStore.setLookupForTests(async () => [{ address: "93.184.216.34", family: 4 }]);

const realFetch = global.fetch;
const openLibrary = new Map();
const olCalls = [];
global.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("http://127.0.0.1:")) return realFetch(url, init);
  if (u.startsWith("https://openlibrary.org/")) {
    olCalls.push(u);
    const m = u.match(/\/isbn\/([0-9X]+)\.json$/);
    if (m) {
      const data = openLibrary.get(m[1]);
      return new Response(JSON.stringify(data ? { records: { r: { isbns: [m[1]], data } } } : {}), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ docs: [] }), { status: 200, headers: { "content-type": "application/json" } });
  }
  throw new Error(`test refused a real outbound request to ${u}`);
};

let server;
let adminId;
before(async () => {
  db.create();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
  const gate = express.Router();
  gate.use("/admin/inventory", requireAdmin, upload.fields([{ name: "photo", maxCount: 1 }, { name: "coverPhoto", maxCount: 1 }]));
  server = await listen(buildApp([gate, require("../../src/routes/admin/inventoryLookup"), require("../../src/routes/admin/inventory")]));
  const { rows } = await pool.query("INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ($1, 'x', 'Scan Admin', true) RETURNING id", [`scan-admin-${Date.now()}@example.test`]);
  adminId = rows[0].id;
});
after(async () => {
  global.fetch = realFetch;
  await server.close();
  await pool.end();
  db.drop();
});
beforeEach(() => { openLibrary.clear(); olCalls.length = 0; });

let seq = 0;
const uniq = () => `${Date.now()}x${++seq}`;
const isbn13 = () => `979${String(Date.now()).slice(-7)}${String(++seq).padStart(3, "0")}`;
const adminHeader = () => ({ "x-test-user": JSON.stringify({ id: adminId, email: "a@example.test", displayName: "Admin", isAdmin: true }) });
const memberHeader = () => ({ "x-test-user": JSON.stringify({ id: adminId, email: "m@example.test", displayName: "M", isAdmin: false, isMember: true }) });

let cookie = ""; // the session cookie: the lookup page is shown once from the session after a redirect
async function request(path, { method = "GET", form, headers = adminHeader() } = {}) {
  const h = { ...headers };
  if (cookie) h.cookie = cookie;
  let body;
  if (form) { body = new URLSearchParams(form).toString(); h["content-type"] = "application/x-www-form-urlencoded"; }
  const res = await realFetch(`${server.base}${path}`, { method, redirect: "manual", headers: h, body, signal: AbortSignal.timeout(15000) });
  const set = res.headers.getSetCookie().map((c) => c.split(";")[0]);
  if (set.length) cookie = set.join("; ");
  return { res, text: await res.text(), status: res.status, location: res.headers.get("location") };
}
const get = (p, o) => request(p, o);
const post = (p, o) => request(p, { ...o, method: "POST" });
const asJson = { accept: "application/json" };

const copyBody = (title, extra = {}) => ({ title, description: "d", descriptionFr: "d", coverUrl: "https://example.test/c.jpg", status: "in_stock", condition: "very_good", price: "5", ...extra });

// ------------------------------------------------------------ the JSON lookup

test("lookup: guests are sent to login and non-admins get 403", async () => {
  const anon = await get("/admin/inventory/lookup?isbn=9780143127550", { headers: {} });
  assert.equal(anon.status, 302);
  assert.equal(anon.location, "/login");
  assert.equal((await get("/admin/inventory/lookup?isbn=9780143127550", { headers: memberHeader() })).status, 403);
  assert.equal(olCalls.length, 0, "nothing was looked up for them");
});

test("lookup: the route itself is admin only (mounted alone, without the gate in front of it)", async () => {
  const alone = await listen(buildApp([require("../../src/routes/admin/inventoryLookup")]));
  try {
    const path = "/admin/inventory/lookup?isbn=9780143127550";
    const anon = await realFetch(`${alone.base}${path}`, { redirect: "manual" });
    assert.equal(anon.status, 302);
    const member = await realFetch(`${alone.base}${path}`, { redirect: "manual", headers: memberHeader() });
    assert.equal(member.status, 403);
  } finally {
    await alone.close();
  }
  assert.equal(olCalls.length, 0);
});

test("GET /admin/inventory/lookup without ?isbn= is the no-JavaScript result page, not the JSON endpoint (both live at that address)", async () => {
  const r = await get("/admin/inventory/lookup");
  assert.equal(r.status, 302);
  assert.equal(r.location, "/admin/inventory/scan");
  assert.match((await get("/admin/inventory/lookup?isbn=9780143127550", { headers: { ...adminHeader(), ...asJson } })).res.headers.get("content-type"), /json/);
});

test("lookup: an ISBN that is not 10 or 13 digits is refused with 400 and no catalog call", async () => {
  for (const bad of ["", "123", "97801431275", "abcdefghijklm", "978014312755012"]) {
    const r = await get(`/admin/inventory/lookup?isbn=${encodeURIComponent(bad)}`);
    assert.equal(r.status, 400, `isbn ${JSON.stringify(bad)}`);
    assert.match(JSON.parse(r.text).error, /10 or 13 digits/);
  }
  assert.equal(olCalls.length, 0);
});

test("lookup: a catalog hit answers with the book, the binding hint and a price suggestion (hyphens are ignored)", async () => {
  const isbn = isbn13();
  openLibrary.set(isbn, { title: "Lookup Title", authors: [{ name: "Ann Author" }], publishers: [{ name: "Pub House" }], publish_date: "2011", subjects: [{ name: "Fiction" }], physical_format: "Paperback" });
  const hyphenated = `${isbn.slice(0, 3)}-${isbn.slice(3)}`;
  const r = await get(`/admin/inventory/lookup?isbn=${hyphenated}`);
  assert.equal(r.status, 200);
  assert.match(r.res.headers.get("content-type"), /json/);
  assert.equal(r.res.headers.get("cache-control"), "no-store");
  const j = JSON.parse(r.text);
  assert.equal(j.ok, true);
  assert.equal(j.isbn, isbn);
  assert.equal(j.found, true);
  assert.equal(j.book.title, "Lookup Title");
  assert.equal(j.book.author, "Ann Author");
  assert.equal(j.book.publisher, "Pub House");
  assert.equal(j.book.publishedYear, 2011);
  assert.deepEqual(j.bindingHint, { key: "trade", label: "Trade" });
  assert.equal("binding" in j.book, false, "the binding travels only as a hint");
  assert.equal(j.existing, null);
  assert.ok(j.suggestion && "price" in j.suggestion && "needsReview" in j.suggestion, "price suggestion data");
});

test("lookup: an unknown ISBN is found:false with no book (and still answers 200)", async () => {
  const r = await get(`/admin/inventory/lookup?isbn=${isbn13()}`);
  assert.equal(r.status, 200);
  const j = JSON.parse(r.text);
  assert.equal(j.ok, true);
  assert.equal(j.found, false);
  assert.equal(j.book, null);
  assert.equal(j.bindingHint, null);
  assert.equal(j.existing, null);
});

test("lookup: a book the shop already has comes back with its copy count (sold copies are not counted)", async () => {
  const isbn = isbn13();
  const { rows } = await pool.query("INSERT INTO books (isbn, title, authors) VALUES ($1, 'Shop Title', 'Shop Author') RETURNING id", [isbn]);
  for (const status of ["in_stock", "in_stock", "reserved", "sold"]) {
    await pool.query("INSERT INTO book_copies (book_id, status, condition, price) VALUES ($1, $2, 'very_good', 5)", [rows[0].id, status]);
  }
  const j = JSON.parse((await get(`/admin/inventory/lookup?isbn=${isbn}`)).text);
  assert.equal(j.found, true);
  assert.equal(j.book.title, "Shop Title", "the shop's own record wins over the catalog");
  assert.deepEqual(j.existing, { bookId: rows[0].id, title: "Shop Title", copies: 3 });
});

test("lookup: rate limited per admin (429 JSON after 120 a minute)", async () => {
  let last;
  for (let i = 0; i < 125; i++) {
    last = await get("/admin/inventory/lookup?isbn=1");
    if (last.status === 429) break;
  }
  assert.equal(last.status, 429);
  assert.match(JSON.parse(last.text).error, /Too many lookups/);
});

// --------------------------------------------------------- defaults of the form

test("a fresh Add book page: ISBN first and focused, Location Store, Source Donation, Store offered in the list", async () => {
  const { text, status } = await get("/admin/inventory/new");
  assert.equal(status, 200);
  const isbnPos = text.indexOf('id="isbn"');
  assert.ok(isbnPos > 0 && isbnPos < text.indexOf('id="title"'), "ISBN comes before the title");
  const isbnTag = text.match(/<input id="isbn"[^>]*>/)[0];
  assert.match(isbnTag, / autofocus/);
  assert.match(isbnTag, /inputmode="numeric"/);
  assert.match(isbnTag, /autocomplete="off"/);
  assert.match(isbnTag, /autocapitalize="off"/);
  assert.match(text, /id="location"[^>]*value="Store"/);
  assert.match(text, /<option value="donation" selected>Donation<\/option>/);
  assert.match(text, /<datalist id="location-options">[\s\S]*<option value="Store">[\s\S]*<\/datalist>/);
  assert.match(text, /src="\/scan-intake\.js"/);
  assert.match(text, /href="\/scan-intake\.css"/);
  assert.match(text, /role="status"[^>]*id="scan-status"|id="scan-status"[^>]*role="status"/);
});

test("no field of the Add book page is readonly, disabled or inputmode none, and the price input is decimal", async () => {
  const { text } = await get("/admin/inventory/new");
  const fields = text.match(/<(input|select|textarea)\b[^>]*>/g);
  assert.ok(fields.length > 15);
  for (const f of fields) {
    assert.doesNotMatch(f, /\breadonly\b/, f);
    assert.doesNotMatch(f, /\bdisabled\b/, f);
    assert.doesNotMatch(f, /inputmode="none"/, f);
  }
  assert.match(text.match(/<input id="price"[^>]*>/)[0], /inputmode="decimal"/);
  assert.doesNotMatch(text, /user-scalable|maximum-scale/);
});

test("a location and a source in the query (the last entry) replace Store and Donation; without them the browser's memory may", async () => {
  const { text } = await get("/admin/inventory/new?location=poetry%20b2&source=lot");
  assert.match(text, /id="location"[^>]*value="poetry b2"/, "capitals as typed");
  assert.doesNotMatch(text, /id="location"[^>]*data-location-default/, "a queried location is not replaced by the remembered one");
  assert.match(text, /<option value="lot" selected>/, "the source of the last book");
  assert.match(text, /data-source-set="1"/);
  const { text: plain } = await get("/admin/inventory/new");
  assert.match(plain, /id="location"[^>]*data-location-default/, "the default may be replaced by the location remembered in the browser");
  assert.match(plain, /data-source-set=""/, "nothing carried: the remembered source may be applied by the page script");
  assert.match(plain, /data-binding-set=""/);
  assert.match(plain, /data-condition-set=""/);
});

test("the binding in the query is the selected one; with none (first ever use) the last option of the list is", async () => {
  const sel = (t) => (t.match(/<select id="binding"[\s\S]*?<\/select>/) || [""])[0];
  const lastKey = BINDINGS[BINDINGS.length - 1].value;
  assert.match(sel((await get("/admin/inventory/new?binding=hardcover")).text), /<option value="hardcover" selected>/);
  assert.match(sel((await get("/admin/inventory/new?binding=nonsense")).text), new RegExp(`<option value="${lastKey}" selected>`));
  const plain = sel((await get("/admin/inventory/new")).text);
  assert.match(plain, new RegExp(`<option value="${lastKey}" selected>`));
  assert.equal((plain.match(/ selected/g) || []).length, 1);
});

test("the old scan page has no Current location or Source controls any more, and the book form owns them", async () => {
  const { text } = await get("/admin/inventory/scan");
  assert.doesNotMatch(text, /Current location/);
  assert.doesNotMatch(text, /Source of these books/);
  assert.doesNotMatch(text, /id="location"|id="source"/);
  assert.match(text, /id="isbn"/);
  const posted = await post("/admin/inventory/lookup", { form: { isbn: isbn13() } });
  assert.equal(posted.status, 303, "Post/Redirect/Get");
  assert.equal(posted.location, "/admin/inventory/lookup");
  const lookup = await get(posted.location);
  assert.equal(lookup.status, 200);
  assert.match(lookup.text, /id="location"[^>]*value="Store"/, "a lookup page also starts at Store");
  assert.match(lookup.text, /<option value="donation" selected>/);
});

test("Store is a location like any other: kept as typed on save, listed once on the Add book and Move books pages, whatever the capitals", async () => {
  const title = `Store Book ${uniq()}`;
  const r = await post("/admin/inventory", { form: copyBody(title, { location: "store", fast: "0" }) });
  assert.equal(r.status, 302);
  const { rows } = await pool.query("SELECT c.location FROM book_copies c JOIN books b ON b.id = c.book_id WHERE b.title = $1", [title]);
  assert.deepEqual(rows.map((x) => x.location), ["store"]);
  for (const path of ["/admin/inventory/move", "/admin/inventory/new"]) {
    const opts = [...(await get(path)).text.matchAll(/<option value="([^"]*)">/g)].map((m) => m[1]).filter((v) => v.toLowerCase() === "store");
    assert.equal(opts.length, 1, `${path}: one entry for Store, not one per spelling (${opts})`);
  }
  assert.match((await get(`/admin/inventory?q=${encodeURIComponent(title)}&location=store`)).text, new RegExp(title));
});

// ------------------------------------------------------- redirect after Save

test("Save and add another (no JavaScript): redirects back to a fresh form with a saved flag that carries location, source, binding and condition", async () => {
  const title = `Loop ${uniq()}`;
  const r = await post("/admin/inventory", { form: copyBody(title, { fast: "1", location: "fiction a1", binding: "hardcover", condition: "good", source: "lot" }) });
  assert.equal(r.status, 302);
  const u = new URL(r.location, "http://x");
  assert.equal(u.pathname, "/admin/inventory/new");
  assert.match(u.searchParams.get("saved"), /^\d+$/);
  assert.equal(u.searchParams.get("location"), "fiction a1");
  assert.equal(u.searchParams.get("binding"), "hardcover");
  assert.equal(u.searchParams.get("condition"), "good");
  assert.equal(u.searchParams.get("source"), "lot");

  const page = (await get(r.location)).text;
  assert.match(page, /id="scan-saved"[^>]*role="status"/, "the message is announced");
  assert.match(page, new RegExp(`Saved: <strong>${title}</strong>`));
  assert.doesNotMatch(page, /Print label/);
  assert.doesNotMatch(page.match(/<div class="scan-saved"[\s\S]*?<\/div>/)[0], /autofocus/, "the message does not take the focus");
  assert.match(page.match(/<input id="isbn"[^>]*>/)[0], /autofocus/, "the ISBN box takes it");
  assert.match(page.match(/<input id="isbn"[^>]*>/)[0], /value=""/, "and is empty");
  assert.match(page, /id="location"[^>]*value="fiction a1"/);
  assert.match(page, /<option value="hardcover" selected>/);
  assert.match(page, /<option value="good" selected>/);
  assert.match(page, /<option value="lot" selected>/, "the source of the last book is kept");
  // A reload of the same address keeps the remembered values.
  const again = (await get(r.location)).text;
  assert.match(again, /<option value="hardcover" selected>/);
});

test("the saved flag with an id that does not exist, or is not a number, shows no message", async () => {
  for (const q of ["saved=999999999", "saved=abc", "saved=1;drop"]) {
    const { text } = await get(`/admin/inventory/new?${q}`);
    assert.match(text, /id="scan-saved"[^>]*hidden/, q);
  }
});

test("Save and add another by fetch (Accept: json) answers JSON; a missing title is a 422 JSON error", async () => {
  const title = `Json ${uniq()}`;
  const ok = await post("/admin/inventory", { headers: { ...adminHeader(), ...asJson }, form: copyBody(title, { fast: "1" }) });
  assert.equal(ok.status, 200);
  const j = JSON.parse(ok.text);
  assert.equal(j.ok, true);
  assert.equal(j.title, title);
  assert.equal(j.labelUrl, undefined);
  const bad = await post("/admin/inventory", { headers: { ...adminHeader(), ...asJson }, form: copyBody("", { fast: "1" }) });
  assert.equal(bad.status, 422);
  assert.deepEqual(JSON.parse(bad.text), { ok: false, error: "Title is required." });
  const badPrice = await post("/admin/inventory", { headers: { ...adminHeader(), ...asJson }, form: copyBody(`Bad ${uniq()}`, { fast: "1", price: "abc" }) });
  assert.equal(badPrice.status, 422);
  assert.equal((await pool.query("SELECT 1 FROM books WHERE title LIKE 'Bad %' AND created_by = $1", [adminId])).rowCount, 0, "nothing was saved");
});

test("Save book (fast=0) still opens the book; the old scan flow (fromScan) now returns to the fast page", async () => {
  const t1 = `Open ${uniq()}`;
  const r1 = await post("/admin/inventory", { form: copyBody(t1, { fast: "0" }) });
  assert.match(r1.location, /^\/admin\/inventory\/\d+$/);
  const t2 = `FromScan ${uniq()}`;
  const r2 = await post("/admin/inventory", { form: copyBody(t2, { fromScan: "1", fast: "1", location: "kids c3" }) });
  assert.match(r2.location, /^\/admin\/inventory\/new\?saved=\d+&location=kids\+c3/);
});

test("the old no-JavaScript Look up button posts to the lookup page and the form comes back filled, keeping Store and Donation", async () => {
  const isbn = isbn13();
  openLibrary.set(isbn, { title: "Posted Lookup", authors: [{ name: "Pat" }] });
  const posted = await post("/admin/inventory/lookup", { form: { isbn, location: "store", source: "donation" } });
  assert.equal(posted.status, 303);
  const r = await get(posted.location); // the result is carried once in the session
  assert.equal(r.status, 200);
  assert.equal((await get(posted.location)).status, 302, "shown once: a reload goes back to the scan page");
  assert.match(r.text, /name="title"[^>]*value="Posted Lookup"/);
  assert.match(r.text, /id="location"[^>]*value="store"/, "kept as typed");
});

// ------------------------------------------- a new location, and the last values used

test("a location typed for the first time is saved with the book, offered in the list, and is the next form's starting location (a fresh browser too)", async () => {
  const title = `New Place ${uniq()}`;
  const r = await post("/admin/inventory", { headers: { ...adminHeader(), ...asJson }, form: copyBody(title, { fast: "1", location: "  brand new  shelf-9 ", binding: "hardcover", condition: "good", source: "lot" }) });
  assert.equal(r.status, 200, r.text);
  const { rows } = await pool.query("SELECT c.location FROM book_copies c JOIN books b ON b.id = c.book_id WHERE b.title = $1", [title]);
  assert.deepEqual(rows.map((x) => x.location), ["brand new shelf-9"], "saved as typed (spaces tidied, capitals kept)");
  // A visit with no query and nothing in the browser's memory: the server starts the form at the last values used.
  const { text } = await get("/admin/inventory/new");
  assert.match(text, /id="location"[^>]*value="brand new shelf-9"/, "not Store");
  assert.match(text, /<datalist id="location-options">[\s\S]*<option value="brand new shelf-9">[\s\S]*<\/datalist>/, "in the list afterwards");
  assert.match(text, /<option value="lot" selected>/);
  assert.match(text, /<option value="hardcover" selected>/);
  assert.match(text.match(/<select id="condition"[\s\S]*?<\/select>/)[0], /<option value="good" selected>/);
  // The page script may still replace these with the browser's own memory; they are not "carried by the address".
  assert.match(text, /data-location-default/);
  assert.match(text, /data-binding-set=""/);
  // A query still wins over the last values.
  assert.match((await get("/admin/inventory/new?location=other%20place")).text, /id="location"[^>]*value="other place"/);
});

test("another admin's last copy does not set this admin's starting values", async () => {
  const { rows } = await pool.query("INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ($1, 'x', 'Other Admin', true) RETURNING id", [`other-admin-${Date.now()}@example.test`]);
  const other = { "x-test-user": JSON.stringify({ id: rows[0].id, email: "o@example.test", displayName: "Other", isAdmin: true }) };
  const { text } = await get("/admin/inventory/new", { headers: other });
  assert.match(text, /id="location"[^>]*value="Store"/);
  assert.match(text, /<option value="donation" selected>/);
});
