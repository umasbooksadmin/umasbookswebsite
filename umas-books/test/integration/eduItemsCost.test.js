// Educational items: the COST per unit (migration 115), end to end on the real app and database.
//   - Admin > Educational items: an optional "Cost per unit (what we paid)", comma or point, validated like the price,
//     shown in the list with the margin per unit; every change audited ("cost €1.20 -> €1.35", "not known");
//   - never on a customer page (Browse Educational Items EN/FR, the sitemap);
//   - a reservation copies the cost onto its order lines (order_items.unit_cost): changing the item's cost later
//     never changes a past sale;
//   - the Sales report's "cost and margin" table: known / unknown / mixed costs, a pickup discount (revenue after
//     discount), unknown never counted as zero, and the existing tables unchanged;
//   - the Accounting export: the export rows and their CSV are byte for byte the same whatever the costs; the cost of
//     the items sold is a separate MEMO table (its own CSV in the house format) and memo lines in the monthly summary
//     and email; a till collection and a refund give the memo's sale and negative refund rows.
// Port 5115.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");
const { makeCookieJar } = require("../helpers/httpClient");

let h, cart, accounting, reports, ax;
before(async () => {
  h = await tillHarness({ port: 5115, ip: "10.51.15.1" });
  cart = require("../../src/lib/cart");
  accounting = require("../../src/lib/accounting");
  reports = require("../../src/lib/reports");
  ax = require("../../src/lib/accountingExport");
  assert.equal((await h.post("/admin/till/day/open", { openingFloat: "50" })).status, 302);
});
after(async () => { await h.stop(); });

const genreId = async () => (await h.pool.query("SELECT id FROM edu_genres WHERE slug = 'worksheets'")).rows[0].id;
async function makeItem({ name = `Cost ${h.uniq()}`, price = 4.5, cost = null, stock = 20 } = {}) {
  const { rows } = await h.pool.query("INSERT INTO edu_items (name, price, cost, stock, genre_id) VALUES ($1, $2, $3, $4, $5) RETURNING *", [name, price, cost, stock, await genreId()]);
  return rows[0];
}
async function buyer() {
  const { rows } = await h.pool.query(
    "INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, 'x', 'Cost Buyer', now()) RETURNING id, email", [`cost-${h.uniq()}@example.test`]);
  return rows[0];
}
const eduLine = (item, qty) => ({ kind: "edu", eduItemId: item.id, qty, title: item.name, price: Number(item.price) });
const reserve = async (items) => cart.createReservation(h.pool, { user: await buyer(), name: "Cost Buyer", items, acceptedVersion: "v", hasDropin: false });
const costs = async (orderId) => (await h.pool.query("SELECT unit_cost FROM order_items WHERE order_id = $1 ORDER BY id", [orderId])).rows.map((r) => (r.unit_cost == null ? null : Number(r.unit_cost)));
// Collect with the admin button (amountReceived below the list price = a pickup discount), then move the sale to a past
// Paris day of its own, so each scenario's report and export are exactly its own numbers.
async function collectOn(order, day, amountReceived) {
  const res = await h.post(`/admin/orders/${order.id}/collect`, { method: "cash", ...(amountReceived ? { amountReceived, note: "loyalty" } : {}) });
  assert.equal(res.status, 302);
  await h.pool.query("UPDATE orders SET paid_at = ($2::date + time '12:00') AT TIME ZONE 'Europe/Paris', collected_at = ($2::date + time '12:00') AT TIME ZONE 'Europe/Paris' WHERE id = $1", [order.id, day]);
}
const sales = (day) => reports.REPORTS.find((r) => r.slug === "sales").run(h.pool, { from: day, to: day, group: "day" });
const section = (rep, key) => rep.sections.find((s) => s.key === key);
const editForm = (item, extra) => ({ name: item.name, price: Number(item.price).toFixed(2), stock: String(item.stock), genreId: String(item.genre_id), sortOrder: "0", ...extra });
const costOf = async (id) => { const c = (await h.pool.query("SELECT cost FROM edu_items WHERE id = $1", [id])).rows[0].cost; return c == null ? null : Number(c); };

test("admin: the cost is optional, validated like the price, shown with the margin per unit, and every change is audited", async () => {
  const name = `Cost Admin ${h.uniq()}`;
  let res = await h.post("/admin/edu-items", { name, price: "4,50", cost: "-1", stock: "5", genreId: String(await genreId()), sortOrder: "0" });
  assert.match(await res.text(), /The cost cannot be negative\. Leave it empty if you do not know it\. Nothing was saved\./);
  assert.equal((await h.pool.query("SELECT 1 FROM edu_items WHERE name = $1", [name])).rows.length, 0, "nothing saved");
  res = await h.post("/admin/edu-items", { name, price: "4,50", cost: "abc", stock: "5", genreId: String(await genreId()), sortOrder: "0" });
  const refused = await res.text();
  assert.match(refused, /Enter the cost per unit in euros, like 1\.85 or 1,85/);
  assert.match(refused, /id="edu-cost"[^>]*value="abc"/, "the form keeps what was typed");

  await h.post("/admin/edu-items", { name, price: "4,50", cost: "1,20", stock: "5", genreId: String(await genreId()), sortOrder: "0" });
  const item = (await h.pool.query("SELECT * FROM edu_items WHERE name = $1", [name])).rows[0];
  assert.equal(Number(item.cost), 1.2);
  assert.match((await h.audit("edu_item.add")).pop().detail, /€4\.50, cost €1\.20, stock 5/);

  const edits = async () => (await h.audit("edu_item.edit")).filter((a) => a.target_id === item.id).map((a) => a.detail);
  await h.post(`/admin/edu-items/${item.id}`, editForm(item, { cost: "1.35" }));
  assert.equal(await costOf(item.id), 1.35);
  await h.post(`/admin/edu-items/${item.id}`, editForm(item, { cost: "" }));
  assert.equal(await costOf(item.id), null, "blank = not known");
  await h.post(`/admin/edu-items/${item.id}`, editForm(item, { cost: "1,35" }));
  await h.post(`/admin/edu-items/${item.id}`, editForm(item, { cost: "1.35", stock: "6" }));
  res = await h.post(`/admin/edu-items/${item.id}`, editForm(item, { cost: "1.355" }));
  assert.match(await res.text(), /The cost can have at most 2 decimals/);
  assert.equal(await costOf(item.id), 1.35, "a refused cost changes nothing");
  assert.deepEqual(await edits(), ["cost €1.20 -> €1.35", "cost €1.35 -> not known", "cost not known -> €1.35", "stock 5 -> 6"]);

  const list = (await h.get("/admin/edu-items")).text;
  const row = list.slice(list.indexOf(`/admin/edu-items/${item.id}/edit">${name}`));
  assert.match(row.slice(0, 1500), /class="edu-cost">&euro;1\.35<\/td>/);
  assert.match(row.slice(0, 1500), /class="edu-margin">&euro;3\.15 <span class="muted small">\(70%\)<\/span>/, "price 4.50 - cost 1.35 = 3.15, 70% of the price");
  assert.match(list, /<th scope="col">Cost per unit<\/th><th scope="col">Margin per unit<\/th>/);
  const unknown = await makeItem({ name: `Cost Unknown ${h.uniq()}`, price: 2 });
  const list2 = (await h.get("/admin/edu-items")).text;
  const row2 = list2.slice(list2.indexOf(`/admin/edu-items/${unknown.id}/edit">`));
  assert.match(row2.slice(0, 1500), /class="edu-cost"><span class="muted small">not known<\/span>/);
  const form = (await h.get(`/admin/edu-items/${item.id}/edit`)).text;
  assert.match(form, /Cost per unit \(what we paid, euros, optional\)/);
  assert.match(form, /id="edu-cost"[^>]*value="1\.35"/);
});

test("customers never see the cost: Browse Educational Items (EN/FR) and the sitemap", async () => {
  // Distinctive numbers: price 6.40, cost 2.73, margin 3.67.
  await makeItem({ name: `Cost Hidden ${h.uniq()}`, price: 6.4, cost: 2.73 });
  const SECRET = /2[.,]73|3[.,]67/;
  for (const path of ["/educational-items.html", "/fr/educational-items.html", "/sitemap.xml"]) {
    const jar = makeCookieJar();
    const res = await fetch(`${h.app.base}${path}`, { headers: { cookie: jar.header(), "x-forwarded-for": "10.51.15.9" } });
    const text = await res.text();
    assert.equal(res.status, 200, path);
    if (path !== "/sitemap.xml") assert.match(text, /6[.,]40/, `${path} shows the price`);
    assert.doesNotMatch(text, SECRET, `${path} never shows the cost or the margin`);
  }
});

test("a reservation keeps the cost of the day: changing the item's cost later never changes a past sale or its margin", async () => {
  const day = "2025-01-10";
  const item = await makeItem({ price: 5, cost: 2 });
  const first = await reserve([eduLine(item, 2)]);
  assert.deepEqual(await costs(first.id), [2, 2]);
  // The admin raises the cost: the existing reservation keeps 2.00, a new one gets 3.00.
  await h.post(`/admin/edu-items/${item.id}`, editForm(item, { cost: "3" }));
  const second = await reserve([eduLine(item, 1)]);
  assert.deepEqual(await costs(first.id), [2, 2], "the old reservation still has the old cost");
  assert.deepEqual(await costs(second.id), [3]);
  await collectOn(first, day);
  await collectOn(second, day);
  const m1 = section(await sales(day), "educational_margin").totals;
  assert.equal(m1.items, 3);
  assert.equal(m1.revenue, 15);
  assert.equal(m1.cost, 7, "2 + 2 + 3");
  assert.equal(m1.margin, 8);
  // Later edits (a new cost, or "not known") change nothing for those sales.
  await h.post(`/admin/edu-items/${item.id}`, editForm(item, { cost: "9" }));
  await h.post(`/admin/edu-items/${item.id}`, editForm(item, { cost: "" }));
  const m2 = section(await sales(day), "educational_margin");
  assert.deepEqual(m2.totals, m1);
  assert.match(m2.note, /Every unit sold in this range has a known cost\./);
});

test("Sales report: known, unknown and mixed costs, with a pickup discount; unknown is never counted as zero", async () => {
  // Day 1: only unknown costs. Day 2: mixed, with a 2.00 discount on a 10.00 reservation.
  const unknownDay = "2025-01-11";
  const mixedDay = "2025-01-12";
  const u = await makeItem({ price: 4, cost: null });
  const k = await makeItem({ price: 3, cost: 1 });
  await collectOn(await reserve([eduLine(u, 2)]), unknownDay);
  const mixed = await reserve([eduLine(k, 2), eduLine(u, 1)]); // 6.00 known + 4.00 unknown = 10.00
  assert.deepEqual(await costs(mixed.id), [1, 1, null]);
  await collectOn(mixed, mixedDay, "8"); // 2.00 off

  const onlyUnknown = section(await sales(unknownDay), "educational_margin");
  assert.deepEqual(onlyUnknown.rows, [{ period: unknownDay, items: 2, revenue: 8, known_items: 0, known_revenue: null, cost: null, margin: null, margin_pct: null, unknown_items: 2 }]);
  assert.match(onlyUnknown.note, /Cost unknown for 2 units \(sold for €8\.00 after discounts\): they are NOT counted as zero cost/);
  assert.match(onlyUnknown.note, /for the 0 units with a known cost only/);

  const rep = await sales(mixedDay);
  const m = section(rep, "educational_margin");
  // The discount (200 cents, all on educational items) is shared in proportion to list price: the known-cost units
  // (600 of 1000) carry round(200 * 600 / 1000) = 120.
  assert.deepEqual(m.rows, [{ period: mixedDay, items: 3, revenue: 8, known_items: 2, known_revenue: 4.8, cost: 2, margin: 2.8, margin_pct: (100 * 2.8) / 4.8, unknown_items: 1 }]);
  assert.equal(m.totals.margin, 2.8);
  assert.match(m.note, /Cost unknown for 1 unit \(sold for €3\.20 after discounts\)/);
  assert.match(m.note, /margin is for the 2 units with a known cost only/);
  assert.deepEqual(m.columns.map((c) => c.label), ["Period", "Items sold", "Revenue after discounts", "Items with known cost", "Revenue of known-cost items", "Cost of known-cost items", "Margin (known-cost items only)", "Margin % (known-cost items only)", "Items with cost unknown"]);
  // The existing Educational items table is unchanged, and the margin table's revenue is its total revenue.
  const edu = section(rep, "educational");
  assert.deepEqual(edu.totals, { period: "Total", items: 3, revenue: 10, discounts: -2, total_revenue: 8 });
  assert.equal(m.totals.revenue, edu.totals.total_revenue);
  assert.deepEqual(rep.sections.map((s) => s.key), ["books", "dropin", "educational", "educational_margin", "refunds"]);
  // The CSV of the margin table: house format, a blank cell (never 0) where the cost is unknown.
  const csv = reports.toCsv(onlyUnknown);
  assert.ok(csv.startsWith("\uFEFFPeriod|Items sold|Revenue after discounts|"));
  assert.ok(csv.includes(`\r\n${unknownDay}|2|8.00|0|||||2\r\n`), JSON.stringify(csv));
});

test("Accounting export: the export rows are unchanged whatever the costs; the cost is a separate memo table with its own CSV", async () => {
  const day = "2025-01-12"; // the mixed reservation of the test above: 3 units, cost 2.00 known, 1 unknown
  const run = () => accounting.accountingExportReport(h.pool, { from: day, to: day, noStaleness: true });
  const rep = await run();
  assert.deepEqual(rep.sections.map((s) => s.key), ["export", "edu_cost"]);
  const exportCsv = reports.toCsv(rep.sections[0]);
  assert.equal(exportCsv.replace(/^\uFEFF/, "").split("\r\n")[0], ax.ACCOUNTING_HEADER.join("|"));
  assert.ok(!/cost/i.test(exportCsv), "nothing about cost in the export");
  const memo = rep.sections[1];
  assert.deepEqual(memo.rows, [{ date: day, category: "Educational items", kind: "Sold", units: 3, costCents: 200, cost: 2, unknown: 1, refund: false }]);
  assert.match(memo.title, /^Memo \(not an accounting entry, not in the export above\)/);
  assert.match(memo.note, /Cost unknown for 1 unit\(s\): they are NOT counted as zero/);
  assert.match(memo.note, /Suggestion, to be confirmed by the accountant: .*account 607 \(Achats de marchandises\)/);
  const memoCsv = reports.toCsv(memo);
  assert.equal(memoCsv, `\uFEFFDate|Category|Kind|Units|Cost of units (EUR)|Units with cost unknown\r\n${day}|Educational items|Sold|3|2.00|1\r\n`);

  // Byte for byte: wiping or changing every cost changes nothing in the export rows.
  const saved = (await h.pool.query("SELECT id, unit_cost FROM order_items WHERE edu_item_id IS NOT NULL")).rows;
  await h.pool.query("UPDATE order_items SET unit_cost = NULL WHERE edu_item_id IS NOT NULL");
  const wiped = await run();
  assert.equal(reports.toCsv(wiped.sections[0]), exportCsv);
  assert.deepEqual(wiped.sections[0].totals, rep.sections[0].totals);
  assert.deepEqual(wiped.sections[1].rows.map((r) => [r.units, r.cost, r.unknown]), [[3, 0, 3]]);
  await h.pool.query("UPDATE order_items SET unit_cost = 99 WHERE edu_item_id IS NOT NULL");
  assert.equal(reports.toCsv((await run()).sections[0]), exportCsv);
  for (const s of saved) await h.pool.query("UPDATE order_items SET unit_cost = $2 WHERE id = $1", [s.id, s.unit_cost]);

  // Over HTTP: the default download is still the export; ?table=edu_cost is the memo.
  const q = `from=${day}&to=${day}&group=month`;
  const dflt = await h.get(`/admin/reports/accounting?format=csv&${q}`);
  assert.equal(dflt.text.replace(/^\uFEFF/, ""), exportCsv.replace(/^\uFEFF/, ""));
  const memoHttp = await h.get(`/admin/reports/accounting?format=csv&table=edu_cost&${q}`);
  assert.equal(memoHttp.text.replace(/^\uFEFF/, ""), memoCsv.replace(/^\uFEFF/, ""));
  assert.match(memoHttp.res.headers.get("content-disposition"), /umas-books-accounting-edu_cost-/);
  const page = (await h.get(`/admin/reports/accounting?${q}`)).text;
  assert.match(page, /Memo \(not an accounting entry, not in the export above\): cost of educational items sold/);
});

test("monthly export: the memo is in the summary and the email only when educational items were sold; the accounting CSV is unchanged", async () => {
  const range = ax.monthRange("2025-01");
  const built = await ax.buildExport(h.pool, range);
  assert.equal(built.accountingCsv, reports.toCsv((await accounting.accountingExportReport(h.pool, { from: range.from, to: range.to, noStaleness: true })).sections[0]));
  assert.ok(!/cost/i.test(built.accountingCsv));
  // 2025-01: day 10 (3 units, cost 7.00), day 11 (2 units unknown), day 12 (3 units, 2.00 known, 1 unknown).
  assert.match(built.summary, /MEMO, not an accounting entry and not in the totals above: cost of educational items sold/);
  assert.match(built.summary, /Units sold \(refunds deducted\): 8\r\n/);
  assert.match(built.summary, /Cost of those units \(EUR, as recorded when reserved\): 9,00\r\n/);
  assert.match(built.summary, /Units with cost unknown \(not counted as zero, so the cost above is too low by their cost\): 3\r\n/);
  assert.match(built.summary, /account 607 \(Achats de marchandises\)/);
  assert.deepEqual(built.stats.eduCost, { units: 8, cents: 900, unknown: 3 });
  assert.match(ax.emailBody(range, built.stats), /Memo \(not in the accounting file\): cost of educational items sold 9,00 EUR for 8 unit\(s\), cost unknown for 3 unit\(s\)\./);
  // A month with no educational sale: no memo anywhere (the summary and email are what they always were).
  const empty = await ax.buildExport(h.pool, ax.monthRange("2024-06"));
  assert.doesNotMatch(empty.summary, /MEMO|educational/i);
  assert.equal(empty.stats.eduCost, null);
  assert.doesNotMatch(ax.emailBody(ax.monthRange("2024-06"), empty.stats), /Memo|educational/i);
});

test("memo: a reservation collected at the till is dated by the till sale; a refund gives a negative row on the refund day", async () => {
  const today = (await h.pool.query("SELECT (now() AT TIME ZONE 'Europe/Paris')::date::text AS d")).rows[0].d;
  const memoToday = async () => (await accounting.eduCostMemoRows(h.pool, today, today));
  const sum = (rows, refund) => rows.filter((r) => r.refund === refund).reduce((a, r) => ({ units: a.units + r.units, cents: a.cents + r.costCents, unknown: a.unknown + r.unknown }), { units: 0, cents: 0, unknown: 0 });
  const item = await makeItem({ price: 5.5, cost: 1.1 });
  const order = await reserve([eduLine(item, 2)]);
  const before = await memoToday();
  const scan = await h.scan(`ORDER-${order.id}`);
  const sale = await h.sale(scan.body.lines.map((x) => ({ kind: "reserved", orderId: x.orderId, itemId: x.itemId, expected: x.priceCents })), { method: "cash", received: "20" });
  assert.equal(sale.status, 200, JSON.stringify(sale.body));
  const afterSale = await memoToday();
  assert.deepEqual(sum(afterSale, false), { units: sum(before, false).units + 2, cents: sum(before, false).cents + 220, unknown: sum(before, false).unknown });
  const ref = await actions().markOrderRefunded(h.pool, order.id, { note: "changed mind", refundMethod: "cash" });
  assert.equal(ref.outcome, "refunded");
  const afterRefund = await memoToday();
  assert.deepEqual(sum(afterRefund, false), sum(afterSale, false), "the sale row stays");
  assert.deepEqual(sum(afterRefund, true), { units: sum(afterSale, true).units - 2, cents: sum(afterSale, true).cents - 220, unknown: 0 });
  assert.ok(afterRefund.some((r) => r.refund && r.kind === "Refund (units back in stock)"));
});

const actions = () => require("../../src/lib/orderActions");
