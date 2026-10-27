// Review F, F4 and F7 on "Mark collected and paid" (lib/orderActions.js collectReservationTx):
//  - F4: the copies it sells get sold_at = now() and sold_via = 'reservation' (the inventory export's "Date sold"
//    was blank); a refund that restocks a copy clears them again (as voidSale does for a till sale); and the
//    migration's one-off backfill fixes copies already sold that way.
//  - F7: a ticked item that is no longer held (sold at the till meanwhile) is NOT silently dropped: the flash names it;
//    when EVERY ticked item was dropped the action is refused (nothing changed) and says so.
// In-process app with the real orders router; own throwaway database.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { adminHarness } = require("../helpers/adminHarness");
const { makeOrder } = require("../helpers/orderFixtures");

const h = adminHarness("collect_edge", ["orders"], { isolated: true });
before(() => h.start());
after(() => h.stop());

const { collectReservation, markOrderRefunded } = require("../../src/lib/orderActions");
const { writeCopiesCsv, DIALECT } = require("../../src/lib/inventoryExport");

const copyRow = async (id) => (await h.q("SELECT status, sold_at, sold_via, cart_order_id FROM book_copies WHERE id = $1", [id]))[0];
const itemIdFor = async (copyId) => (await h.q("SELECT id FROM order_items WHERE book_copy_id = $1", [copyId]))[0].id;
// What the till does when it sells a copy that was reserved: the copy is sold elsewhere.
const soldAtTill = (copyId) => h.q("UPDATE book_copies SET status = 'sold', sold_at = now(), sold_via = 'till', cart_order_id = NULL WHERE id = $1", [copyId]);

async function copiesCsv() {
  let text = "";
  await writeCopiesCsv(h.pool, async (chunk) => { text += chunk; });
  return text;
}

// ---------- F4 ----------

test("F4: collecting a reservation sets sold_at and sold_via on its copies, and the inventory export shows the date", async () => {
  const { order, copyIds } = await makeOrder(h.pool, { status: "reserved", books: 2 });
  const r = await collectReservation(h.pool, order.id, { adminUserId: h.admin.id, method: "cash" });
  assert.equal(r.outcome, "collected");
  for (const id of copyIds) {
    const c = await copyRow(id);
    assert.equal(c.status, "sold");
    assert.ok(c.sold_at, "sold_at is set");
    assert.equal(c.sold_via, "reservation");
    assert.ok(Math.abs(c.sold_at.getTime() - Date.now()) < 60000);
  }
  const csv = await copiesCsv();
  const today = (await h.q("SELECT to_char(now() AT TIME ZONE 'Europe/Paris', 'YYYY-MM-DD') AS d"))[0].d;
  const [header, ...lines] = csv.replace(/^\uFEFF/, "").split("\r\n");
  const cols = header.split(DIALECT.sep).map((c) => c.replace(/^"|"$/g, ""));
  const idCol = cols.indexOf("Copy ID");
  const soldCol = cols.indexOf("Date sold");
  assert.ok(idCol >= 0 && soldCol >= 0);
  for (const id of copyIds) {
    const fields = lines.find((l) => l.split(DIALECT.sep)[idCol].replace(/"/g, "") === String(id));
    assert.ok(fields, `copy ${id} in the export`);
    assert.equal(fields.split(DIALECT.sep)[soldCol].replace(/"/g, ""), today, "the export's Date sold column is filled");
  }
});

test("F4: a partial pickup stamps only the collected copy; the rest stays reserved with no sold_at", async () => {
  const { order, copyIds } = await makeOrder(h.pool, { status: "reserved", books: 2 });
  const r = await collectReservation(h.pool, order.id, { adminUserId: h.admin.id, method: "card", itemIds: [await itemIdFor(copyIds[0])] });
  assert.equal(r.outcome, "collected");
  assert.equal((await copyRow(copyIds[0])).sold_via, "reservation");
  const rest = await copyRow(copyIds[1]);
  assert.equal(rest.status, "reserved");
  assert.equal(rest.sold_at, null);
  assert.equal(rest.sold_via, null);
});

test("F4: refunding the order restocks the copy and clears sold_at / sold_via", async () => {
  const { order, copyIds } = await makeOrder(h.pool, { status: "reserved", books: 1 });
  await collectReservation(h.pool, order.id, { adminUserId: h.admin.id, method: "cash" });
  const refund = await markOrderRefunded(h.pool, order.id, { note: "customer changed their mind" });
  assert.equal(refund.outcome, "refunded");
  assert.equal(refund.restocked, 1);
  const c = await copyRow(copyIds[0]);
  assert.equal(c.status, "in_stock");
  assert.equal(c.sold_at, null);
  assert.equal(c.sold_via, null);
});

test("F4: the migration backfills sold copies of paid / collected orders, idempotently, and leaves other copies alone", async () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "..", "migrations", "101_membership_reversals_and_sold_via.sql"), "utf8");
  // Collected in person (collected_at set) and an old online-checkout order (no collected_at): both paid, copies sold, no sold_at.
  const a = await makeOrder(h.pool, { status: "paid", books: 1, collected: true, paidDaysAgo: 9 });
  const b = await makeOrder(h.pool, { status: "paid", books: 1, collected: false, paidDaysAgo: 5 });
  // A copy already stamped by the till, and a copy sold with no order at all.
  const { rows: bk } = await h.pool.query("INSERT INTO books (title) VALUES ('Backfill extras') RETURNING id");
  const { rows: till } = await h.pool.query("INSERT INTO book_copies (book_id, status, price, sold_at, sold_via) VALUES ($1, 'sold', 4, '2026-01-02 10:00+01', 'till') RETURNING id", [bk[0].id]);
  const { rows: bare } = await h.pool.query("INSERT INTO book_copies (book_id, status, price) VALUES ($1, 'sold', 4) RETURNING id", [bk[0].id]);
  await h.pool.query("UPDATE book_copies SET sold_at = NULL, sold_via = NULL WHERE id = ANY($1)", [[...a.copyIds, ...b.copyIds]]);

  await h.pool.query(sql);
  const ca = await copyRow(a.copyIds[0]);
  const cb = await copyRow(b.copyIds[0]);
  assert.equal(ca.sold_at.getTime(), (await h.q("SELECT paid_at FROM orders WHERE id = $1", [a.order.id]))[0].paid_at.getTime());
  assert.equal(ca.sold_via, "reservation");
  assert.ok(cb.sold_at, "an old online order gets its date too");
  assert.equal(cb.sold_via, null, "but is not called a reservation");
  assert.equal((await copyRow(till[0].id)).sold_via, "till");
  assert.equal((await copyRow(till[0].id)).sold_at.toISOString(), "2026-01-02T09:00:00.000Z", "the till's own date is kept");
  assert.equal((await copyRow(bare[0].id)).sold_at, null, "no order, nothing to backfill from");

  const snapshot = JSON.stringify([await copyRow(a.copyIds[0]), await copyRow(b.copyIds[0])]);
  await h.pool.query(sql);
  assert.equal(JSON.stringify([await copyRow(a.copyIds[0]), await copyRow(b.copyIds[0])]), snapshot, "running it again changes nothing");
});

// ---------- F7 ----------

test("F7: a ticked item that was sold at the till meanwhile is named in the flash, and the others are collected", async () => {
  const { order, copyIds } = await makeOrder(h.pool, { status: "reserved", books: 3 });
  const [i0, i1, i2] = await Promise.all(copyIds.map(itemIdFor));
  await soldAtTill(copyIds[1]);

  const { res, text } = await h.post(`/admin/orders/${order.id}/collect-selected`, { itemIds: [i0, i1], method: "cash" });
  assert.equal(res.status, 200);
  assert.match(text, /Collected and paid\. 1 item was collected; 1 was no longer reserved and was removed from this reservation: Fixture Book \d+-1\./);
  assert.ok(!/<div class="notice-box"[^>]*>Collected and paid: the books and seats are sold/.test(text), "not the plain success message");
  assert.equal((await copyRow(copyIds[0])).sold_via, "reservation");
  assert.equal((await copyRow(copyIds[2])).status, "reserved", "the unticked, still-held item moved to the split reservation");
  const audit = await h.q("SELECT detail FROM admin_audit_log WHERE action = 'order.collected_paid' AND target_id = $1", [order.id]);
  assert.match(audit[0].detail, /dropped 1 no longer held/);
  void i2;
});

test("F7: when EVERY ticked item was dropped the action is refused as an error and nothing changes", async () => {
  const { order, copyIds } = await makeOrder(h.pool, { status: "reserved", books: 2 });
  const [i0, i1] = await Promise.all(copyIds.map(itemIdFor));
  await soldAtTill(copyIds[0]);

  const { res, text } = await h.post(`/admin/orders/${order.id}/collect-selected`, { itemIds: [i0], method: "cash" });
  assert.equal(res.status, 200);
  assert.match(text, /None of the ticked items is still reserved, so nothing was collected and nothing was changed \(Fixture Book \d+-0\)/);
  const [o] = await h.q("SELECT status FROM orders WHERE id = $1", [order.id]);
  assert.equal(o.status, "reserved");
  assert.equal((await h.q("SELECT count(*)::int AS n FROM order_items WHERE order_id = $1", [order.id]))[0].n, 2, "no item was removed");
  assert.equal((await copyRow(copyIds[1])).status, "reserved");
  void i1;
});

test("F7: with nothing dropped the plain success redirect is unchanged", async () => {
  const { order, copyIds } = await makeOrder(h.pool, { status: "reserved", books: 2 });
  const { res } = await h.post(`/admin/orders/${order.id}/collect-selected`, { itemIds: [await itemIdFor(copyIds[0])], method: "cash" });
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /\?notice=collected-partial$/);
});
