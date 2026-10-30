// One source of truth for money: the Dashboard's "Sales this month", the Reports (book sales),
// End of day and the accounting export are computed from the same lines, so on one fixture they
// agree to the cent. Real app, real database.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");
const { makeOrder } = require("../helpers/orderFixtures");

let h;
before(async () => { h = await tillHarness({ port: 4353, ip: "10.81.3.3" }); });
after(async () => { await h.stop(); });

const paris = async (sql) => (await h.pool.query(`SELECT (${sql})::date::text AS d`)).rows[0].d;
const NOW_P = "now() AT TIME ZONE 'Europe/Paris'";

async function exportRows(from, to) {
  const res = await fetch(`${h.app.base}/admin/reports/accounting?from=${from}&to=${to}&format=csv`, { headers: { cookie: h.jar.header(), "x-forwarded-for": h.ip } });
  assert.equal(res.status, 200);
  const text = Buffer.from(await res.arrayBuffer()).toString("utf8").replace(/^\uFEFF/, "").trim();
  return text.split("\r\n").slice(1).map((l) => l.split("|")).map(([date, category, method, count, total]) => ({ date, category, method, count: Number(count), cents: Math.round(Number(total) * 100) }));
}
const sumCents = (rows, pred = () => true) => rows.filter(pred).reduce((a, r) => a + r.cents, 0);

async function insertTillSale({ at, method = "cash", status = "completed", lines }) {
  const total = lines.reduce((a, l) => a + l.qty * l.cents, 0);
  const { rows } = await h.pool.query(
    `INSERT INTO till_sales (staff_user_id, payment_method, total_cents, sale_token, created_at, entered_at, status) VALUES ($1, $2, $3, $4, $5, $5, $6) RETURNING id`,
    [h.adminId, method, total, h.token(), at, status]);
  for (const l of lines) {
    await h.pool.query("INSERT INTO till_sale_items (sale_id, kind, description, quantity, unit_price_cents, category) VALUES ($1, 'manual', $2, $3, $4, $5)", [rows[0].id, l.cat, l.qty, l.cents, l.cat]);
  }
  return rows[0].id;
}
const parisNoon = (day) => `${day} 12:00:00 Europe/Paris`;
const noonIso = async (day) => (await h.pool.query("SELECT ($1::timestamptz AT TIME ZONE 'UTC')::text AS t", [parisNoon(day)])).rows[0].t.replace(" ", "T") + "Z";

test("Dashboard, Reports, End of day and the accounting export agree on one fixture (this month and last month)", async () => {
  // ---- last month (direct rows: a non-book till sale, a void, an old shop sale, a refund, a membership payment)
  const d = await paris(`date_trunc('month', ${NOW_P}) - interval '1 month' + interval '14 days'`); // the 15th
  const d2 = await paris(`date_trunc('month', ${NOW_P}) - interval '1 month' + interval '15 days'`); // the 16th
  await insertTillSale({ at: parisNoon(d), method: "cash", lines: [{ cat: "merchandise", qty: 2, cents: 300 }, { cat: "other", qty: 1, cents: 500 }] }); // 11.00
  await insertTillSale({ at: parisNoon(d), method: "card", lines: [{ cat: "refreshments", qty: 1, cents: 400 }] }); // 4.00
  await insertTillSale({ at: parisNoon(d), method: "cash", status: "voided", lines: [{ cat: "donation", qty: 1, cents: 5000 }] }); // void: excluded
  const old = await h.seedBook(`Old ${h.uniq()}`);
  const oldCopy = await h.seedCopy(old.id, { status: "sold" });
  await h.pool.query("INSERT INTO shop_sales (copy_id, price, sold_at, payment_method) VALUES ($1, 7.50, $2, 'cash')", [oldCopy, parisNoon(d2)]); // 7.50, Sell in shop era
  await makeOrder(h.pool, { price: 10, paidAt: await noonIso(d) }); // 10.00 online
  const refunded = await makeOrder(h.pool, { price: 10, paidAt: await noonIso(d) });
  await h.pool.query("UPDATE orders SET status = 'refunded', refunded_at = $2 WHERE id = $1", [refunded.order.id, await noonIso(d)]); // refunded the same day: its negative row cancels the sale
  await h.pool.query("INSERT INTO membership_payments (helloasso_order_id, payer_email, amount_cents, paid_at) VALUES ($1, 'm@example.test', 1500, $2)", [Date.now(), parisNoon(d)]); // 15.00

  const first = await paris(`date_trunc('month', ${NOW_P}) - interval '1 month'`);
  const last = await paris(`date_trunc('month', ${NOW_P})::date - 1`);
  const lastRows = await exportRows(first, last);
  assert.equal(sumCents(lastRows), 4750, "11 + 4 + 7.50 + 10 + 15; the void is not in it and the refund nets to zero");

  // ---- this month (the real routes: used and new books, a manual item, a void)
  const used = await h.seedCopy((await h.seedBook(`Used ${h.uniq()}`)).id, { price: 6 });
  const fresh = await h.seedCopy((await h.seedBook(`New ${h.uniq()}`)).id, { condition: "new", price: 20, publisherPrice: 20 });
  const ok = await h.sale([h.book(used), h.book(fresh), { kind: "manual", description: "Tote", price: "3", quantity: 1, category: "merchandise" }], { received: "50" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const gone = await h.seedCopy((await h.seedBook(`Voided ${h.uniq()}`)).id, { price: 9 });
  const voided = await h.sale([h.book(gone)], { method: "card" });
  assert.equal((await h.post(`/admin/till/sales/${voided.body.saleId}/void`, { reason: "test" })).status, 302);
  await makeOrder(h.pool, { price: 10 }); // paid online today
  await h.pool.query("INSERT INTO membership_payments (helloasso_order_id, payer_email, amount_cents, paid_at) VALUES ($1, 'n@example.test', 1500, now())", [Date.now() + 1]);

  const today = await paris(NOW_P);
  const monthStart = await paris(`date_trunc('month', ${NOW_P})`);
  const rows = await exportRows(monthStart, today);
  const todayRows = rows.filter((r) => r.date === today);

  // the Dashboard
  const { salesStats } = require("../../src/lib/dashboardStats");
  const stats = await salesStats(h.pool);
  assert.equal(Math.round(stats.salesThisMonth * 100), sumCents(rows), "Sales this month = the export's total for the month");
  assert.equal(Math.round(stats.salesToday * 100), sumCents(todayRows));
  assert.equal(Math.round(stats.salesLastMonth * 100), sumCents(lastRows), "the previous-month figure is the same source");
  const b = stats.salesBreakdown;
  assert.equal(Math.round((b.till + b.online + b.membership) * 100), sumCents(rows), "Till + Online + Membership = the total");
  assert.equal(Math.round(b.membership * 100), sumCents(rows, (r) => r.category === "Membership"));
  assert.equal(Math.round(b.online * 100), sumCents(rows, (r) => r.method === "HelloAsso" && r.category !== "Membership"));
  assert.equal(Math.round(b.till * 100), sumCents(rows, (r) => r.method !== "HelloAsso"));
  // today's till: 6 + 20 + 3 = 29; online 10; membership 15
  assert.equal(sumCents(todayRows, (r) => r.method !== "HelloAsso"), 2900);
  const html = (await h.get("/admin")).text;
  assert.match(html, /Sales this month/);
  assert.ok(html.includes(`id="sales-month">&euro;${(sumCents(rows) / 100).toFixed(0)}<`), "the tile shows the export's number");
  assert.match(html, /In person &euro;\d+ &middot; Old online orders &euro;\d+ &middot; Membership &euro;\d+/);
  assert.ok(html.includes(`Last month &euro;${(sumCents(lastRows) / 100).toFixed(0)}`));

  // End of day (till sales of the day only) = the export's Cash + Card at the till rows of that day
  const eod = (await h.get(`/admin/till/day?day=${today}`)).text;
  assert.ok(eod.includes(`All sales</th><th>1</th><th>€${(sumCents(todayRows, (r) => r.method !== "HelloAsso") / 100).toFixed(2)}`), "End of day total = export till rows");
  const eodLast = (await h.get(`/admin/till/day?day=${d}`)).text;
  assert.ok(eodLast.includes(`All sales</th><th>2</th><th>€${(sumCents(lastRows, (r) => r.date === d && r.method !== "HelloAsso" && r.category !== "Membership") / 100).toFixed(2)}`), "last month's day agrees too (the void is not counted)");

  // Reports: book sales (online + shop) = the export's Books used + Books new
  const reports = require("../../src/lib/reports");
  const sales = await reports.runReport(h.pool, reports.getReport("sales"), { from: monthStart, to: today, group: "month" });
  const bookRevenue = sales.sections[0].totals.total_revenue;
  assert.equal(Math.round(bookRevenue * 100), sumCents(rows, (r) => r.category === "Books used" || r.category === "Books new"), "Reports book sales = export book rows");
  const lastSales = await reports.runReport(h.pool, reports.getReport("sales"), { from: first, to: last, group: "month" });
  assert.equal(Math.round(lastSales.sections[0].totals.total_revenue * 100), sumCents(lastRows, (r) => r.category === "Books used" || r.category === "Books new"), "last month's book rows agree");
});
