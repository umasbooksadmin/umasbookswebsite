// lib/inventoryIntake.js and lib/inventoryCopies.js on their own (no HTTP), against a real database:
// the form reading is pure, the save runs its real SQL. The same behaviour through the route is pinned
// by intakeGolden.test.js; the idempotency token through HTTP by intakeIdempotency.test.js.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { prepareDatabase } = require("../helpers/inProcessApp");
const { isbn13From } = require("../helpers/isbn");

const db = prepareDatabase("intake_lib", { isolated: true });
const { pool } = require("../../src/db");
const intake = require("../../src/lib/inventoryIntake");
const copies = require("../../src/lib/inventoryCopies");
const { settled } = require("../../src/lib/afterResponse");
const realFetch = global.fetch;

let adminId;
before(async () => {
  global.fetch = async () => { throw new Error("no outbound requests in this test"); };
  db.create();
  const { rows } = await pool.query("INSERT INTO users (email, password_hash, display_name, is_admin) VALUES ('lib-admin@example.test', 'x', 'Lib Admin', true) RETURNING id");
  adminId = rows[0].id;
});
after(async () => { global.fetch = realFetch; await settled(); await pool.end(); db.drop(); });

let seq = 0;
const isbn = () => isbn13From(`978${String(8000000 + (++seq)).padStart(9, "0")}`);
const tok = () => `lib-token-${String(++seq).padStart(4, "0")}-abcdefghij`;
const form = (over = {}) => ({ title: `Lib book ${seq + 1}`, author: "A", description: "d", descriptionFr: "d", coverUrl: "/img/0123456789abcdef.jpg", binding: "trade", condition: "very_good", price: "5", location: "Store", source: "donation", intakeToken: tok(), ...over });
const audits = [];
const ctx = () => ({ userId: adminId, audit: async (e) => { audits.push(e); } });
const prepared = async (body, files) => {
  const parsed = intake.parseIntakeInput(body, files);
  assert.equal(parsed.ok, true, JSON.stringify(parsed));
  const p = await intake.prepareIntake(pool, parsed.value);
  assert.equal(p.ok, true, JSON.stringify(p));
  return p.value;
};

// ---------- parseIntakeInput ----------

test("parseIntakeInput: a plain form is read and normalised", () => {
  const r = intake.parseIntakeInput(form({
    title: "  The Title  ", author: " ", isbn: "978-0-14-312755-0", location: "  Back   room\t", source: "nonsense", status: "weird", condition: "bogus",
    publishedYear: "1999", acquisitionCost: "2.5", acquiredAt: "2024-03-09", copyNotes: " n ", genre: "Fiction", genreFr: "Roman", descriptionFr: "Texte",
  }));
  assert.equal(r.ok, true);
  const v = r.value;
  assert.equal(v.title, "The Title");
  assert.equal(v.author, null);
  assert.equal(v.isbn, "9780143127550");
  assert.equal(v.location, "Back room");
  assert.equal(v.source, null);
  assert.equal(v.status, "in_stock");
  assert.equal(v.condition, "very_good");
  assert.equal(v.publishedYear, 1999);
  assert.equal(v.costCheck.value, 2.5);
  assert.equal(v.acquiredCheck.value, "2024-03-09");
  assert.equal(v.notes, "n");
  assert.equal("genreFr" in v || "descriptionFr" in v, false, "no French genre or description is read or made (books have none)");
});

test("parseIntakeInput: a missing title is refused with the form still returned", () => {
  const r = intake.parseIntakeInput(form({ title: "   ", publishedYear: "1999", price: "x" }));
  assert.deepEqual({ ok: r.ok, field: r.field, message: r.message }, { ok: false, field: "title", message: "Title is required." });
  assert.equal(r.value.publishedYear, 1999);
  assert.equal(r.value.typedPricing.price, "x");
  assert.equal(intake.parseIntakeInput({}).field, "title");
});

test("parseIntakeInput: numbers that are wrong do not refuse here (prepareIntake orders the refusals)", () => {
  const r = intake.parseIntakeInput(form({ publishedYear: "abc", acquisitionCost: "-1", acquiredAt: "2020-13-45" }));
  assert.equal(r.ok, true);
  assert.equal(r.value.publishedYear, null);
  assert.ok(r.value.yearCheck.error && r.value.costCheck.error && r.value.acquiredCheck.error);
  assert.equal(r.value.raw.publishedYear, "abc");
});

test("parseIntakeInput: the token counts only when well formed; a cover photo is picked from the files", () => {
  assert.equal(intake.parseIntakeInput(form({ intakeToken: "short" })).value.token, null);
  assert.equal(intake.parseIntakeInput(form({ intakeToken: undefined })).value.token, null);
  const wellFormed = "x".repeat(20); // 16 to 64 letters, digits, - or _
  assert.equal(intake.parseIntakeInput(form({ intakeToken: wellFormed })).value.token, wellFormed);
  const file = { buffer: Buffer.from("x") };
  assert.equal(intake.parseIntakeInput(form(), { coverPhoto: [file] }).value.coverPhoto, file);
  assert.equal(intake.parseIntakeInput(form(), {}).value.coverPhoto, null);
  assert.equal(intake.parseIntakeInput(form(), undefined).value.coverPhoto, null);
});

test("parseIntakeInput: it does not touch the body and gives the same answer twice", () => {
  const body = form({ title: "Same", price: "7", priceLevel: "custom" });
  const copy = JSON.stringify(body);
  const a = intake.parseIntakeInput(body);
  const b = intake.parseIntakeInput(body);
  assert.equal(JSON.stringify(body), copy);
  assert.deepEqual(a, b);
  assert.deepEqual(a.value.priceForm, { priceLevel: "custom", price: "7", suggestedPrice: undefined, suggestedLevel: undefined });
});

// ---------- prepareIntake ----------

test("prepareIntake: used copies take the typed price; New books follow the fixed-price rule", async () => {
  const used = await prepared(form({ price: "6.5" }));
  assert.equal(used.pricing.price, 6.5);
  const fresh = await prepared(form({ condition: "new", price: "", publisherPrice: "12.90", publishedYear: String(new Date().getFullYear()) }));
  assert.deepEqual({ price: fresh.pricing.price, pub: fresh.pricing.publisherPrice }, { price: 12.9, pub: 12.9 });
  const low = await intake.prepareIntake(pool, intake.parseIntakeInput(form({ condition: "new", price: "9", publisherPrice: "12.90", publishedYear: String(new Date().getFullYear()) })).value);
  assert.equal(low.ok, false);
  assert.equal(low.field, "price");
  assert.match(low.message, /at most 5% off/);
});

test("prepareIntake: a New book older than 2 years is free-priced, also from the year already recorded for the ISBN", async () => {
  const old = await prepared(form({ condition: "new", price: "4", publishedYear: String(new Date().getFullYear() - 3) }));
  assert.equal(old.pricing.price, 4);
  const i = isbn();
  await pool.query("INSERT INTO books (isbn, title, published_year) VALUES ($1, 'Known year', $2)", [i, new Date().getFullYear() - 6]);
  const known = await prepared(form({ isbn: i, condition: "new", price: "3.5" }));
  assert.equal(known.pricing.price, 3.5);
  const unknown = await intake.prepareIntake(pool, intake.parseIntakeInput(form({ isbn: isbn(), condition: "new", price: "3.5" })).value);
  assert.equal(unknown.ok, false, "no year anywhere: the fixed-price rule applies");
});

test("prepareIntake: the refusals come in the order the form always gave them", async () => {
  const bad = { price: "abc", publishedYear: "abc", acquisitionCost: "-1", acquiredAt: "2020-13-45" };
  const order = [];
  for (const drop of ["price", "publishedYear", "acquisitionCost", "acquiredAt"]) {
    const r = await intake.prepareIntake(pool, intake.parseIntakeInput(form(bad)).value);
    order.push(r.field);
    delete bad[drop];
  }
  assert.deepEqual(order, ["price", "publishedYear", "acquisitionCost", "acquiredAt"]);
});

test("prepareIntake: the settings read is timed under its own label", async () => {
  const labels = [];
  await intake.prepareIntake(pool, intake.parseIntakeInput(form()).value, { time: (label, fn) => { labels.push(label); return fn(); } });
  assert.deepEqual(labels, ["settings"]);
});

// ---------- intakeRefusal and intakeAnswer ----------

test("intakeRefusal: the three kinds keep what was typed", () => {
  const input = intake.parseIntakeInput(form({ title: "T", condition: "new", publisherPrice: "9", publishedYear: "abc", fromScan: "1", priceLevel: "3", location: "Shelf" })).value;
  const refused = intake.intakeRefusal(input, "input", "Nope");
  assert.equal(refused.error, "Nope");
  assert.equal(refused.fromScan, true);
  assert.equal(refused.priceLevel, "3");
  assert.equal(refused.location, "Shelf");
  assert.equal(refused.book.publishedYear, "abc", "a refused year is shown as typed");
  assert.equal(refused.selectedCondition, "new");
  assert.equal(refused.publisherPriceValue, "9");
  const busy = intake.intakeRefusal(input, "busy", "Busy");
  assert.equal(busy.publisherPriceValue, undefined);
  assert.equal(busy.book.publishedYear, null);
  const noTitle = intake.intakeRefusal({ ...input, title: "" }, "title", "Title is required.");
  assert.equal(noTitle.book.title, null);
  assert.equal(noTitle.prep.title, null);
  assert.equal(noTitle.selectedCondition, undefined);
});

test("intakeAnswer: JSON or redirect, fast scan or the book's page", () => {
  const a = (extra, json) => intake.intakeAnswer(intake.parseIntakeInput(form({ location: "Shelf 2", source: "purchase", binding: "hardcover", condition: "good", ...extra })).value, { copyId: 5, bookId: 9, title: "T", requests: 2 }, json);
  assert.deepEqual(a({ fast: "1" }, true), { json: { ok: true, copyId: 5, bookId: 9, title: "T", requests: 2 } });
  assert.deepEqual(a({ fromScan: "1" }, true).json.ok, true);
  assert.deepEqual(a({}, true), { redirect: "/admin/inventory/9?requests=2" }, "no fast flag: the book's page, even for JSON");
  assert.deepEqual(a({ fast: "0", fromScan: "1" }, true), { redirect: "/admin/inventory/9?requests=2" });
  const fast = a({ addAnother: "1" }, false).redirect;
  assert.match(fast, /^\/admin\/inventory\/new\?/);
  for (const part of ["saved=5", "location=Shelf+2", "source=purchase", "binding=hardcover", "condition=good", "requests=2"]) assert.ok(fast.includes(part), part);
  assert.equal(intake.intakeAnswer(intake.parseIntakeInput(form()).value, { copyId: 1, bookId: 2, title: "T", requests: 0 }, false).redirect, "/admin/inventory/2");
});

// ---------- saveBookAndCopy ----------

test("saveBookAndCopy: a new book and its copy, with the token attached", async () => {
  const body = form({ isbn: isbn(), title: "Brand new", price: "6", acquisitionCost: "1.5", acquiredAt: "2024-01-02", copyNotes: "signed", location: " Back  room " });
  const input = await prepared(body);
  const saved = await intake.saveBookAndCopy(pool, input, ctx());
  assert.equal(saved.state, "saved");
  assert.equal(saved.isNewBook, true);
  assert.equal(saved.fillAfterSave, true);
  const { rows: [book] } = await pool.query("SELECT * FROM books WHERE id = $1", [saved.bookId]);
  assert.equal(book.title, "Brand new");
  assert.equal(book.created_by, adminId);
  assert.equal(book.binding, "trade");
  const { rows: [copy] } = await pool.query("SELECT * FROM book_copies WHERE id = $1", [saved.copyId]);
  assert.deepEqual(
    { book: copy.book_id, price: copy.price, cost: copy.acquisition_cost, loc: copy.location, source: copy.source, notes: copy.notes, status: copy.status, by: copy.created_by, basis: copy.price_basis, clearance: copy.is_clearance },
    { book: saved.bookId, price: "6.00", cost: "1.50", loc: "Back room", source: "donation", notes: "signed", status: "in_stock", by: adminId, basis: "manual", clearance: false }
  );
  const { rows: [t] } = await pool.query("SELECT copy_id, book_id FROM copy_intake_tokens WHERE token = $1", [input.token]);
  assert.deepEqual([t.copy_id, t.book_id], [saved.copyId, saved.bookId]);
});

test("saveBookAndCopy: a known ISBN gets another copy; the book keeps what it has, a missing binding is filled", async () => {
  const i = isbn();
  const first = await intake.saveBookAndCopy(pool, await prepared(form({ isbn: i, title: "First", binding: "" })), ctx());
  await settled();
  const second = await intake.saveBookAndCopy(pool, await prepared(form({ isbn: i, title: "Second title", binding: "hardcover" })), ctx());
  const third = await intake.saveBookAndCopy(pool, await prepared(form({ isbn: i, title: "Third", binding: "mass_market" })), ctx());
  assert.equal(second.bookId, first.bookId);
  assert.equal(second.isNewBook, false);
  assert.equal(third.bookId, first.bookId);
  const { rows: [book] } = await pool.query("SELECT title, binding FROM books WHERE id = $1", [first.bookId]);
  assert.deepEqual(book, { title: "First", binding: "hardcover" });
  const { rows } = await pool.query("SELECT id FROM book_copies WHERE book_id = $1", [first.bookId]);
  assert.equal(rows.length, 3);
});

test("saveBookAndCopy: the same token twice is one copy; a token being saved answers busy", async () => {
  const body = form({ isbn: isbn(), title: "Once" });
  const a = await intake.saveBookAndCopy(pool, await prepared(body), ctx());
  const b = await intake.saveBookAndCopy(pool, await prepared(body), ctx());
  assert.equal(b.state, "duplicate");
  assert.deepEqual([b.copyId, b.bookId, b.title], [a.copyId, a.bookId, "Once"]);
  const { rows } = await pool.query("SELECT id FROM book_copies WHERE book_id = $1", [a.bookId]);
  assert.equal(rows.length, 1);

  const busyToken = tok();
  await pool.query("INSERT INTO copy_intake_tokens (token) VALUES ($1)", [busyToken]);
  const busy = await intake.saveBookAndCopy(pool, await prepared(form({ isbn: isbn(), intakeToken: busyToken })), ctx());
  assert.deepEqual(busy, { state: "busy" });
});

test("saveBookAndCopy: a failure before the copy exists lets the token go; the retry saves", async () => {
  const body = form({ isbn: isbn(), title: "Retry", coverUrl: "" });
  const input = await prepared(body, { coverPhoto: [{ buffer: Buffer.from("not an image") }] });
  await assert.rejects(() => intake.saveBookAndCopy(pool, input, ctx()));
  const { rows } = await pool.query("SELECT 1 FROM copy_intake_tokens WHERE token = $1", [input.token]);
  assert.equal(rows.length, 0, "released");
  const retry = await intake.saveBookAndCopy(pool, await prepared(body), ctx());
  assert.equal(retry.state, "saved");
});

test("saveBookAndCopy: without a token it still saves (and says so in the log)", async () => {
  const warn = console.warn;
  const lines = [];
  console.warn = (m) => lines.push(String(m));
  try {
    const saved = await intake.saveBookAndCopy(pool, await prepared(form({ isbn: isbn(), intakeToken: undefined })), ctx());
    assert.equal(saved.state, "saved");
  } finally { console.warn = warn; }
  assert.ok(lines.some((l) => l.includes("without an intake token")));
});

test("saveBookAndCopy: clearance with 'all' scope reprices the other copies, one audit entry each", async () => {
  await pool.query("UPDATE pricing_settings SET clearance_scope = 'all' WHERE id = 1");
  require("../../src/lib/pricing/settings").clearSettingsCache();
  const i = isbn();
  await intake.saveBookAndCopy(pool, await prepared(form({ isbn: i, title: "Clear", price: "5" })), ctx());
  const other = await intake.saveBookAndCopy(pool, await prepared(form({ isbn: i, price: "6" })), ctx());
  audits.length = 0;
  const input = await prepared(form({ isbn: i, priceLevel: "clearance", repriceOthers: "1" }));
  const saved = await intake.saveBookAndCopy(pool, input, ctx());
  const { rows } = await pool.query("SELECT id, price, is_clearance FROM book_copies WHERE book_id = $1 ORDER BY id", [saved.bookId]);
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.is_clearance === true));
  const entries = audits.filter((a) => a.action === "copy.reprice");
  assert.equal(entries.length, 2, JSON.stringify(rows));
  assert.ok(entries.some((e) => e.targetId === other.copyId && /^price 6\.00 -> /.test(e.detail) && /\(clearance\)$/.test(e.detail)));
});

// ---------- afterSaveFollowUps ----------

test("afterSaveFollowUps: matches waiting customers and records the count on the token", async () => {
  const i = isbn();
  await pool.query("INSERT INTO book_requests (title, isbn, email, name, status, manage_token_hash, expires_at) VALUES ('Wanted', $1, 'w@example.test', 'W', 'open', $2, now() + interval '12 months')", [i, `h-${i}`]);
  const input = await prepared(form({ isbn: i, title: "Wanted" }));
  const saved = await intake.saveBookAndCopy(pool, input, ctx());
  const labels = [];
  const n = await intake.afterSaveFollowUps(pool, saved, input, { ...ctx(), time: (l, fn) => { labels.push(l); return fn(); } });
  await settled();
  assert.equal(n, 1);
  assert.deepEqual(labels, ["requests"]);
  const { rows: [t] } = await pool.query("SELECT requests FROM copy_intake_tokens WHERE token = $1", [input.token]);
  assert.equal(t.requests, 1);
  const again = await intake.saveBookAndCopy(pool, await prepared({ ...form({ isbn: i, title: "Wanted" }), intakeToken: input.token }), ctx());
  assert.equal(again.requests, 1, "a repeated token answers with the first count");
});

test("afterSaveFollowUps: a failing request match counts as nothing matched and never throws", async () => {
  const input = await prepared(form({ isbn: isbn() }));
  const saved = await intake.saveBookAndCopy(pool, input, ctx());
  const err = console.error;
  console.error = () => {};
  try {
    const n = await intake.afterSaveFollowUps(pool, { ...saved, copyId: 2147483647, bookId: -1 }, { ...input, token: null }, ctx());
    assert.equal(n, 0);
    assert.equal(await intake.matchBookRequests(async () => { throw new Error("boom"); }), 0);
  } finally { console.error = err; await settled(); }
});

// ---------- lib/inventoryCopies.js ----------

async function mkCopy(over = {}) {
  const input = await prepared(form({ isbn: isbn(), ...over }));
  const saved = await intake.saveBookAndCopy(pool, input, ctx());
  return saved;
}
const editFor = async (saved, over = {}) => {
  const input = copies.parseCopyEdit({ condition: "good", price: "6", location: "Store", source: "donation", status: "in_stock", renderedStatus: "in_stock", ...over });
  const priced = await copies.priceCopyEdit(pool, saved.bookId, input);
  return { input, priced };
};

test("parseCopyEdit / priceCopyEdit: read and priced as the edit form always was", async () => {
  const saved = await mkCopy();
  const { input, priced } = await editFor(saved, { price: "abc", status: "nonsense", location: "  Shelf  " });
  assert.equal(input.status, null);
  assert.equal(input.renderedStatus, "in_stock");
  assert.equal(input.location, "Shelf");
  assert.match(priced.error, /Price must be a number/);
  const overlay = copies.copyEditOverlay(saved.copyId, input, priced.choice);
  assert.equal(overlay.copy.price, "abc");
  assert.equal(overlay.copy.id, saved.copyId);
  assert.equal("status" in overlay.copy, false);
  assert.equal(overlay.copy.rendered_status, "in_stock");
});

test("updateCopy: saves under a lock, refuses a status that changed underneath, keeps a sold copy's status", async () => {
  const saved = await mkCopy();
  let e = await editFor(saved, { price: "7.5", location: "Back", notes: "n" });
  let out = await copies.updateCopy(pool, saved.bookId, saved.copyId, e.input, e.priced);
  assert.equal(out.before.location, "Store");
  assert.equal(out.keptStatus, false);
  const { rows: [c] } = await pool.query("SELECT price, location, notes FROM book_copies WHERE id = $1", [saved.copyId]);
  assert.deepEqual(c, { price: "7.50", location: "Back", notes: "n" });

  e = await editFor(saved, { status: "damaged", renderedStatus: "reserved" });
  out = await copies.updateCopy(pool, saved.bookId, saved.copyId, e.input, e.priced);
  assert.equal(out.status, 409);
  assert.match(out.error, /changed since you opened the form \(now: In Store\)/);

  await pool.query("UPDATE book_copies SET status = 'sold' WHERE id = $1", [saved.copyId]);
  e = await editFor(saved, { status: "in_stock", renderedStatus: "sold" });
  out = await copies.updateCopy(pool, saved.bookId, saved.copyId, e.input, e.priced);
  assert.equal(out.keptStatus, true);
  assert.equal((await pool.query("SELECT status FROM book_copies WHERE id = $1", [saved.copyId])).rows[0].status, "sold");

  assert.deepEqual(await copies.updateCopy(pool, saved.bookId, 2147483000, e.input, e.priced), { missing: true });
});

test("cancelReservation: back to stock, already gone, held by an order", async () => {
  const saved = await mkCopy({ status: "reserved" });
  await pool.query("UPDATE book_copies SET reserved_by_name = 'Pat', reserved_at = now() WHERE id = $1", [saved.copyId]);
  assert.deepEqual(await copies.cancelReservation(pool, saved.bookId, saved.copyId), { done: true });
  const { rows: [c] } = await pool.query("SELECT status, reserved_by_name, reserved_at FROM book_copies WHERE id = $1", [saved.copyId]);
  assert.deepEqual(c, { status: "in_stock", reserved_by_name: null, reserved_at: null });
  assert.deepEqual(await copies.cancelReservation(pool, saved.bookId, saved.copyId), { gone: "in_stock" });
  assert.deepEqual(await copies.cancelReservation(pool, saved.bookId, 2147483000), { done: true });
  const { makeOrder } = require("../helpers/orderFixtures");
  const { order, copyIds } = await makeOrder(pool, { status: "reserved" });
  const bookId = (await pool.query("SELECT book_id FROM book_copies WHERE id = $1", [copyIds[0]])).rows[0].book_id;
  assert.deepEqual(await copies.cancelReservation(pool, bookId, copyIds[0]), { orderId: order.id });
  assert.equal((await pool.query("SELECT status FROM book_copies WHERE id = $1", [copyIds[0]])).rows[0].status, "reserved");
});

test("deleteCopy / deleteBook: the book goes with its last copy; ordered items are refused; each deletion is audited", async () => {
  const i = isbn();
  const a = await intake.saveBookAndCopy(pool, await prepared(form({ isbn: i })), ctx());
  const b = await intake.saveBookAndCopy(pool, await prepared(form({ isbn: i })), ctx());
  audits.length = 0;
  assert.deepEqual(await copies.deleteCopy(pool, a.bookId, a.copyId, ctx()), { bookRemoved: false });
  assert.deepEqual(await copies.deleteCopy(pool, a.bookId, b.copyId, ctx()), { bookRemoved: true });
  assert.equal((await pool.query("SELECT 1 FROM books WHERE id = $1", [a.bookId])).rows.length, 0);
  assert.deepEqual(audits.map((x) => [x.action, x.targetId, x.detail || null]), [
    ["book_copy.delete", a.copyId, null], ["book_copy.delete", b.copyId, null], ["book.delete", a.bookId, "last copy removed"],
  ]);
  const { makeOrder } = require("../helpers/orderFixtures");
  const { copyIds } = await makeOrder(pool, { status: "reserved" });
  const bookId = (await pool.query("SELECT book_id FROM book_copies WHERE id = $1", [copyIds[0]])).rows[0].book_id;
  audits.length = 0;
  assert.deepEqual(await copies.deleteCopy(pool, bookId, copyIds[0], ctx()), { hasOrders: true });
  assert.deepEqual(await copies.deleteBook(pool, bookId, ctx()), { hasOrders: true });
  assert.equal(audits.length, 0, "a refused delete is not logged");
  const c = await mkCopy();
  assert.deepEqual(await copies.deleteBook(pool, c.bookId, ctx()), { deleted: true });
  assert.deepEqual(audits.map((x) => x.action), ["book.delete"]);
});
