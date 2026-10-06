// End of day (/admin/till/day) and the accounting export (/admin/reports/accounting).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");
const { makeOrder } = require("../helpers/orderFixtures");
const { makeCookieJar } = require("../helpers/httpClient");

let h;
before(async () => { h = await tillHarness({ port: 4202, ip: "10.80.2.2" }); });
after(async () => { await h.stop(); });

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });

async function sellBook(price, method, { received = "100" } = {}) {
  const book = await h.seedBook(`Day Book ${h.uniq()}`);
  const c = await h.seedCopy(book.id, { price });
  const r = await h.sale([h.book(c)], { method, received });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return { saleId: r.body.saleId, copyId: c };
}

test("end of day: totals by payment method, voids excluded, expected cash = float + cash sales, close stores and locks", async () => {
  const anon = await h.get("/admin/till/day", makeCookieJar());
  assert.equal(anon.res.status, 302);
  assert.equal((await h.get("/admin/till/day?day=" + today())).res.status, 200);

  // float: validated, then saved
  const bad = await h.post("/admin/till/day/open", { openingFloat: "abc" });
  assert.match(decodeURIComponent(bad.headers.get("location")), /error=/);
  assert.equal((await h.post("/admin/till/day/open", { openingFloat: "50,50" })).status, 302);

  await sellBook(5, "cash");
  await sellBook(7.5, "cash");
  await sellBook(12, "card");
  const voided = await sellBook(20, "cash");
  await h.post(`/admin/till/sales/${voided.saleId}/void`, { reason: "oops" });

  const { text } = await h.get(`/admin/till/day?day=${today()}`);
  assert.match(text, /Cash<\/td><td>2<\/td><td>€12\.50/);
  assert.match(text, /Card<\/td><td>1<\/td><td>€12\.00/);
  assert.match(text, /All sales<\/th><th>3<\/th><th>€24\.50/);
  assert.match(text, /Voided \(not counted\)<\/td><td>1<\/td><td>€20\.00/);
  assert.match(text, /Expected cash in the drawer<\/th><th id="expected">€63\.00/, "50.50 float + 12.50 cash sales");

  // closing: counted cash required and valid
  assert.match(decodeURIComponent((await h.post("/admin/till/day/close", { day: today(), counted: "x" })).headers.get("location")), /error=/);
  assert.match(decodeURIComponent((await h.post("/admin/till/day/close", { day: "2999-01-01", counted: "10" })).headers.get("location")), /error=|day=/);
  const close = await h.post("/admin/till/day/close", { day: today(), counted: "61.50", note: "short by a coin" });
  assert.equal(close.status, 302);
  const row = (await h.pool.query("SELECT * FROM till_days WHERE day = $1", [today()])).rows[0];
  assert.deepEqual([row.opening_float_cents, row.counted_cash_cents, row.expected_cash_cents, row.difference_cents, row.closed_by, row.note], [5050, 6150, 6300, -150, h.adminId, "short by a coin"]);
  assert.ok(row.closed_at);
  const closed = (await h.get(`/admin/till/day?day=${today()}`)).text;
  assert.match(closed, /CLOSED/);
  assert.match(closed, /Short by €1\.50/);
  assert.match(closed, /short by a coin/);
  assert.equal((await h.audit("till.day_close")).length, 1);

  // closed: no second close, no float change, no more voids
  assert.match(decodeURIComponent((await h.post("/admin/till/day/close", { day: today(), counted: "63" })).headers.get("location")), /already closed/);
  assert.match(decodeURIComponent((await h.post("/admin/till/day/open", { openingFloat: "1" })).headers.get("location")), /already closed/);
  const later = await sellBook(4, "cash");
  const v = await h.post(`/admin/till/sales/${later.saleId}/void`, { reason: "late" });
  assert.match(decodeURIComponent(v.headers.get("location")), /day is closed/);
  assert.equal((await h.copy(later.copyId)).status, "sold");
  assert.match((await h.get(`/admin/till/day?day=${today()}`)).text, /1 sale\(s\) were made after the day was closed/);
  assert.doesNotMatch((await h.get("/admin/till")).text, /Void sale/, "no void buttons on a closed day");
});

test("end of day CSV: BOM, one row per sale, no customer data; audited, not cached", async () => {
  const res = await fetch(`${h.app.base}/admin/till/day?day=${today()}&format=csv`, { headers: { cookie: h.jar.header(), "x-forwarded-for": h.ip } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const body = Buffer.from(await res.arrayBuffer()).toString("utf8"); // keeps the BOM (fetch text() drops it)
  assert.ok(body.startsWith("\uFEFF"));
  assert.match(body, /"Sale","Time \(Paris\)","Payment method"/);
  assert.match(body, /"voided"/);
  assert.doesNotMatch(body, /@/);
  assert.equal((await h.audit("till.day_csv")).length, 1);
});

test("a past day with sales that was never closed shows in Needs attention until it is closed", async () => {
  const r = await sellBook(3, "cash");
  await h.pool.query("UPDATE till_sales SET created_at = now() - interval '3 days' WHERE id = $1", [r.saleId]);
  const past = (await h.pool.query("SELECT (created_at AT TIME ZONE 'Europe/Paris')::date::text AS d FROM till_sales WHERE id = $1", [r.saleId])).rows[0].d;
  const dash = (await h.get("/admin")).text;
  assert.match(dash, new RegExp(`/admin/till/day\\?day=${past}`));
  assert.match(dash, /never closed/);
  assert.match((await h.get("/admin/till/day")).text, /Never closed/);
  assert.equal((await h.post("/admin/till/day/close", { day: past, counted: "0" })).status, 302);
  assert.doesNotMatch((await h.get("/admin")).text, new RegExp(`day=${past}`));
});

// ---------- accounting export ----------

const csvRows = (text) => text.replace(/^\uFEFF/, "").trim().split("\r\n").slice(1).map((l) => l.split(","));
async function exportCsv(from, to) {
  const res = await fetch(`${h.app.base}/admin/reports/accounting?from=${from}&to=${to}&format=csv`, { headers: { cookie: h.jar.header(), "x-forwarded-for": h.ip } });
  return { res, text: Buffer.from(await res.arrayBuffer()).toString("utf8") };
}
async function insertTillSale({ at, method = "cash", status = "completed", lines }) {
  const total = lines.reduce((a, l) => a + l.qty * l.cents, 0);
  const { rows } = await h.pool.query(
    `INSERT INTO till_sales (staff_user_id, payment_method, total_cents, sale_token, created_at, status) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [h.adminId, method, total, h.token(), at, status]
  );
  for (const l of lines) {
    await h.pool.query(
      "INSERT INTO till_sale_items (sale_id, kind, description, quantity, unit_price_cents, category) VALUES ($1, 'manual', $2, $3, $4, $5)",
      [rows[0].id, l.cat, l.qty, l.cents, l.cat]
    );
  }
  return rows[0].id;
}

test("accounting export: categories and methods, no personal data, voided and refunded excluded, linked from Reports", async () => {
  const D = "2031-05-10"; // a quiet day, far from the other tests' data
  assert.match((await h.get("/admin/reports")).text, /Accounting export/);
  await insertTillSale({ at: `${D}T10:00:00+02:00`, lines: [{ cat: "books_used", qty: 3, cents: 500 }, { cat: "merchandise", qty: 2, cents: 750 }] });
  await insertTillSale({ at: `${D}T11:00:00+02:00`, method: "card", lines: [{ cat: "books_new", qty: 1, cents: 1900 }, { cat: "refreshments", qty: 1, cents: 250 }, { cat: "donation", qty: 1, cents: 1000 }, { cat: "books_other", qty: 1, cents: 300 }] });
  await insertTillSale({ at: `${D}T12:00:00+02:00`, status: "voided", lines: [{ cat: "books_used", qty: 9, cents: 900 }] });
  // an older "Sell in shop" sale (no till sale)
  const book = await h.seedBook(`Legacy ${h.uniq()}`);
  const legacyCopy = await h.seedCopy(book.id, { status: "sold", price: 4 });
  await h.pool.query("INSERT INTO shop_sales (copy_id, price, sold_at, payment_method) VALUES ($1, 4, $2, 'card')", [legacyCopy, `${D}T13:00:00+02:00`]);
  // online: a paid order (1 used book + 1 seat), a refunded one (excluded)
  await makeOrder(h.pool, { status: "paid", paidAt: `${D}T14:00:00+02:00`, books: 1, seat: true, price: 6, name: "Secret Buyer", email: "secret-buyer@example.test" });
  await makeOrder(h.pool, { status: "refunded", paidAt: `${D}T14:30:00+02:00`, books: 2, price: 6 });
  // membership
  await h.pool.query("INSERT INTO membership_payments (helloasso_order_id, payer_email, amount_cents, paid_at) VALUES (990001, 'payer-secret@example.test', 2000, $1)", [`${D}T15:00:00+02:00`]);
  await h.pool.query("INSERT INTO membership_payments (helloasso_order_id, payer_email, amount_cents, paid_at) VALUES (990002, 'no-amount@example.test', NULL, $1)", [`${D}T15:30:00+02:00`]);

  const { res, text } = await exportCsv(D, D);
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /text\/csv/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.ok(text.startsWith("\uFEFF"));
  assert.match(text, /^\uFEFF"Date","Category","Payment method","Count","Total \(EUR\)"/);
  assert.doesNotMatch(text, /@|Secret|secret|Total"/, "no emails, names, and no totals row in the import file");
  const rows = csvRows(text).map((r) => r.map((c) => c.replace(/"/g, "")));
  const get = (cat, method) => rows.find((r) => r[1] === cat && r[2] === method);
  assert.deepEqual(get("Books used", "Cash"), [D, "Books used", "Cash", "3", "15.00"]);
  assert.deepEqual(get("Merchandise", "Cash"), [D, "Merchandise", "Cash", "2", "15.00"]);
  assert.deepEqual(get("Books new", "Card at the till"), [D, "Books new", "Card at the till", "1", "19.00"]);
  assert.deepEqual(get("Refreshments", "Card at the till"), [D, "Refreshments", "Card at the till", "1", "2.50"]);
  assert.deepEqual(get("Donation", "Card at the till"), [D, "Donation", "Card at the till", "1", "10.00"]);
  assert.deepEqual(get("Other", "Card at the till"), [D, "Other", "Card at the till", "1", "3.00"], "'Books (other)' goes to Other");
  // legacy shop sale: used book, card => joins "Books used / Card at the till"
  assert.deepEqual(get("Books used", "Card at the till"), [D, "Books used", "Card at the till", "1", "4.00"]);
  assert.deepEqual(get("Books used", "HelloAsso"), [D, "Books used", "HelloAsso", "1", "6.00"]);
  assert.deepEqual(get("Class seats", "HelloAsso"), [D, "Class seats", "HelloAsso", "1", "6.00"]);
  assert.deepEqual(get("Membership", "HelloAsso"), [D, "Membership", "HelloAsso", "1", "20.00"]);
  assert.equal(rows.length, 10, "nothing else: voided till sale and refunded order are excluded");
  // sorted by the category order
  assert.deepEqual(rows.map((r) => r[1]).filter((c, i, a) => a.indexOf(c) === i), ["Books used", "Books new", "Merchandise", "Refreshments", "Class seats", "Membership", "Donation", "Other"]);
  assert.equal((await h.audit("report.csv")).filter((a) => a.detail === "accounting").length, 1);
  const page = await h.get(`/admin/reports/accounting?from=${D}&to=${D}`);
  assert.match(page.text, /no amount recorded/);
  assert.doesNotMatch(page.text, /secret/i);
});

test("accounting export: Paris day boundaries at 23:59 / 00:00, and across both DST changes", async () => {
  // [instant (UTC), expected Paris day]
  const cases = [
    ["2032-01-14T22:59:59Z", "2032-01-14"], ["2032-01-14T23:00:00Z", "2032-01-15"], // winter, +01:00
    ["2032-07-14T21:59:59Z", "2032-07-14"], ["2032-07-14T22:00:00Z", "2032-07-15"], // summer, +02:00
    ["2032-03-27T22:59:59Z", "2032-03-27"], ["2032-03-27T23:00:00Z", "2032-03-28"], // the day the clocks go forward (28 March 2032)
    ["2032-03-28T21:59:59Z", "2032-03-28"], ["2032-03-28T22:00:00Z", "2032-03-29"], // that day is 23 hours long
    ["2032-10-30T21:59:59Z", "2032-10-30"], ["2032-10-30T22:00:00Z", "2032-10-31"], // the day the clocks go back (31 October 2032)
    ["2032-10-31T22:59:59Z", "2032-10-31"], ["2032-10-31T23:00:00Z", "2032-11-01"], // that day is 25 hours long
  ];
  for (const [at] of cases) await insertTillSale({ at, lines: [{ cat: "merchandise", qty: 1, cents: 100 }] });
  const { text } = await exportCsv("2032-01-01", "2032-12-31");
  const byDay = {};
  for (const r of csvRows(text)) byDay[r[0].replace(/"/g, "")] = Number(r[3]);
  const expected = {};
  for (const [, day] of cases) expected[day] = (expected[day] || 0) + 1;
  assert.deepEqual(byDay, expected);
  // the range itself is in Paris days: a one-day range holds exactly that day's sales
  const one = await exportCsv("2032-03-28", "2032-03-28");
  assert.deepEqual(csvRows(one.text).map((r) => r[0].replace(/"/g, "")), ["2032-03-28"]);
  assert.equal(csvRows(one.text)[0][3], "2");
});

test("accounting export needs an admin", async () => {
  const { res } = await h.get("/admin/reports/accounting?format=csv", makeCookieJar());
  assert.equal(res.status, 302);
});
