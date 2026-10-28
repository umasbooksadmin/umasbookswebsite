// Three money-correctness rules of the accounting export and of "Mark collected and paid":
//  G2  a refund row is under the way the money was GIVEN BACK (orders.refund_method), not the way the sale was
//      paid: a card sale refunded in cash from the drawer lowers Cash (530), a cash sale refunded by bank
//      transfer is a Bank transfer row, never Cash. Only a refund with no recorded method keeps the sale's method.
//  G3  "Amount received" can never go below the fixed book price (loi Lang: 95% of the publisher's price for a
//      new book, except one published over 2 years ago). A class seat may be discounted (Sharon, 2026-10-28).
//  G4  a drop-in class seat collected at the till is a "Class seats" line (706), like one collected with the
//      admin button, and so is its refund; migration 105 moves the old till seat lines from "Other".
// Ends with a whole-day reconciliation: per account, the export equals what moved in the drawer and the bank.
// Real app, real database, the real routes.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { tillHarness } = require("../helpers/tillHarness");

let h;
let cart;
let accounting;
let till;
before(async () => {
  h = await tillHarness({ port: 4877, ip: "10.88.7.7" });
  cart = require("../../src/lib/cart");
  accounting = require("../../src/lib/accounting");
  till = require("../../src/lib/till");
  assert.equal((await h.post("/admin/till/day/open", { openingFloat: "50" })).status, 302);
});
after(async () => { await h.stop(); });

const paris = async () => (await h.pool.query("SELECT (now() AT TIME ZONE 'Europe/Paris')::date::text AS d")).rows[0].d;

// A reservation for a fresh account: books { price, condition, publisherPrice, publishedYear, title } and seats (prices).
async function reserve({ books = [], seats = [] }) {
  const { rows: u } = await h.pool.query(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, 'x', 'Money Buyer', now()) RETURNING id, email", [`money-${h.uniq()}@example.test`]);
  const items = [];
  for (const b of books) {
    const book = await h.seedBook(b.title || `Money ${h.uniq()}`);
    if (b.publishedYear) await h.pool.query("UPDATE books SET published_year = $2 WHERE id = $1", [book.id, b.publishedYear]);
    const copy = await h.seedCopy(book.id, { price: b.price, condition: b.condition || "very_good", publisherPrice: b.publisherPrice ?? null, location: "M1" });
    items.push({ kind: "book", copyId: copy, title: b.title || `Money ${copy}`, price: b.price });
  }
  for (const price of seats) {
    const classId = (await h.pool.query("INSERT INTO classes (title, starts_at, capacity, dropin_price) VALUES ($1, now() + interval '5 days', 4, $2) RETURNING id", [`Money Class ${h.uniq()}`, price])).rows[0].id;
    items.push({ kind: "dropin", classId, title: "Drop-in seat", startsAt: new Date(Date.now() + 5 * 86400000), price });
  }
  const order = await cart.createReservation(h.pool, { user: u[0], name: "Money Buyer", items, acceptedVersion: "v", hasDropin: false });
  const lines = (await h.pool.query("SELECT id, item_title FROM order_items WHERE order_id = $1 ORDER BY id", [order.id])).rows;
  return { id: order.id, lines };
}
const collectForm = (r, fields) => h.post(`/admin/orders/${r.id}/collect`, fields);
async function collectByAdmin(r, method, amountReceived = "", note = "") {
  const res = await collectForm(r, { method, amountReceived: String(amountReceived), note });
  assert.equal(res.status, 302, await res.text().catch(() => ""));
  assert.match(res.headers.get("location") || "", /collected-paid/, `collect refused: ${res.headers.get("location")}`);
}
async function collectAtTill(r, method) {
  const res = await h.sale(r.lines.map((l) => ({ kind: "reserved", orderId: r.id, itemId: l.id })), { method, received: "200" });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body.saleId;
}
async function refund(r, refundMethod) {
  const res = await h.post(`/admin/orders/${r.id}/refund`, { confirmRefunded: "on", refundMethod, note: "gave the money back" });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location") || "", /notice=refunded/, `refund refused: ${res.headers.get("location")}`);
}
const orderRow = async (id) => (await h.pool.query("SELECT * FROM orders WHERE id = $1", [id])).rows[0];

// The export of today, with accounts: "category|method|refund" -> cents, and debit account -> cents.
async function exportToday() {
  const day = await paris();
  const rep = await accounting.accountingExportReport(h.pool, { from: day, to: day });
  const rows = rep.sections[0].rows;
  const cells = new Map();
  const debit = new Map();
  const credit = new Map();
  for (const r of rows) {
    const k = `${r.category}|${r.method}|${r.refund}`;
    cells.set(k, (cells.get(k) || 0) + r.cents);
    debit.set(r.debit, (debit.get(r.debit) || 0) + r.cents);
    credit.set(r.credit, (credit.get(r.credit) || 0) + r.cents);
  }
  return { rows, cells, debit, credit };
}
const diff = (a, b) => {
  const out = {};
  for (const k of new Set([...a.keys(), ...b.keys()])) { const d = (b.get(k) || 0) - (a.get(k) || 0); if (d) out[k] = d; }
  return out;
};

// ---------- G2: the refund row follows how the money was given back ----------

test("G2: a card sale (collected at the till) refunded in CASH from the drawer is a Cash refund row (530), not Card", async () => {
  const r = await reserve({ books: [{ price: 12 }] });
  await collectAtTill(r, "card");
  const before = await exportToday();
  await refund(r, "cash");
  const after = await exportToday();
  assert.deepEqual(diff(before.cells, after.cells), { "Books used|Cash|true": -1200 });
  assert.deepEqual(diff(before.debit, after.debit), { 530: -1200 });
  const row = after.rows.find((x) => x.refund && x.method === "Cash" && x.category === "Books used");
  assert.match(row.label, /^Remboursement livres d'occasion, espèces, /);
});

test("G2: a cash sale (admin button) refunded by BANK TRANSFER is a Bank transfer refund row, never Cash", async () => {
  const r = await reserve({ books: [{ price: 7.5 }] });
  await collectByAdmin(r, "cash");
  const before = await exportToday();
  await refund(r, "transfer");
  const after = await exportToday();
  assert.deepEqual(diff(before.cells, after.cells), { "Books used|Bank transfer|true": -750 });
  const row = after.rows.find((x) => x.refund && x.method === "Bank transfer");
  assert.deepEqual([row.debit, row.credit, row.journal], ["511", "707", "BQ"]);
  assert.match(row.label, /^Remboursement livres d'occasion, virement, /);
  assert.deepEqual(diff(before.debit, after.debit), { 511: -750 }, "the drawer (530) is not touched");
  // the mapping page lists the new method, so the treasurer can choose its account
  assert.ok(accounting.mappingKeys().some(([c, m]) => c === "Books used" && m === "Bank transfer"));
});

test("G2: a discounted card collection refunded in cash: lines AND discount reversal are Cash, netting to what was received", async () => {
  const r = await reserve({ books: [{ price: 6 }, { price: 4 }] });
  await collectByAdmin(r, "card", "8.00", "regular");
  const before = await exportToday();
  await refund(r, "cash");
  const after = await exportToday();
  assert.deepEqual(diff(before.cells, after.cells), { "Books used|Cash|true": -1000, "Discount|Cash|true": 200 });
  assert.deepEqual(diff(before.debit, after.debit), { 530: -800 });
});

test("G2: 'other' goes to Other / not recorded; a refund with NO recorded method keeps the sale's method (as before)", async () => {
  const r1 = await reserve({ books: [{ price: 3 }] });
  await collectByAdmin(r1, "cheque");
  let before = await exportToday();
  await refund(r1, "other");
  assert.deepEqual(diff(before.cells, (await exportToday()).cells), { "Books used|Other / not recorded|true": -300 });

  const r2 = await reserve({ books: [{ price: 4 }] });
  await collectByAdmin(r2, "card");
  before = await exportToday();
  const { markOrderRefunded } = require("../../src/lib/orderActions");
  assert.equal((await markOrderRefunded(h.pool, r2.id, { note: "legacy, no method" })).outcome, "refunded");
  assert.equal((await orderRow(r2.id)).refund_method, null);
  assert.deepEqual(diff(before.cells, (await exportToday()).cells), { "Books used|Card at the till|true": -400 });
});

// ---------- G3: the fixed book price floor on "Mark collected and paid" ----------

test("G3: a €20 fixed-price new book cannot be collected for €10; the message names the book and the minimum; nothing changes", async () => {
  const r = await reserve({ books: [{ price: 20, condition: "new", publisherPrice: 20, title: "Le Petit Prince neuf" }] });
  const res = await collectForm(r, { method: "cash", amountReceived: "10", note: "friend" });
  assert.equal(res.status, 200, "refused by the server (a 302 would mean it was collected)");
  const text = await res.text();
  // the form shows the minimum too
  assert.match(text, /Lowest amount allowed: <strong>&euro;19\.00<\/strong>/);
  assert.match(text, /id="amountReceived"[^>]*min="19\.00"/);
  assert.match(text, /below the minimum for these items: €19\.00/);
  assert.match(text, /&#34;Le Petit Prince neuf&#34;: at least €19\.00|"Le Petit Prince neuf": at least €19\.00/);
  assert.match(text, /fixed book price/);
  const o = await orderRow(r.id);
  assert.equal(o.status, "reserved", "nothing was collected");
  assert.equal((await h.pool.query("SELECT status FROM book_copies c JOIN order_items oi ON oi.book_copy_id = c.id WHERE oi.order_id = $1", [r.id])).rows[0].status, "reserved");
  // 18.99 is still too low; 19.00 (5% off) is the legal minimum
  const low = await collectForm(r, { method: "cash", amountReceived: "18.99", note: "friend" });
  assert.equal(low.status, 200);
  await collectByAdmin(r, "cash", "19.00", "5% off");
  assert.equal(Number((await orderRow(r.id)).total_amount), 19);
});

test("G3: rounding is up to the cent, like the till (publisher's price €15.99: at least €15.20)", async () => {
  const r = await reserve({ books: [{ price: 15.99, condition: "new", publisherPrice: 15.99 }] });
  const low = await collectForm(r, { method: "card", amountReceived: "15.19", note: "x" });
  assert.equal(low.status, 200);
  assert.match(await low.text(), /at least €15\.20/);
  await collectByAdmin(r, "card", "15.20", "5% off");
});

test("G3: a new book published over 2 years ago and a second-hand book may be discounted freely (as at the till)", async () => {
  const old = await reserve({ books: [{ price: 20, condition: "new", publisherPrice: 20, publishedYear: 2015 }] });
  await collectByAdmin(old, "card", "5.00", "old stock");
  const used = await reserve({ books: [{ price: 8 }] });
  await collectByAdmin(used, "card", "0", "given away, damaged");
});

test("G3: a class seat can be discounted at pickup; a new book with it still keeps its fixed-price minimum", async () => {
  const r = await reserve({ books: [{ price: 6 }], seats: [9] });
  await collectByAdmin(r, "card", "3.00", "class discount");
  assert.equal((await orderRow(r.id)).status, "paid");
  const n = await reserve({ books: [{ price: 20, condition: "new", publisherPrice: 20, title: "Fixed price" }], seats: [9] });
  const res = await collectForm(n, { method: "card", amountReceived: "10.00", note: "deal" });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /below the minimum for these items: €19\.00/);
  assert.doesNotMatch(text, /Class seats/);
  await collectByAdmin(n, "card", "19.00", "seat free with the book");
});

test("G3: the till collects reservations at their reserved price, so it is never refused by the floor", async () => {
  const r = await reserve({ books: [{ price: 19.5, condition: "new", publisherPrice: 20 }] });
  await collectAtTill(r, "card");
  assert.equal((await orderRow(r.id)).status, "paid");
});

// ---------- G4: class seats collected at the till ----------

test("G4: a seat collected at the till is a Class seats line (706), and so is its refund", async () => {
  const r = await reserve({ books: [{ price: 5 }], seats: [11] });
  const before = await exportToday();
  const saleId = await collectAtTill(r, "cash");
  const items = (await h.pool.query("SELECT kind, copy_id, category FROM till_sale_items WHERE sale_id = $1 ORDER BY id", [saleId])).rows;
  assert.deepEqual(items.map((i) => i.category), ["books_used", "class_seats"]);
  const mid = await exportToday();
  assert.deepEqual(diff(before.cells, mid.cells), { "Books used|Cash|false": 500, "Class seats|Cash|false": 1100 });
  assert.equal(mid.rows.find((x) => x.category === "Class seats" && x.method === "Cash" && !x.refund).credit, "706");
  // the same seat collected with the admin button lands in the same place
  const viaAdmin = await reserve({ seats: [11] });
  await collectByAdmin(viaAdmin, "cash");
  const mid2 = await exportToday();
  assert.deepEqual(diff(mid.cells, mid2.cells), { "Class seats|Cash|false": 1100 });
  // refunded: reversed under Class seats
  await refund(r, "cash");
  assert.deepEqual(diff(mid2.cells, (await exportToday()).cells), { "Books used|Cash|true": -500, "Class seats|Cash|true": -1100 });
  // the End of day page names the category
  assert.match((await h.get(`/admin/till/day?day=${await paris()}`)).text, /<td>Class seats<\/td>/);
});

test("G4: migration 105 moves old till seat lines from 'other' to 'class_seats' and nothing else; re-running changes nothing", async () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "105_till_class_seats_category.sql"), "utf8");
  // an old till seat line (written as 'other' before the fix), a reservation book line, and a manual "Other" item
  const r = await reserve({ books: [{ price: 4 }], seats: [7] });
  const saleId = await collectAtTill(r, "card");
  await h.pool.query("UPDATE till_sale_items SET category = 'other' WHERE sale_id = $1 AND copy_id IS NULL", [saleId]);
  const manual = await h.sale([{ kind: "manual", description: "Raffle ticket", price: "2", category: "other", quantity: 1 }], { method: "card" });
  assert.equal(manual.status, 200, JSON.stringify(manual.body));
  const before = await exportToday();

  await h.pool.query(sql);
  const cats = async (id) => (await h.pool.query("SELECT category FROM till_sale_items WHERE sale_id = $1 ORDER BY id", [id])).rows.map((x) => x.category);
  assert.deepEqual(await cats(saleId), ["books_used", "class_seats"]);
  assert.deepEqual(await cats(manual.body.saleId), ["other"], "a manual Other item is never touched");
  const after = await exportToday();
  assert.deepEqual(diff(before.cells, after.cells), { "Other|Card at the till|false": -700, "Class seats|Card at the till|false": 700 });
  assert.deepEqual(diff(before.debit, after.debit), {}, "the money side is unchanged");
  // idempotent, and the widened CHECK still refuses an unknown category
  await h.pool.query(sql);
  assert.deepEqual(await cats(saleId), ["books_used", "class_seats"]);
  await assert.rejects(h.pool.query("UPDATE till_sale_items SET category = 'bogus' WHERE sale_id = $1", [saleId]), /till_sale_items_category_check/);
});

// ---------- Reconciliation: one day, every way money moved ----------

test("reconciliation: per account, the export equals what moved in the drawer (530) and through the card / bank (511)", async () => {
  const day = await paris();
  const before = await exportToday();
  const drawerBefore = (await till.daySummary(h.pool, day)).expectedCashCents;

  // 1. a plain cash sale at the till: +4.00 cash
  const book = await h.seedBook(`Recon plain ${h.uniq()}`);
  const plain = await h.sale([h.book(await h.seedCopy(book.id, { price: 4 }))], { method: "cash", received: "10" });
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  // 2. a card sale (reservation at the till, card) refunded in cash from the drawer: card +13.00, drawer -13.00
  const cardThenCash = await reserve({ books: [{ price: 13 }] });
  await collectAtTill(cardThenCash, "card");
  await refund(cardThenCash, "cash");
  // 3. a cash sale (admin button) refunded by bank transfer: drawer +9.00, bank -9.00
  const cashThenTransfer = await reserve({ books: [{ price: 9 }] });
  await collectByAdmin(cashThenTransfer, "cash");
  await refund(cashThenTransfer, "transfer");
  // 4. a drop-in seat at the till, cash: +12.00
  const seat = await reserve({ seats: [12] });
  await collectAtTill(seat, "cash");
  // 5. a discounted collection in cash: a new book (pub 20, legal 5% off) and a used one (10), 27.00 received of 30.00
  const disc = await reserve({ books: [{ price: 20, condition: "new", publisherPrice: 20 }, { price: 10 }] });
  await collectByAdmin(disc, "cash", "27.00", "used copy marked down");

  const DRAWER = 400 - 1300 + 900 + 1200 + 2700;
  const CARD_BANK = 1300 - 900;
  const drawerAfter = (await till.daySummary(h.pool, day)).expectedCashCents;
  assert.equal(drawerAfter - drawerBefore, DRAWER, "the drawer's expected cash moved by exactly this");

  const after = await exportToday();
  const moved = diff(before.debit, after.debit);
  assert.deepEqual(moved, { 530: DRAWER, 511: CARD_BANK }, "export per money account == what moved");
  // the income side: books, seat, discount
  const income = diff(before.credit, after.credit);
  assert.deepEqual(income, { 707: 400 + 1300 - 1300 + 900 - 900 + 3000, 706: 1200, 709: -300 });

  // close the day counting exactly the expected cash: no over/short row, and the export's Cash for the
  // whole day is the counted cash minus the opening float
  assert.equal((await h.post("/admin/till/day/close", { day, counted: (drawerAfter / 100).toFixed(2) })).status, 302);
  const dr = (await h.pool.query("SELECT * FROM till_days WHERE day = $1", [day])).rows[0];
  assert.equal(dr.difference_cents, 0);
  const final = await exportToday();
  assert.equal(final.rows.filter((x) => x.category === "Cash over/short").length, 0);
  assert.equal(final.debit.get("530"), dr.counted_cash_cents - dr.opening_float_cents, "export Cash for the day == cash counted - float");
});
