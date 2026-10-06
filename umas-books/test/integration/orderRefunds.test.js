// Refunds and the order list in the admin (/admin/orders):
//  - "Mark refunded": the refund was given back IN THE SHOP (cash, cheque or
//    card; the app moves no money), so this only updates our records: one
//    transaction that puts the books back in stock and releases the drop-in
//    seats, keeps the money out of the reports, is written to the audit log,
//    repeats safely and refuses what it must refuse;
//  - the old "Mark collected" (orders paid online before reservations), the order
//    list filters and paging, the detail page, "Cancel unpaid order" (a leftover
//    'pending' order of the old online checkout), and the dashboard's Paris-time
//    buckets and "needs attention" counts.
// Own throwaway database (counts below are exact); the mailer is stubbed and
// HelloAsso is never reachable (any call to it fails the test).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");

const { adminHarness } = require("../helpers/adminHarness");
const { makeOrder } = require("../helpers/orderFixtures");

const mailer = require("../../src/mailer");
mailer.sendMail = async () => {};
const helloasso = require("../../src/lib/helloasso");
const helloassoCalls = [];
for (const name of Object.keys(helloasso)) {
  if (typeof helloasso[name] === "function") helloasso[name] = async () => { helloassoCalls.push(name); throw new Error(`HelloAsso must not be called (${name})`); };
}

const h = adminHarness("order_refunds", ["orders", "dashboard", "reports", "members"], { isolated: true });
const { seatsTakenExpr } = require("../../src/lib/classCapacity");
const { salesStats, attentionCounts } = require("../../src/lib/dashboardStats");

before(() => h.start());
after(() => { assert.deepEqual(helloassoCalls, [], "no HelloAsso call anywhere in this file"); return h.stop(); });

const orderRow = async (id) => (await h.q("SELECT * FROM orders WHERE id = $1", [id]))[0];
const copyStatuses = async (ids) => (await h.q("SELECT status FROM book_copies WHERE id = ANY($1::int[]) ORDER BY id", [ids])).map((r) => r.status);
const auditRows = (id) => h.q("SELECT action, detail, actor_user_id FROM admin_audit_log WHERE target_type = 'order' AND target_id = $1 ORDER BY id", [id]);
const seatsTaken = async (classId) => (await h.q(`SELECT ${seatsTakenExpr("classes")}::int AS n FROM classes WHERE id = $1`, [classId]))[0].n;
const refundPost = (id, extra = {}) => h.post(`/admin/orders/${id}/refund`, { confirmRefunded: "on", note: "Withdrew by email, refunded in cash at the shop on 3 Oct", ...extra });

test("mark refunded: order refunded, books back in stock, seat released, audited, out of the sales report", async () => {
  const { order, copyIds, seatId, classId } = await makeOrder(h.pool, { books: 2, seat: true, paidDaysAgo: 1 });
  assert.equal(await seatsTaken(classId), 1);

  const { res } = await refundPost(order.id);
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /notice=refunded/);

  const after = await orderRow(order.id);
  assert.equal(after.status, "refunded");
  assert.ok(after.refunded_at);
  assert.match(after.refund_note, /Withdrew by email/);
  assert.deepEqual(await copyStatuses(copyIds), ["in_stock", "in_stock"]);
  assert.equal((await h.q("SELECT status FROM class_dropin_seats WHERE id = $1", [seatId]))[0].status, "released");
  assert.equal(await seatsTaken(classId), 0, "a refunded seat no longer counts against capacity");

  const log = await auditRows(order.id);
  assert.equal(log.length, 1);
  assert.equal(log[0].action, "order.refunded");
  assert.equal(log[0].actor_user_id, h.admin.id);
  assert.match(log[0].detail, /restocked 2/);

  // The copies can be bought again.
  const { rows: sellable } = await h.pool.query("SELECT COUNT(*)::int AS n FROM book_copies WHERE id = ANY($1::int[]) AND status = 'in_stock'", [copyIds]);
  assert.equal(sellable[0].n, 2);
});

test("a refunded order is out of revenue, the sales report shows it as its own line, and member totals ignore it", async () => {
  const email = `refund-totals-${h.uniq()}@example.test`;
  const { rows: u } = await h.pool.query(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, 'x', 'Totals Buyer', now()) RETURNING id", [email]
  );
  const kept = await makeOrder(h.pool, { email, books: 1, price: 5, paidAt: "2031-03-10T10:00:00Z", userId: u[0].id });
  const gone = await makeOrder(h.pool, { email, books: 1, price: 7, paidAt: "2031-03-11T10:00:00Z", userId: u[0].id });
  await refundPost(gone.order.id);
  // Refunds are counted on the day they were recorded: move that into the range under test.
  await h.pool.query("UPDATE orders SET refunded_at = '2031-03-12T10:00:00Z' WHERE id = $1", [gone.order.id]);

  const { text } = await h.get("/admin/reports/sales?from=2031-03-01&to=2031-03-31&group=month");
  assert.match(text, /Refunds \(orders refunded in the shop; not included in the sales above\)/);
  const csvBooks = (await h.get("/admin/reports/sales?from=2031-03-01&to=2031-03-31&group=month&format=csv&table=books")).text;
  assert.match(csvBooks, /"2031-03",1,5\.00,0,0\.00,5\.00/, "only the kept order is revenue");
  const csvRefunds = (await h.get("/admin/reports/sales?from=2031-03-01&to=2031-03-31&group=month&format=csv&table=refunds")).text;
  assert.match(csvRefunds, /Orders refunded/);
  assert.match(csvRefunds, /,1,7\.00/);

  // Member page totals: €5, not €12 (the page rounds to whole euros).
  const members = await h.get(`/admin/members?view=${u[0].id}`);
  assert.match(members.text, /Books Ordered<\/span><span class="small">1 &middot; &euro;5</);
  assert.equal(kept.order.status, "paid");
});

test("mark refunded twice changes nothing the second time (no second audit row, a re-sold copy stays sold)", async () => {
  const { order, copyIds } = await makeOrder(h.pool, { paidDaysAgo: 1 });
  await refundPost(order.id);
  // The copy is bought again by someone else in the shop.
  await h.pool.query("UPDATE book_copies SET status = 'sold' WHERE id = $1", [copyIds[0]]);

  const second = await refundPost(order.id);
  assert.equal(second.res.status, 302);
  assert.match(second.res.headers.get("location"), /notice=already-refunded/);
  assert.deepEqual(await copyStatuses(copyIds), ["sold"], "the second click must not restock a re-sold copy");
  assert.equal((await auditRows(order.id)).length, 1);
});

test("markOrderRefunded itself is idempotent and reports why it refused", async () => {
  const { markOrderRefunded } = require("../../src/lib/orderActions");
  const { order } = await makeOrder(h.pool, { paidDaysAgo: 1 });
  assert.equal((await markOrderRefunded(h.pool, order.id, { note: "n" })).outcome, "refunded");
  assert.equal((await markOrderRefunded(h.pool, order.id, { note: "n" })).outcome, "already");
  assert.equal((await markOrderRefunded(h.pool, 987654321, { note: "n" })).outcome, "not_found");
  const { order: pending } = await makeOrder(h.pool, { status: "pending" });
  assert.equal((await markOrderRefunded(h.pool, pending.id, { note: "n" })).outcome, "not_paid");
  const { order: paid } = await makeOrder(h.pool, { paidDaysAgo: 1 });
  assert.equal((await markOrderRefunded(h.pool, paid.id, { note: "  " })).outcome, "note_required");
  assert.equal((await orderRow(paid.id)).status, "paid");
});

test("a copy already sold again after this order was paid is left sold and reported", async () => {
  const { order, copyIds } = await makeOrder(h.pool, { books: 2, paidDaysAgo: 2 });
  // Edge case: the copy was put back by hand and sold over the counter since.
  await h.pool.query("INSERT INTO shop_sales (copy_id, price, sold_at) VALUES ($1, 5, now() - interval '1 day')", [copyIds[0]]);
  await refundPost(order.id);
  assert.deepEqual(await copyStatuses(copyIds), ["sold", "in_stock"]);
  const log = await auditRows(order.id);
  assert.match(log[0].detail, /restocked 1, kept sold \(resold\) 1/);
});

test("mark refunded refuses an order that is not paid, and a missing confirmation or note", async () => {
  for (const status of ["pending", "expired", "cancelled"]) {
    const { order, copyIds } = await makeOrder(h.pool, { status });
    const before = await copyStatuses(copyIds);
    const { res, text } = await refundPost(order.id);
    assert.equal(res.status, 409, status);
    assert.match(text, /Only a paid order can be marked refunded/);
    assert.equal((await orderRow(order.id)).status, status);
    assert.deepEqual(await copyStatuses(copyIds), before);
    assert.equal((await auditRows(order.id)).length, 0);
  }

  const { order, copyIds } = await makeOrder(h.pool, { paidDaysAgo: 1 });
  const noBox = await h.post(`/admin/orders/${order.id}/refund`, { note: "x" });
  assert.equal(noBox.res.status, 400);
  assert.match(noBox.text, /Tick the box/);
  const noNote = await h.post(`/admin/orders/${order.id}/refund`, { confirmRefunded: "on", note: "   " });
  assert.equal(noNote.res.status, 400);
  assert.match(noNote.text, /write a note/);
  assert.equal((await orderRow(order.id)).status, "paid");
  assert.deepEqual(await copyStatuses(copyIds), ["sold"]);
});

test("the refund page says the refund must have been given in the shop first (no HelloAsso), and a member cannot reach any order action", async () => {
  const { order } = await makeOrder(h.pool, { paidDaysAgo: 1 });
  const page = await h.get(`/admin/orders/${order.id}/refund`);
  assert.equal(page.res.status, 200);
  assert.match(page.text, /Do this only AFTER you gave the money back to the customer in the shop/);
  assert.match(page.text, /name="confirmRefunded"/);
  assert.doesNotMatch(page.text, /HelloAsso/i);
  assert.match(page.text, /name="note"[^>]*required/);

  for (const [method, path] of [["get", "/admin/orders"], ["get", `/admin/orders/${order.id}`], ["get", `/admin/orders/${order.id}/refund`]]) {
    const r = await h[method](path, h.member);
    assert.notEqual(r.res.status, 200, path);
  }
  for (const path of [`/admin/orders/${order.id}/refund`, `/admin/orders/${order.id}/collected`, `/admin/orders/${order.id}/cancel`]) {
    const r = await h.post(path, { confirmRefunded: "on", note: "n" }, { user: h.member });
    assert.ok(!/notice=/.test(r.res.headers.get("location") || ""), `${path} must not act for a member`);
  }
  assert.equal((await orderRow(order.id)).status, "paid", "a member's POSTs changed nothing");
});

test("mark collected: sets who and when, audited, repeats safely, refused for an unpaid order", async () => {
  const { order } = await makeOrder(h.pool, { paidDaysAgo: 3 });
  const first = await h.post(`/admin/orders/${order.id}/collected`);
  assert.match(first.res.headers.get("location"), /notice=collected/);
  const row = await orderRow(order.id);
  assert.ok(row.collected_at);
  assert.equal(row.collected_by, h.admin.id);
  assert.equal(row.status, "paid");

  const second = await h.post(`/admin/orders/${order.id}/collected`);
  assert.match(second.res.headers.get("location"), /notice=already-collected/);
  assert.equal((await orderRow(order.id)).collected_at.getTime(), row.collected_at.getTime());
  const log = await auditRows(order.id);
  assert.deepEqual(log.map((l) => l.action), ["order.collected"]);

  const { order: pending } = await makeOrder(h.pool, { status: "pending" });
  await h.post(`/admin/orders/${pending.id}/collected`);
  assert.equal((await orderRow(pending.id)).collected_at, null);
});

test("order list: default view, status filter, 'paid online and not collected', search and Paris date range", async () => {
  const email = `list-${h.uniq()}@example.test`;
  const uncollected = await makeOrder(h.pool, { email, name: "Zelda Listbuyer", paidDaysAgo: 5 });
  const collected = await makeOrder(h.pool, { email, name: "Zelda Listbuyer", paidDaysAgo: 5, collected: true });
  const flagged = await makeOrder(h.pool, { name: "Flagged Person", paidDaysAgo: 2 });
  const reserved = await makeOrder(h.pool, { name: "Reserved Person", status: "reserved" });
  const refunded = await makeOrder(h.pool, { status: "refunded", paidDaysAgo: 8 });
  const dropinOnly = await makeOrder(h.pool, { books: 0, seat: true, paidDaysAgo: 20 });

  const ids = (text) => [...text.matchAll(/Order #(\d+)<\/strong>/g)].map((m) => Number(m[1]));

  const unc = ids((await h.get("/admin/orders?show=uncollected")).text);
  assert.ok(unc.includes(uncollected.order.id));
  assert.ok(!unc.includes(collected.order.id), "collected orders are not waiting");
  assert.ok(!unc.includes(dropinOnly.order.id), "a drop-in-only order never waits for pickup");
  assert.ok(!unc.includes(refunded.order.id));

  // The default view is the reservations. The removed refund-detection view is an unknown value now: no error.
  const def = ids((await h.get("/admin/orders")).text);
  assert.ok(def.includes(reserved.order.id) && !def.includes(flagged.order.id), "default: reserved orders only");
  const all = ids((await h.get("/admin/orders?show=all")).text);
  assert.ok(all.includes(reserved.order.id) && all.includes(flagged.order.id) && all.includes(refunded.order.id));
  const gone = await h.get("/admin/orders?show=refund_detected");
  assert.equal(gone.res.status, 200);
  assert.doesNotMatch(gone.text, /refund detected/i);

  const rf = ids((await h.get("/admin/orders?show=refunded")).text);
  assert.ok(rf.includes(refunded.order.id) && !rf.includes(uncollected.order.id));

  const byName = ids((await h.get("/admin/orders?q=zelda%20listbuyer")).text);
  assert.deepEqual(byName.sort(), [uncollected.order.id, collected.order.id].sort());
  const byId = ids((await h.get(`/admin/orders?q=%23${flagged.order.id}`)).text);
  assert.ok(byId.includes(flagged.order.id));
  const byEmail = ids((await h.get(`/admin/orders?q=${encodeURIComponent(email.toUpperCase())}`)).text);
  assert.equal(byEmail.length, 2);
  // wildcard characters are literal
  assert.equal(ids((await h.get("/admin/orders?q=%25")).text).length, 0);

  // Paris day boundaries: created 23:30 UTC on 14 Jul = 01:30 on 15 Jul in Paris.
  const edge = await makeOrder(h.pool, { paidAt: "2030-07-14T23:30:00Z" });
  await h.pool.query("UPDATE orders SET created_at = '2030-07-14T23:30:00Z' WHERE id = $1", [edge.order.id]);
  assert.ok(ids((await h.get("/admin/orders?from=2030-07-15&to=2030-07-15")).text).includes(edge.order.id));
  assert.ok(!ids((await h.get("/admin/orders?from=2030-07-14&to=2030-07-14")).text).includes(edge.order.id));
  // garbage dates and filters are ignored, not a 500
  assert.equal((await h.get("/admin/orders?from=nope&to=2030-13-45&show=evil&page=-4")).res.status, 200);

  const page = (await h.get("/admin/orders")).text;
  assert.match(page, /reserved, waiting for pickup/);
  assert.match(page, /paid online and not collected \(old orders\)/);
  assert.doesNotMatch(page, /refund detected|HelloAsso/i);
});

test("order list is paged by 50 and never silently capped", async () => {
  await h.pool.query(
    `INSERT INTO orders (buyer_name, buyer_email, total_amount, status, created_at)
     SELECT 'Bulk Buyer', 'bulk-' || g || '@example.test', 1, 'expired', now() - make_interval(secs => g)
     FROM generate_series(1, 230) g`
  );
  const { rows } = await h.pool.query("SELECT COUNT(*)::int AS n FROM orders");
  const total = rows[0].n;
  const pages = Math.ceil(total / 50);
  const countOn = async (p) => ((await h.get(`/admin/orders?show=all&page=${p}`)).text.match(/Order #\d+<\/strong>/g) || []).length;
  assert.equal(await countOn(1), 50);
  assert.equal(await countOn(pages), total - 50 * (pages - 1));
  const last = (await h.get(`/admin/orders?show=all&page=${pages}`)).text;
  assert.match(last, new RegExp(`Page ${pages} of ${pages}`));
  assert.match((await h.get("/admin/orders?show=all&page=2")).text, /href="\/admin\/orders\?show=all&amp;page=3"/);
  // a page far past the end shows the last page, not an empty one
  assert.match((await h.get("/admin/orders?show=all&page=99999")).text, new RegExp(`Page ${pages} of ${pages}`));
  // old orders are reachable through the search
  assert.equal(((await h.get("/admin/orders?q=bulk-230@")).text.match(/Order #\d+<\/strong>/g) || []).length, 1);
});

test("order detail of an order paid online before reservations: items, account, payment reference, Paris times, terms acceptance, history, shop refund action", async () => {
  const { rows: u } = await h.pool.query(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, 'x', 'Detail Account', now()) RETURNING id", [`detail-${h.uniq()}@example.test`]
  );
  const { order } = await makeOrder(h.pool, { books: 1, seat: true, paidAt: "2030-07-14T23:30:00Z", userId: u[0].id, intentId: "intent-detail-77" });
  await h.pool.query("UPDATE orders SET cgv_accepted_at = '2030-07-14T23:20:00Z', cgv_version = 'v-test', helloasso_order_id = 'ha-order-5' WHERE id = $1", [order.id]);
  await h.post(`/admin/orders/${order.id}/collected`);

  const { res, text } = await h.get(`/admin/orders/${order.id}`);
  assert.equal(res.status, 200);
  assert.match(text, /Fixture Drop-in seat/);
  assert.match(text, /An order from the old online checkout/);
  assert.match(text, /payment reference <code>ha-order-5<\/code>/);
  assert.match(text, /Detail Account/);
  assert.match(text, /15\/07\/2030, 01:30/, "paid time is shown in Paris time");
  assert.match(text, /15\/07\/2030, 01:20 \(version v-test\)/);
  assert.match(text, /admin log: order\.collected/);
  assert.match(text, /Mark refunded/);
  assert.match(text, /Only AFTER you gave the money back to the customer/);
  assert.doesNotMatch(text, /admin\.helloasso\.com|done in HelloAsso/);

  assert.equal((await h.get("/admin/orders/999999")).res.status, 404);
  assert.equal((await h.get("/admin/orders/abc")).res.status, 404);
  assert.equal((await h.get("/admin/orders/99999999999")).res.status, 404);
});

test("order detail of a reservation: awaiting pickup, nothing paid online, the collect actions and no refund button", async () => {
  const { order } = await makeOrder(h.pool, { status: "reserved", books: 2 });
  const { res, text } = await h.get(`/admin/orders/${order.id}`);
  assert.equal(res.status, 200);
  assert.match(text, /Reserved: awaiting pickup/);
  assert.match(text, /Nothing was paid online/);
  assert.match(text, /Mark collected and paid/);
  assert.doesNotMatch(text, /Mark refunded|HelloAsso/);
});

test("cancel unpaid order (a leftover 'pending' order): frees the books, audited, no payment lookup; any other status is left alone", async () => {
  const stuck = await makeOrder(h.pool, { status: "pending", createdMinutesAgo: 180, intentId: "intent-stuck-1" });
  const r = await h.post(`/admin/orders/${stuck.order.id}/cancel`);
  assert.match(r.res.headers.get("location"), /notice=cancelled/);
  assert.equal((await orderRow(stuck.order.id)).status, "cancelled");
  assert.deepEqual(await copyStatuses(stuck.copyIds), ["in_stock"]);
  assert.equal((await auditRows(stuck.order.id))[0].action, "order.cancelled");
  assert.deepEqual(helloassoCalls, [], "cancelling never asks HelloAsso");

  // Not pending: nothing happens (a paid order stays paid, a reservation stays reserved with its books held).
  const done = await makeOrder(h.pool, { status: "paid" });
  await h.post(`/admin/orders/${done.order.id}/cancel`);
  assert.equal((await orderRow(done.order.id)).status, "paid");
  assert.deepEqual(await copyStatuses(done.copyIds), ["sold"]);
  const res = await makeOrder(h.pool, { status: "reserved" });
  await h.post(`/admin/orders/${res.order.id}/cancel`);
  assert.equal((await orderRow(res.order.id)).status, "reserved");
  assert.deepEqual(await copyStatuses(res.copyIds), ["reserved"]);
});

test("dashboard sales use the day an order was PAID in Paris time, and leave refunded orders out", async () => {
  // Fixed clock: 15 Apr 2031 10:00 UTC = 12:00 in Paris.
  const now = new Date("2031-04-15T10:00:00Z");
  const base = { books: 1, price: 10 };
  const baseline = await salesStats(h.pool, now); // other tests in this file also leave orders in March 2031
  // 00:30 on 15 Apr in Paris (still the 14th in UTC): today and this month.
  await makeOrder(h.pool, { ...base, paidAt: "2031-04-14T22:30:00Z" });
  // 00:30 on 1 Apr in Paris (still 31 Mar in UTC): this month, NOT last month.
  await makeOrder(h.pool, { ...base, paidAt: "2031-03-31T22:30:00Z" });
  // 23:30 on 31 Mar in Paris: last month.
  await makeOrder(h.pool, { ...base, paidAt: "2031-03-31T21:30:00Z" });
  // Refunded, pending, expired: never revenue.
  const refunded = await makeOrder(h.pool, { ...base, paidAt: "2031-04-14T22:45:00Z" });
  await h.pool.query("UPDATE orders SET status = 'refunded', refunded_at = '2031-04-15T08:00:00Z' WHERE id = $1", [refunded.order.id]);
  await makeOrder(h.pool, { ...base, status: "pending" });
  await makeOrder(h.pool, { ...base, status: "expired" });

  const stats = await salesStats(h.pool, now);
  assert.equal(stats.ordersToday, 1);
  assert.equal(Number(stats.salesToday), 10);
  assert.equal(stats.ordersThisMonth, 2);
  assert.equal(Number(stats.salesThisMonth), 20);
  assert.equal(stats.ordersLastMonth - baseline.ordersLastMonth, 1);
  assert.equal(Number(stats.salesLastMonth) - Number(baseline.salesLastMonth), 10);
  assert.equal(stats.refundsThisMonth, 1);
  assert.equal(Number(stats.refundsAmountThisMonth), 10);
});

test("dashboard 'needs attention' counts and links: expiring reservations, past the deadline, paid online and uncollected 14 days, pending over 2 hours", async () => {
  const before = await attentionCounts(h.pool);
  const overdue = await makeOrder(h.pool, { paidDaysAgo: 15 });
  await makeOrder(h.pool, { paidDaysAgo: 10 }); // not yet overdue
  await makeOrder(h.pool, { paidDaysAgo: 20, collected: true }); // collected
  await makeOrder(h.pool, { status: "reserved", reservedDays: 2 }); // expiring in 3 days
  await makeOrder(h.pool, { status: "reserved", reservedDays: 9 }); // not yet
  await makeOrder(h.pool, { status: "reserved", reservedDays: -1 }); // past the deadline
  await makeOrder(h.pool, { status: "pending", createdMinutesAgo: 150 });
  await makeOrder(h.pool, { status: "pending", createdMinutesAgo: 10 });

  const after = await attentionCounts(h.pool);
  assert.equal(after.overdue - before.overdue, 1);
  assert.equal(after.expiring_soon - before.expiring_soon, 1);
  assert.equal(after.past_deadline - before.past_deadline, 1);
  assert.equal(after.stale_pending - before.stale_pending, 1);
  assert.equal(after.refund_detected, undefined, "the refund-detection count is gone");

  const { res, text } = await h.get("/admin");
  assert.equal(res.status, 200);
  assert.match(text, /id="needs-attention"/);
  assert.match(text, /href="\/admin\/orders\?show=expiring_soon"/);
  assert.match(text, /href="\/admin\/orders\?show=past_deadline"/);
  assert.match(text, /href="\/admin\/orders\?show=overdue"/);
  assert.match(text, /href="\/admin\/orders\?show=stale_pending"/);
  assert.doesNotMatch(text, /refund_detected/);
  assert.ok(overdue.order.id);
});
