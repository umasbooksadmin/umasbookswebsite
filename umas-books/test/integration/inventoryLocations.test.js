// Inventory locations: a location is saved with each copy at intake (combo
// box = text input + <datalist> of locations already used), remembered
// through the scan flow, editable on the copy, filterable on the inventory
// list, and books can be moved in bulk by scanning ISBNs onto a destination.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken, followSeeOther } = require("../helpers/httpClient");

const PORT = 3740;
const PASSWORD = "Locations-Test-1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };

let app;
let pool;
let jar;
let adminId;

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const email = `loc-admin-${Date.now()}@example.test`;
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, is_member) VALUES ($1, $2, 'Loc Admin', true, true) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 10)]
  );
  adminId = rows[0].id;
  jar = makeCookieJar();
  const res = await post("/login", { email, password: PASSWORD });
  assert.equal(res.status, 302);
});

after(async () => {
  await pool.end();
  app.stop();
});

async function post(path, fields) {
  const token = await fetchCsrfToken(app.base, jar);
  const res = await fetch(`${app.base}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { ...FORM, cookie: jar.header(), "x-forwarded-for": "10.74.0.1" },
    body: new URLSearchParams({ ...fields, _csrf: token }).toString(),
  });
  jar.capture(res);
  return followSeeOther(res, { base: app.base, jar, headers: { "x-forwarded-for": "10.74.0.1" } });
}

async function get(path, useJar = jar) {
  const res = await fetch(`${app.base}${path}`, { redirect: "manual", headers: { cookie: useJar.header(), "x-forwarded-for": "10.74.0.1" } });
  return { res, text: await res.text() };
}

const unescapeHtml = (s) => s.replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

let n = 0;
const uniq = () => `${Date.now()}${++n}`;
// ISBN-13 style digits that cannot collide with another seeded book.
const isbn13 = () => "978" + String(Date.now()).slice(-7) + String(100 + (++n % 900));

async function seedBook(title, isbn) {
  const { rows } = await pool.query("INSERT INTO books (isbn, title) VALUES ($1, $2) RETURNING id", [isbn, title]);
  return rows[0].id;
}
// ageDays: bigger = older (created earlier), so "oldest first" is testable.
async function seedCopy(bookId, { status = "in_stock", location = null, ageDays = 0 } = {}) {
  const { rows } = await pool.query(
    `INSERT INTO book_copies (book_id, condition, price, status, location, created_at)
     VALUES ($1, 'very_good', 5, $2, $3, now() - ($4 || ' days')::interval) RETURNING id`,
    [bookId, status, location, String(ageDays)]
  );
  return rows[0].id;
}
const locationOf = async (copyId) => (await pool.query("SELECT location FROM book_copies WHERE id = $1", [copyId])).rows[0].location;

// One POST of the move form. `state` carries the hidden fields back, as the
// browser would on the next scan.
async function moveScan(state, scan, dest = state.dest) {
  const res = await post("/admin/inventory/move", {
    dest, scan, prevDest: state.dest || "", moved: String(state.moved || 0), log: state.log || "[]",
  });
  assert.equal(res.status, 200);
  const html = await res.text();
  const hidden = (name) => unescapeHtml((html.match(new RegExp(`name="${name}" value="([^"]*)"`)) || [])[1] || "");
  return { html, dest: hidden("prevDest"), moved: Number(hidden("moved")), log: hidden("log") };
}
const logTexts = (state) => JSON.parse(state.log).map((e) => e.t);

// ---------- intake ----------

test("intake saves the location as typed (spaces tidied, capitals kept) on the new copy", async () => {
  const title = `Intake Book ${uniq()}`;
  const res = await post("/admin/inventory", {
    title, description: "d", coverUrl: "https://example.test/c.jpg",
    status: "in_stock", condition: "very_good", price: "5", location: "  fiction   a1 ", fromScan: "1",
  });
  assert.equal(res.status, 302);
  // The scan flow comes back with the same location, ready for the next book.
  assert.match(res.headers.get("location"), /^\/admin\/inventory\/new\?saved=\d+&location=fiction\+a1&condition=very_good$/);
  const { rows } = await pool.query(
    "SELECT c.location FROM book_copies c JOIN books b ON b.id = c.book_id WHERE b.title = $1", [title]
  );
  assert.deepEqual(rows.map((r) => r.location), ["fiction a1"]);
});

test("intake without a location stores NULL", async () => {
  const title = `No Location ${uniq()}`;
  await post("/admin/inventory", { title, description: "d", coverUrl: "https://example.test/c.jpg", status: "in_stock", condition: "very_good", price: "5" });
  const { rows } = await pool.query(
    "SELECT c.location FROM book_copies c JOIN books b ON b.id = c.book_id WHERE b.title = $1", [title]
  );
  assert.equal(rows[0].location, null);
});

test("the Add book page pre-fills the carried location, starts at Store, and offers locations already used in the dropdown", async () => {
  const bookId = await seedBook(`Dropdown ${uniq()}`, isbn13());
  await seedCopy(bookId, { location: "ZZ-DROPDOWN" });
  const { text } = await get("/admin/inventory/new?location=poetry%20b2");
  assert.match(text, /id="location"[^>]*list="location-options"[^>]*value="poetry b2"/);
  assert.match(text, /<datalist id="location-options">[\s\S]*<option value="ZZ-DROPDOWN">[\s\S]*<\/datalist>/);
  assert.match(text, /<datalist id="location-options">[\s\S]*<option value="Store">[\s\S]*<\/datalist>/, "Store is offered even when no copy is there");
  assert.match(text, /src="\/inventory-location\.js(\?v=[0-9a-f]+)?"/);
  assert.match((await get("/admin/inventory/new")).text, /id="location"[^>]*value="Store"/);
});

test("the add-book form is pre-filled with the carried location and a typed new one joins the list", async () => {
  const { text } = await get("/admin/inventory/new?location=brand%20new%20shelf");
  assert.match(text, /name="location"[^>]*value="brand new shelf"/);
  const title = `Typed Location ${uniq()}`;
  await post("/admin/inventory", { title, description: "d", coverUrl: "https://example.test/c.jpg", status: "in_stock", condition: "very_good", price: "5", location: "brand new shelf" });
  const { text: after } = await get("/admin/inventory/new");
  assert.match(after, /<option value="brand new shelf">/);
});

test("copy edit form shows and saves the location, and a change is audited", async () => {
  const bookId = await seedBook(`Edit Loc ${uniq()}`, isbn13());
  const copyId = await seedCopy(bookId, { location: "OLD-1" });
  const { text } = await get(`/admin/inventory/${bookId}`);
  assert.match(text, new RegExp(`id="location-${copyId}"[^>]*value="OLD-1"`));
  assert.match(text, /Location OLD-1/);
  const res = await post(`/admin/inventory/${bookId}/copies/${copyId}`, { condition: "very_good", status: "in_stock", price: "5", location: " New-2 " });
  assert.equal(res.status, 302);
  assert.equal(await locationOf(copyId), "New-2");
  const { rows } = await pool.query("SELECT detail FROM admin_audit_log WHERE action = 'copy.move' AND target_id = $1", [copyId]);
  assert.deepEqual(rows.map((r) => r.detail), ["from OLD-1 to New-2"]);
  // Clearing it stores NULL.
  await post(`/admin/inventory/${bookId}/copies/${copyId}`, { condition: "very_good", status: "in_stock", price: "5", location: "" });
  assert.equal(await locationOf(copyId), null);
});

// ---------- move ----------

test("move page requires an admin", async () => {
  const anon = makeCookieJar();
  const { res } = await get("/admin/inventory/move", anon);
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /login/);
  const { res: page, text } = await get("/admin/inventory/move");
  assert.equal(page.status, 200);
  assert.match(text, /name="scan"[^>]*autofocus/);
  assert.match(text, /name="dest"[^>]*list="location-options"/);
});

test("each scan moves one copy, oldest first, and skips copies already there", async () => {
  const isbn = isbn13();
  const bookId = await seedBook(`Multi Copy ${uniq()}`, isbn);
  const oldest = await seedCopy(bookId, { location: "A1", ageDays: 30 });
  const middle = await seedCopy(bookId, { ageDays: 20 });
  const newest = await seedCopy(bookId, { location: "C3", ageDays: 10 });

  let s = await moveScan({}, isbn, "MV-1");
  assert.equal(await locationOf(oldest), "MV-1");
  assert.equal(await locationOf(middle), null);
  assert.equal(s.moved, 1);
  assert.match(logTexts(s)[0], /^Moved: Multi Copy \d+ \(was A1\) → MV-1$/);

  s = await moveScan(s, isbn);
  assert.equal(await locationOf(middle), "MV-1");
  assert.match(logTexts(s)[0], /\(was none\)/);
  assert.equal(await locationOf(newest), "C3");

  s = await moveScan(s, isbn);
  assert.equal(await locationOf(newest), "MV-1");
  assert.equal(s.moved, 3);

  s = await moveScan(s, isbn);
  assert.match(logTexts(s)[0], /^Already at MV-1: Multi Copy/);
  assert.equal(s.moved, 3, "an already-there scan is not counted");
  // Newest entry first, older entries kept.
  assert.equal(logTexts(s).length, 5, "1 info + 3 moved + 1 already");
});

test("ISBN typed with hyphens, and the other ISBN form of the same book, both match", async () => {
  const bookId = await seedBook(`Variant ${uniq()}`, "0143127551");
  const copyId = await seedCopy(bookId);
  const s = await moveScan({}, "978-0-14-312755-0", "VARIANTS");
  assert.equal(await locationOf(copyId), "VARIANTS");
  assert.equal(s.moved, 1);
});

test("unknown ISBN, non-barcode text and a missing destination are reported and move nothing", async () => {
  let s = await moveScan({}, "9780000000002", "MV-2");
  assert.match(logTexts(s)[0], /^Not in inventory: 9780000000002$/);
  s = await moveScan(s, "FICTION-A1");
  assert.match(logTexts(s)[0], /^Not a book barcode: FICTION-A1$/);
  const none = await moveScan({}, "9780000000002", "");
  assert.match(logTexts(none)[0], /Choose where the books are going first/);
  assert.equal(none.moved, 0);
});

test("sold, donated and in-cart copies are never moved, with a clear message", async () => {
  const soldIsbn = isbn13();
  const soldBook = await seedBook(`Only Sold ${uniq()}`, soldIsbn);
  const sold = await seedCopy(soldBook, { status: "sold", location: "S1" });
  const donated = await seedCopy(soldBook, { status: "donated", location: "S1" });
  const cartIsbn = isbn13();
  const cartBook = await seedBook(`In Cart ${uniq()}`, cartIsbn);
  const inCart = await seedCopy(cartBook, { status: "in_cart", location: "S1" });
  const reservedIsbn = isbn13();
  const reservedBook = await seedBook(`Reserved ${uniq()}`, reservedIsbn);
  const reserved = await seedCopy(reservedBook, { status: "reserved" });

  let s = await moveScan({}, soldIsbn, "MV-3");
  assert.match(logTexts(s)[0], /^Only sold or donated copies: Only Sold/);
  s = await moveScan(s, cartIsbn);
  assert.match(logTexts(s)[0], /^Skipped, in a customer's cart: In Cart/);
  s = await moveScan(s, reservedIsbn);
  assert.match(logTexts(s)[0], /^Moved: Reserved/);
  assert.equal(await locationOf(sold), "S1");
  assert.equal(await locationOf(donated), "S1");
  assert.equal(await locationOf(inCart), "S1");
  assert.equal(await locationOf(reserved), "MV-3");
  assert.equal(s.moved, 1);
});

test("changing the destination mid-way sends later scans to the new place", async () => {
  const a = isbn13();
  const b = isbn13();
  const bookA = await seedBook(`Switch A ${uniq()}`, a);
  const bookB = await seedBook(`Switch B ${uniq()}`, b);
  const copyA = await seedCopy(bookA);
  const copyB = await seedCopy(bookB);
  let s = await moveScan({}, a, "shelf one");
  s = await moveScan(s, b, "shelf two");
  assert.equal(await locationOf(copyA), "shelf one");
  assert.equal(await locationOf(copyB), "shelf two");
  assert.deepEqual(logTexts(s).filter((t) => t.startsWith("Moving books to")), ["Moving books to shelf two", "Moving books to shelf one"]);
  assert.match(s.html, /Moving books to shelf two/);
  assert.match(s.html, /name="scan"[^>]*autofocus/, "scan field is focused again after each scan");
  assert.match(s.html, /name="dest"[^>]*value="shelf two"/, "destination stays selected");
});

test("the running log keeps only the last 30 entries and ignores a tampered log field", async () => {
  let s = { dest: "log-cap", moved: 0, log: "[]" };
  for (let i = 0; i < 32; i++) s = await moveScan(s, "9780000000002");
  assert.equal(logTexts(s).length, 30);
  const bad = await moveScan({ dest: "log-cap", moved: 0, log: '[{"k":"evil","t":"<script>x</script>"},{"k":"moved","t":"ok"},5,"x"]' }, "");
  assert.deepEqual(logTexts(bad), ["ok"]);
});

test("each move writes one audit row with location codes only", async () => {
  const isbn = isbn13();
  const bookId = await seedBook(`Audited ${uniq()}`, isbn);
  const c1 = await seedCopy(bookId, { location: "FROM-1", ageDays: 5 });
  const c2 = await seedCopy(bookId, { ageDays: 1 });
  let s = await moveScan({}, isbn, "TO-9");
  s = await moveScan(s, isbn);
  await moveScan(s, isbn); // already there: no row
  const { rows } = await pool.query(
    "SELECT target_type, target_id, detail, actor_user_id FROM admin_audit_log WHERE action = 'copy.move' AND target_id = ANY($1) ORDER BY id",
    [[c1, c2]]
  );
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((r) => [r.target_type, r.target_id, r.detail, r.actor_user_id]), [
    ["book_copy", c1, "from FROM-1 to TO-9", adminId],
    ["book_copy", c2, "from none to TO-9", adminId],
  ]);
});

// ---------- visibility ----------

test("inventory list shows each book's in-stock locations and the book search has a Location filter", async () => {
  const mark = uniq();
  const inA = await seedBook(`Filter In ${mark}`, isbn13());
  await seedCopy(inA, { location: "FLT-B2" });
  await seedCopy(inA, { location: "FLT-A1" });
  await seedCopy(inA, { location: "FLT-GONE", status: "sold" });
  const elsewhere = await seedBook(`Filter Out ${mark}`, isbn13());
  await seedCopy(elsewhere, { location: "FLT-Z9" });

  const { text: all } = await get(`/admin/inventory?q=${mark}`);
  assert.match(all, /Filter In/);
  assert.match(all, /Location: FLT-A1, FLT-B2(?!, )/, "sold copies' locations are not listed");

  assert.match(all, /<select id="f-location" name="location">/, "the book search has a Location filter again (see inventorySearch)");

  const { text: filtered } = await get(`/admin/inventory?q=${mark}&location=flt-a1`);
  assert.match(filtered, /Filter In/);
  assert.doesNotMatch(filtered, /Filter Out/, "?location= narrows the list (case-insensitively)");
});

// ---------- capitals are kept, but never make a second place ----------

const optionValues = (html) => [...html.matchAll(/<option value="([^"]*)">/g)].map((m) => m[1]);
const oneEntryFor = (html, name) => optionValues(html.match(/<datalist id="location-options">[\s\S]*?<\/datalist>/)[0]).filter((v) => v.toLowerCase() === name.toLowerCase());

test("Store is saved as 'Store', not 'STORE', and typing 'store' later is the same place in the list", async () => {
  const t1 = `Cap Store ${uniq()}`;
  const t2 = `Cap Store lower ${uniq()}`;
  const base = { description: "d", coverUrl: "https://example.test/c.jpg", status: "in_stock", condition: "very_good", price: "5" };
  await post("/admin/inventory", { ...base, title: t1, location: "Capital Test Shelf" });
  await post("/admin/inventory", { ...base, title: t2, location: "capital test shelf" });
  const { rows } = await pool.query("SELECT b.title, c.location FROM book_copies c JOIN books b ON b.id = c.book_id WHERE b.title = ANY($1) ORDER BY b.title", [[t1, t2]]);
  assert.deepEqual(rows.map((r) => r.location).sort(), ["Capital Test Shelf", "capital test shelf"], "each kept as typed");
  const newPage = (await get("/admin/inventory/new")).text;
  assert.deepEqual(oneEntryFor(newPage, "capital test shelf").length, 1, "one entry in the Add book list");
  assert.equal(oneEntryFor((await get("/admin/inventory/move")).text, "capital test shelf").length, 1, "one entry on Move books");
  // The offered default is Store, and a stored 'Store' / 'STORE' mix does not list it twice.
  const bookId = await seedBook(`Store Mix ${uniq()}`, isbn13());
  await seedCopy(bookId, { location: "Store" });
  await seedCopy(bookId, { location: "STORE" });
  await seedCopy(bookId, { location: "store" });
  const page = (await get("/admin/inventory/new")).text;
  assert.equal(oneEntryFor(page, "store").length, 1);
});

test("the list shows the most common spelling of a place", async () => {
  const bookId = await seedBook(`Spelling ${uniq()}`, isbn13());
  await seedCopy(bookId, { location: "Spell-Test Nook" });
  await seedCopy(bookId, { location: "SPELL-TEST NOOK" });
  await seedCopy(bookId, { location: "SPELL-TEST NOOK" });
  const { text } = await get("/admin/inventory/move");
  assert.deepEqual(oneEntryFor(text, "spell-test nook"), ["SPELL-TEST NOOK"]);
  assert.match((await get(`/admin/inventory/${bookId}`)).text, /Location Spell-Test Nook/, "each copy shows its own spelling");
});

test("Move books treats a change of capitals only as a real move (STORE -> Store), and the list then shows 'Store' only", async () => {
  const isbn = isbn13();
  const bookId = await seedBook(`Rename ${uniq()}`, isbn);
  const c1 = await seedCopy(bookId, { location: "Rename-Test STORE", ageDays: 2 });
  const c2 = await seedCopy(bookId, { location: "Rename-Test STORE", ageDays: 1 });
  let s = await moveScan({}, isbn, "Rename-Test Store");
  assert.match(logTexts(s)[0], /^Moved: Rename \d+ \(was Rename-Test STORE\) → Rename-Test Store$/);
  assert.equal(await locationOf(c1), "Rename-Test Store");
  s = await moveScan(s, isbn);
  assert.equal(await locationOf(c2), "Rename-Test Store");
  assert.equal(s.moved, 2);
  s = await moveScan(s, isbn);
  assert.match(logTexts(s)[0], /^Already at Rename-Test Store:/, "same capitals again: nothing to do");
  const { rows } = await pool.query("SELECT detail FROM admin_audit_log WHERE action = 'copy.move' AND target_id = ANY($1) ORDER BY id", [[c1, c2]]);
  assert.deepEqual(rows.map((r) => r.detail), ["from Rename-Test STORE to Rename-Test Store", "from Rename-Test STORE to Rename-Test Store"]);
  const moveEntries = oneEntryFor((await get("/admin/inventory/move")).text, "rename-test store");
  assert.deepEqual(moveEntries, ["Rename-Test Store"], "the list shows the new spelling only");
});

test("the inventory list shows each place once per book, whatever its capitals", async () => {
  const mark = uniq();
  const bookId = await seedBook(`Cap List ${mark}`, isbn13());
  await seedCopy(bookId, { location: "Cap-Shelf" });
  await seedCopy(bookId, { location: "CAP-SHELF" });
  await seedCopy(bookId, { location: "Zed Shelf" });
  const { text } = await get(`/admin/inventory?q=${mark}`);
  assert.match(text, /Location: Cap-Shelf, Zed Shelf(?!, )|Location: CAP-SHELF, Zed Shelf(?!, )/);
  assert.doesNotMatch(text, /Cap-Shelf, CAP-SHELF|CAP-SHELF, Cap-Shelf/);
});

test("the inventory report groups locations case-insensitively", async () => {
  const bookId = await seedBook(`Report Cap ${uniq()}`, isbn13());
  await seedCopy(bookId, { location: "Report-Cap Bay" });
  await seedCopy(bookId, { location: "REPORT-CAP BAY" });
  const reports = require("../../src/lib/reports");
  const inv = await reports.REPORTS.find((r) => r.slug === "inventory").run(pool);
  const rows = inv.sections.find((x) => x.key === "location").rows.filter((r) => String(r.label).toLowerCase() === "report-cap bay");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].total_count, 2);
});
