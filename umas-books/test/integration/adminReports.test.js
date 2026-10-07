// Admin Reports (/admin/reports): admin-only, eight reports with totals that
// match hand-computed numbers from seeded data, CSV downloads (BOM, quoting,
// formula-injection escaping, audit row), date-range and group filters, and no
// member emails anywhere. Runs on its own throwaway database so the global
// counts below are exact.
//
// Seed (all money in euros). Sales/intake use fixed 2024 dates so the numbers
// never depend on today; the stock reports use dates relative to today.
//
// Stock now (in_stock unless noted), genre = first word of categories:
//   c1 Fantasy very_good    5.00  A1   donation  10 days ago
//   c2 Fantasy very_good    7.50  A1   purchase  120 days ago
//   c3 Cooking  new      20.00  -    unknown   250 days ago
//   c4 Cooking acceptable    3.00  B2   lot       500 days ago (reserved)
//   c5 "=cmd"   like_new  4.00  A1   donation  800 days ago
//   c9 fantasy very_good    2.00  -    unknown   700 days ago
// Sales / sell-through (2024), see the comments next to the expectations.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const bcrypt = require("bcryptjs");
const { startTestApp } = require("../helpers/testApp");
const { makeCookieJar, fetchCsrfToken } = require("../helpers/httpClient");

const PORT = 3790;
const PASSWORD = "Reports-Test-1!";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const Y2024 = "from=2024-01-01&to=2024-12-31";

let app;
let pool;
let jar;
const emails = [];

before(async () => {
  app = await startTestApp({ port: PORT, isolated: true });
  process.env.DATABASE_URL = app.databaseUrl;
  process.env.PGSSLMODE = process.env.PGSSLMODE || "disable";
  ({ pool } = require("../../src/db"));
  const admin = await makeUser("Reports Admin", { admin: true, member: true });
  jar = await login(admin.email);
  await seed();
});

after(async () => {
  await pool.end();
  app.stop();
});

let n = 0;
async function makeUser(name, { admin = false, member = false, expires = null } = {}) {
  const email = `rep-${Date.now()}-${++n}@example.test`;
  emails.push(email);
  const { rows } = await pool.query(
    `INSERT INTO users (email, password_hash, display_name, is_admin, is_member, member_expires_at, email_verified_at)
     VALUES ($1, $2, $3, $4, $5, $6, now()) RETURNING id`,
    [email, await bcrypt.hash(PASSWORD, 4), name, admin, member, expires]
  );
  return { id: rows[0].id, email };
}

async function login(email) {
  const j = makeCookieJar();
  const token = await fetchCsrfToken(app.base, j);
  const res = await fetch(`${app.base}/login`, {
    method: "POST", redirect: "manual",
    headers: { ...FORM, cookie: j.header(), "x-forwarded-for": "10.79.0.1" },
    body: new URLSearchParams({ email, password: PASSWORD, _csrf: token }).toString(),
  });
  j.capture(res);
  assert.equal(res.status, 302);
  return j;
}

async function get(path, useJar = jar) {
  const res = await fetch(`${app.base}${path}`, { redirect: "manual", headers: { cookie: useJar.header(), "x-forwarded-for": "10.79.0.1" } });
  return { res, text: await res.text() };
}

const parisToday = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
function daysAgo(k) {
  const [y, m, d] = parisToday().split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d - k)).toISOString().slice(0, 10);
}

async function book(title, categories) {
  const { rows } = await pool.query("INSERT INTO books (title, authors, categories) VALUES ($1, 'Some Author', $2) RETURNING id", [title, categories]);
  return rows[0].id;
}
async function copy(bookId, o) {
  const { rows } = await pool.query(
    `INSERT INTO book_copies (book_id, condition, price, publisher_price, status, location, source, acquisition_cost, acquired_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [bookId, o.condition || "very_good", o.price, o.publisherPrice || null, o.status || "in_stock", o.location || null, o.source || null,
      o.cost === undefined ? null : o.cost, o.acquired, o.created]
  );
  return rows[0].id;
}
async function order(status, paidAt, items) {
  const { rows } = await pool.query(
    "INSERT INTO orders (buyer_name, buyer_email, total_amount, status, paid_at) VALUES ('Secret Buyer', 'buyer-secret@example.test', 1, $1, $2) RETURNING id",
    [status, paidAt]
  );
  for (const it of items) {
    let seatId = null;
    if (it.dropin) {
      const cls = await pool.query("INSERT INTO classes (title, starts_at) VALUES ('Class', now()) RETURNING id");
      const seat = await pool.query("INSERT INTO class_dropin_seats (class_id, status, order_id) VALUES ($1, 'sold', $2) RETURNING id", [cls.rows[0].id, rows[0].id]);
      seatId = seat.rows[0].id;
    }
    await pool.query(
      "INSERT INTO order_items (order_id, book_copy_id, class_dropin_seat_id, item_title, price) VALUES ($1, $2, $3, 'item', $4)",
      [rows[0].id, it.copy || null, seatId, it.price]
    );
  }
  return rows[0].id;
}

async function seed() {
  const fantasy = await book("Fantasy Tale", "Fantasy, Fiction");
  const cooking = await book("Cook Book", "Cooking");
  // Sold / withdrawn copies (2024).
  const c6 = await copy(fantasy, { price: 6, status: "sold", source: "donation", acquired: "2024-03-01", created: "2024-03-01" });
  const c7 = await copy(cooking, { price: 8, status: "sold", source: "donation", acquired: "2024-03-05", created: "2024-03-05" });
  const c10 = await copy(cooking, { price: 9, status: "sold", source: "purchase", acquired: "2024-04-10", created: "2024-04-10", cost: 4 });
  const c11 = await copy(fantasy, { price: 5, status: "sold", source: "purchase", acquired: "2024-02-01", created: "2024-02-01", cost: 1.5 });
  const c12 = await copy(cooking, { price: 3, status: "damaged", acquired: "2024-02-15", created: "2024-02-15" });
  const c13 = await copy(fantasy, { price: 4, status: "sold", source: "other", acquired: "2024-03-20", created: "2024-03-20", cost: 1 });
  // Online: c6 + a drop-in seat on 10 March; c10 on 20 April + a drop-in seat; a pending order and a cancelled one never count.
  await order("paid", "2024-03-10T12:00:00Z", [{ copy: c6, price: 6 }, { dropin: true, price: 12 }]);
  await order("paid", "2024-04-20T12:00:00Z", [{ copy: c10, price: 9 }, { dropin: true, price: 10 }]);
  await order("pending", null, [{ copy: c12, price: 99 }]);
  await order("cancelled", "2024-03-12T12:00:00Z", [{ copy: c12, price: 77 }]);
  // In shop. 22:30Z on 31 March is already 1 April in Paris (summer time).
  const shop = (copyId, price, at, method) => pool.query("INSERT INTO shop_sales (copy_id, price, sold_at, payment_method) VALUES ($1, $2, $3, $4)", [copyId, price, at, method]);
  await shop(c7, 7.5, "2024-03-25T10:00:00Z", "cash");
  await shop(c13, 4, "2024-03-31T22:30:00Z", "card");
  await shop(c11, 5, "2024-04-02T10:00:00Z", "cash");
  // Members.
  const day = 86400000;
  await makeUser("Always Member", { member: true });
  await makeUser("Renewal Soon Person", { member: true, expires: new Date(Date.now() + 10 * day) });
  await makeUser("Renewal Later Person", { member: true, expires: new Date(Date.now() + 60 * day) });
  await makeUser("Lapsed Person", { member: true, expires: new Date(Date.now() - 5 * day) });
  await makeUser("Not A Member", { member: false, expires: new Date(Date.now() + 5 * day) });
  const e1 = await makeUser("Ended May A", { member: false, expires: new Date("2024-05-20T10:00:00Z") });
  await makeUser("Ended May B", { member: false, expires: new Date("2024-05-25T10:00:00Z") });
  await makeUser("Ended July", { member: false, expires: new Date("2024-07-01T10:00:00Z") });
  const pay = (userId, email, at, id) => pool.query(
    "INSERT INTO membership_payments (user_id, helloasso_order_id, payer_email, amount_cents, paid_at) VALUES ($1, $2, $3, 1500, $4)", [userId, id, email, at]);
  const renewalSoon = (await pool.query("SELECT id FROM users WHERE display_name = 'Renewal Soon Person'")).rows[0].id;
  await pay(e1.id, e1.email, "2024-01-15T10:00:00Z", 9001);
  await pay(e1.id, e1.email, "2024-06-15T10:00:00Z", 9002); // a renewal, not a new member
  await pay(null, "payer-x@example.test", "2024-01-20T10:00:00Z", 9003);
  await pay(renewalSoon, "payer-y@example.test", "2024-02-10T10:00:00Z", 9004);
  await pay(null, "payer-z@example.test", "2024-02-11T10:00:00Z", 9005);
  await pay(null, "PAYER-Z@example.test", "2024-02-12T10:00:00Z", 9006); // same payer, other case
}

// The copies on the shelf now. Their acquisition dates are relative to today,
// so they are added only by the tests that need them (a relative date can drift
// into the fixed 2024 window the sales / sell-through tests look at: those
// tests run first, before this is called).
let stockSeeded = null;
function ensureStock() {
  if (!stockSeeded) {
    stockSeeded = (async () => {
      const fantasy = (await pool.query("SELECT id FROM books WHERE title = 'Fantasy Tale'")).rows[0].id;
      const cooking = (await pool.query("SELECT id FROM books WHERE title = 'Cook Book'")).rows[0].id;
      const cmd = await book("=cmd", null);
      const lower = await book("Old Lowercase", "fantasy");
      await copy(fantasy, { price: 5, location: "A1", source: "donation", acquired: daysAgo(10), created: "2024-01-10", cost: 1 });
      await copy(fantasy, { price: 7.5, location: "A1", source: "purchase", acquired: daysAgo(120), created: "2024-01-20", cost: 3 });
      await copy(cooking, { price: 20, publisherPrice: 20, condition: "new", acquired: daysAgo(250), created: "2024-02-05" });
      await copy(cooking, { price: 3, condition: "acceptable", status: "reserved", location: "B2", source: "lot", acquired: daysAgo(500), created: "2024-02-10", cost: 2 });
      await copy(cmd, { price: 4, condition: "like_new", location: "A1", source: "donation", acquired: daysAgo(800), created: "2024-03-02", cost: 0.5 });
      await copy(lower, { price: 2, acquired: daysAgo(700), created: "2024-03-03" });
    })();
  }
  return stockSeeded;
}

// Rows of the first table in a rendered report page as arrays of cell text.
function tables(html) {
  const out = [];
  for (const t of html.match(/<table[\s\S]*?<\/table>/g) || []) {
    out.push((t.match(/<tr>[\s\S]*?<\/tr>/g) || []).map((r) =>
      [...r.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((c) => c[1].replace(/<[^>]+>/g, "").replace(/&#34;/g, '"').replace(/&#39;/g, "'").trim())));
  }
  return out;
}
const rowOf = (table, first) => table.find((r) => r[0] === first);

// ---------- access ----------

test("reports require an admin: anonymous is redirected, a non-admin member gets 403", async () => {
  const member = await makeUser("Plain User");
  const memberJar = await login(member.email);
  for (const path of ["/admin/reports", "/admin/reports/inventory", "/admin/reports/inventory?format=csv", "/admin/reports/sales.csv"]) {
    const anon = await get(path, makeCookieJar());
    assert.equal(anon.res.status, 302, path);
    assert.match(anon.res.headers.get("location"), /login/);
    const m = await get(path, memberJar);
    assert.equal(m.res.status, 403, path);
  }
  const ok = await get("/admin/reports");
  assert.equal(ok.res.status, 200);
  for (const slug of ["inventory", "aging", "sales", "reservations", "sellthrough", "membership", "intake"]) {
    assert.match(ok.text, new RegExp(`href="/admin/reports/${slug}"`));
  }
  assert.equal((await get("/admin/reports/nope")).res.status, 404);
});

test("the admin menu links to Reports", async () => {
  const { text } = await get("/admin");
  assert.match(text, /<a href="\/admin\/reports"[^>]*>Reports<\/a>/);
});

// ---------- 3. sales ----------

test("sales report by month: reserved-online and shop revenue, averages, totals; drop-in seats kept apart; refunds titled as shop refunds", async () => {
  const { text } = await get(`/admin/reports/sales?${Y2024}&group=month`);
  const [books, dropin] = tables(text);
  // period, reserved-online items, reserved-online revenue, shop items, shop revenue, total, average
  assert.deepEqual(books[0], ["Period", "Reserved-online items", "Reserved-online revenue", "Shop items", "Shop revenue", "Total revenue", "Average per item"]);
  assert.match(text, /Refunds \(orders refunded in the shop; not included in the sales above\)/);
  assert.doesNotMatch(text, /HelloAsso|Online items|Online revenue/);
  assert.deepEqual(books[1], ["2024-03", "1", "€6.00", "1", "€7.50", "€13.50", "€6.75"]);
  // 22:30Z on 31 March is 1 April in Paris, so that sale belongs to April.
  assert.deepEqual(books[2], ["2024-04", "1", "€9.00", "2", "€9.00", "€18.00", "€6.00"]);
  assert.equal(books.length, 4);
  assert.deepEqual(books[3], ["Total", "2", "€15.00", "3", "€16.50", "€31.50", "€6.30"]);
  assert.deepEqual(dropin[1], ["2024-03", "1", "€12.00"]);
  assert.deepEqual(dropin[2], ["2024-04", "1", "€10.00"]);
  assert.deepEqual(dropin[3], ["Total", "2", "€22.00"]);
});

test("sales report: pending and cancelled orders never count, group switch, date range", async () => {
  const day = tables((await get(`/admin/reports/sales?${Y2024}&group=day`)).text)[0];
  assert.deepEqual(day.slice(1, -1).map((r) => r[0]), ["2024-03-10", "2024-03-25", "2024-04-01", "2024-04-02", "2024-04-20"]);
  const week = tables((await get(`/admin/reports/sales?${Y2024}&group=week`)).text)[0];
  assert.deepEqual(week.slice(1, -1).map((r) => r[0]), ["2024-03-04", "2024-03-25", "2024-04-01", "2024-04-15"]);
  assert.deepEqual(week[3].slice(0, 4), ["2024-04-01", "0", "€0.00", "2"]);
  const year = tables((await get(`/admin/reports/sales?${Y2024}&group=year`)).text)[0];
  assert.deepEqual(year[1], ["2024", "2", "€15.00", "3", "€16.50", "€31.50", "€6.30"]);
  // Date range: only April (inclusive of both end days, Paris days).
  const april = tables((await get("/admin/reports/sales?from=2024-04-01&to=2024-04-30&group=month")).text)[0];
  assert.deepEqual(april.slice(1).map((r) => r[0]), ["2024-04", "Total"]);
  assert.deepEqual(april.at(-1), ["Total", "1", "€9.00", "2", "€9.00", "€18.00", "€6.00"]);
  // Nothing in range, and bad dates fall back to the defaults without an error.
  assert.match((await get("/admin/reports/sales?from=2023-01-01&to=2023-01-31")).text, /Nothing to show/);
  assert.equal((await get("/admin/reports/sales?from=banana&to=2024-13-45&group=century")).res.status, 200);
});

// ---------- reservations ----------

test("reservations report: per month made, collected / expired / cancelled / open and the conversion rate; split orders and old online orders left out; no personal data", async () => {
  // Reservations made in June and July 2024 (orders with a reserved_until). Paid ones carry a 2023 paid_at so
  // the 2024 sales figures above are not affected.
  const mk = async (status, createdAt, { split = false, deadline = true, total = 10 } = {}) => {
    const { rows: main } = await pool.query("SELECT id FROM orders ORDER BY id LIMIT 1");
    await pool.query(
      `INSERT INTO orders (buyer_name, buyer_email, total_amount, status, created_at, paid_at, reserved_until, split_from_order_id)
       VALUES ('Secret Reserver', 'reserver-secret@example.test', $1, $2, $3, CASE WHEN $2 IN ('paid', 'refunded') THEN '2023-12-01T10:00:00Z'::timestamptz END,
               CASE WHEN $4::boolean THEN $3::timestamptz + interval '14 days' END, CASE WHEN $5::boolean THEN $6::int END)`,
      [total, status, createdAt, deadline, split, main[0].id]
    );
  };
  await mk("paid", "2024-06-03T10:00:00Z", { total: 10 });
  await mk("paid", "2024-06-04T10:00:00Z", { total: 5 });
  await mk("expired", "2024-06-05T10:00:00Z");
  await mk("cancelled", "2024-06-06T10:00:00Z");
  await mk("cancelled", "2024-06-09T10:00:00Z");
  await mk("reserved", "2024-06-30T22:30:00Z"); // 00:30 on 1 July in Paris: a July reservation, still open
  await mk("paid", "2024-06-07T10:00:00Z", { split: true, total: 99 }); // the remainder of a partial pickup: not a new reservation
  await mk("paid", "2024-06-08T10:00:00Z", { deadline: false, total: 77 }); // an order paid online before reservations existed

  const { res, text } = await get("/admin/reports/reservations?from=2024-06-01&to=2024-07-31");
  assert.equal(res.status, 200);
  const [t] = tables(text);
  assert.deepEqual(t[0], ["Month", "Reserved", "Collected (sold)", "Expired / no-show", "Cancelled", "Still open", "Value collected", "Conversion"]);
  // June: 5 reservations; 2 collected (EUR 15), 1 expired, 2 cancelled -> 2 of the 5 that are over became a sale.
  assert.deepEqual(t[1], ["2024-06", "5", "2", "1", "2", "0", "€15.00", "40.0%"]);
  assert.deepEqual(t[2].slice(0, 6), ["2024-07", "1", "0", "0", "0", "1"]);
  assert.deepEqual(t.at(-1).slice(0, 7), ["Total", "6", "2", "1", "2", "1", "€15.00"]);
  assert.doesNotMatch(text, /Secret Reserver|reserver-secret/, "no names or email addresses");

  const lines = (await csv("/admin/reports/reservations?format=csv&from=2024-06-01&to=2024-07-31")).lines;
  assert.equal(lines[0], '"Month","Reserved","Collected (sold)","Expired / no-show","Cancelled","Still open","Value collected","Conversion"');
  assert.equal(lines[1].slice(0, 24), '"2024-06",5,2,1,2,0,15.0');
  assert.ok(!lines.join("\n").includes("@"));
  const { rows } = await pool.query("SELECT 1 FROM admin_audit_log WHERE action = 'report.csv' AND detail = 'reservations'");
  assert.equal(rows.length, 1, "the download is logged with the slug only");
});

// ---------- 4. sell-through ----------

test("sell-through report: sold share and average days to sell per genre", async () => {
  const [t] = tables((await get(`/admin/reports/sellthrough?${Y2024}`)).text);
  // genre, acquired, sold, sell-through, avg days, avg asking price
  // Fantasy: 6.00 sold 9 days after acquired, 5.00 after 61, 4.00 after 12 (Paris day) -> 27.3 days.
  assert.deepEqual(rowOf(t, "Fantasy"), ["Fantasy", "3", "3", "100.0%", "27.3", "€5.00"]);
  // Cooking: 20 and 10 days; the damaged copy is acquired but not sold.
  assert.deepEqual(rowOf(t, "Cooking"), ["Cooking", "3", "2", "66.7%", "15.0", "€6.67"]);
  assert.deepEqual(t.at(-1), ["Total", "6", "5", "83.3%", "22.4", "€5.83"]);
});

// ---------- 1. inventory ----------

test("inventory report: counts and asking value by genre, condition, location and source", async () => {
  await ensureStock();
  const { res, text } = await get("/admin/reports/inventory");
  assert.equal(res.status, 200);
  const [genre, condition, location, source] = tables(text);
  // columns: label, in stock, value, reserved, value, total, total value
  assert.deepEqual(rowOf(genre, "Fantasy"), ["Fantasy", "3", "€14.50", "0", "€0.00", "3", "€14.50"]);
  assert.deepEqual(rowOf(genre, "Cooking"), ["Cooking", "1", "€20.00", "1", "€3.00", "2", "€23.00"]);
  assert.deepEqual(rowOf(genre, "(no genre)"), ["(no genre)", "1", "€4.00", "0", "€0.00", "1", "€4.00"]);
  assert.deepEqual(genre.at(-1), ["Total", "5", "€38.50", "1", "€3.00", "6", "€41.50"]);
  assert.deepEqual(rowOf(condition, "Very Good"), ["Very Good", "3", "€14.50", "0", "€0.00", "3", "€14.50"]);
  assert.deepEqual(rowOf(condition, "New"), ["New", "1", "€20.00", "0", "€0.00", "1", "€20.00"]);
  assert.deepEqual(rowOf(location, "A1"), ["A1", "3", "€16.50", "0", "€0.00", "3", "€16.50"]);
  assert.deepEqual(rowOf(location, "(no location)"), ["(no location)", "2", "€22.00", "0", "€0.00", "2", "€22.00"]);
  assert.deepEqual(rowOf(location, "B2"), ["B2", "0", "€0.00", "1", "€3.00", "1", "€3.00"]);
  assert.deepEqual(rowOf(source, "Donation"), ["Donation", "2", "€9.00", "0", "€0.00", "2", "€9.00"]);
  assert.deepEqual(rowOf(source, "Purchase"), ["Purchase", "1", "€7.50", "0", "€0.00", "1", "€7.50"]);
  assert.deepEqual(rowOf(source, "Job lot"), ["Job lot", "0", "€0.00", "1", "€3.00", "1", "€3.00"]);
  assert.deepEqual(rowOf(source, "(unknown)"), ["(unknown)", "2", "€22.00", "0", "€0.00", "2", "€22.00"]);
  for (const t of [condition, location, source]) assert.deepEqual(t.at(-1), ["Total", "5", "€38.50", "1", "€3.00", "6", "€41.50"]);
  // Sold, damaged copies are not "on hand".
  assert.doesNotMatch(text, /Fantasy Tale/);
});

// ---------- 2. aging ----------

test("aging report: bucket counts and value, and the 12+ month list oldest first", async () => {
  await ensureStock();
  const { text } = await get("/admin/reports/aging");
  const [buckets, oldest] = tables(text);
  assert.deepEqual(buckets[1], ["0 to 3 months", "1", "€5.00"]);
  assert.deepEqual(buckets[2], ["3 to 6 months", "1", "€7.50"]);
  assert.deepEqual(buckets[3], ["6 to 12 months", "1", "€20.00"]);
  assert.deepEqual(buckets[4], ["12 months or more", "2", "€6.00"]);
  assert.deepEqual(buckets.at(-1), ["Total", "5", "€38.50"]);
  // header + 2 rows (reserved c4 is not "in stock"): "=cmd" is 800 days old, the other 700.
  assert.equal(oldest.length, 3);
  assert.deepEqual(oldest[1], ["=cmd", "Some Author", "€4.00", "A1", daysAgo(800)]);
  assert.deepEqual(oldest[2], ["Old Lowercase", "Some Author", "€2.00", "–", daysAgo(700)]);
});

// ---------- 5. membership ----------

test("membership report: active now, joins and endings per month, renewals due (names and dates only)", async () => {
  const { text } = await get(`/admin/reports/membership?${Y2024}`);
  const [now, joins, ends, due] = tables(text);
  // Reports Admin + Always Member + two members with a future expiry (the lapsed one does not count).
  assert.deepEqual(now[1], ["Active members", "4"]);
  assert.deepEqual(joins.slice(1), [["2024-01", "2"], ["2024-02", "2"], ["Total", "4"]]);
  assert.deepEqual(ends.slice(1), [["2024-05", "2"], ["2024-07", "1"], ["Total", "3"]]);
  assert.equal(due.length, 2, "header + one renewal due within 30 days");
  assert.deepEqual(due[1].slice(0, 1), ["Renewal Soon Person"]);
  assert.match(due[1][1], /^\d{4}-\d{2}-\d{2}$/);
  assert.doesNotMatch(text, /Renewal Later Person|Lapsed Person|Not A Member/);
  for (const e of emails) assert.ok(!text.includes(e), `a member email is on the page: ${e}`);
  assert.ok(!text.includes("payer-x@example.test"));
  const csv = (await get("/admin/reports/membership?format=csv&table=renewals")).text;
  assert.ok(!/@/.test(csv), "no email in the renewals CSV");
});

// ---------- 6. intake ----------

test("intake report: copies and acquisition cost per month and per source, latest additions", async () => {
  await ensureStock();
  const [months, sources, latest] = tables((await get(`/admin/reports/intake?${Y2024}`)).text);
  assert.deepEqual(months.slice(1), [
    ["2024-01", "2", "€4.00"], ["2024-02", "4", "€3.50"], ["2024-03", "5", "€1.50"], ["2024-04", "1", "€4.00"], ["Total", "12", "€13.00"],
  ]);
  assert.deepEqual(rowOf(sources, "Donation"), ["Donation", "4", "€1.50"]);
  assert.deepEqual(rowOf(sources, "Purchase"), ["Purchase", "3", "€8.50"]);
  assert.deepEqual(rowOf(sources, "Job lot"), ["Job lot", "1", "€2.00"]);
  assert.deepEqual(rowOf(sources, "Other"), ["Other", "1", "€1.00"]);
  assert.deepEqual(rowOf(sources, "(unknown)"), ["(unknown)", "3", "€0.00"]);
  assert.deepEqual(sources.at(-1), ["Total", "12", "€13.00"]);
  assert.equal(latest.length, 13, "header + 12 copies");
  assert.equal(latest[1][0], "2024-04-10");
  // Range limits the monthly tables only.
  const [feb] = tables((await get("/admin/reports/intake?from=2024-02-01&to=2024-02-29")).text);
  assert.deepEqual(feb.slice(1), [["2024-02", "4", "€3.50"], ["Total", "4", "€3.50"]]);
});

// ---------- CSV ----------

// Fetches a CSV and returns { res, bom, lines }; fetch's text() would silently
// drop the byte order mark, so the bytes are read directly.
async function csv(path) {
  const res = await fetch(`${app.base}${path}`, { headers: { cookie: jar.header() } });
  const bytes = Buffer.from(await res.arrayBuffer());
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const text = bytes.subarray(bom ? 3 : 0).toString("utf8");
  return { res, bom, text, lines: text.trimEnd().split("\r\n") };
}

test("CSV: attachment with BOM, header row, quoted cells, totals row, and an audit row", async () => {
  await ensureStock();
  const { res, bom, lines } = await csv("/admin/reports/inventory?format=csv&table=genre");
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /^text\/csv; charset=utf-8/);
  assert.match(res.headers.get("content-disposition"), /^attachment; filename="[^"]+\.csv"$/);
  assert.ok(bom, "UTF-8 byte order mark so Excel reads accents");
  assert.equal(lines[0], '"Genre","In stock","In stock value","Reserved","Reserved value","Total copies","Total value"');
  assert.ok(lines.includes('"Fantasy",3,14.50,0,0.00,3,14.50'), lines.join("\n"));
  assert.equal(lines.at(-1), '"Total",5,38.50,1,3.00,6,41.50');
  const { rows } = await pool.query("SELECT detail FROM admin_audit_log WHERE action = 'report.csv'");
  assert.ok(rows.some((r) => r.detail === "inventory"));
  // The .csv extension works too, and each download is logged with the slug only.
  const ext = await csv("/admin/reports/aging.csv");
  assert.match(ext.res.headers.get("content-type"), /text\/csv/);
  const { rows: after } = await pool.query("SELECT detail FROM admin_audit_log WHERE action = 'report.csv' AND detail = 'aging'");
  assert.equal(after.length, 1);
  // A page view is not a download.
  await get("/admin/reports/intake");
  const { rows: intake } = await pool.query("SELECT 1 FROM admin_audit_log WHERE action = 'report.csv' AND detail = 'intake'");
  assert.equal(intake.length, 0);
});

test("CSV: a title starting with = is escaped so a spreadsheet cannot run it", async () => {
  await ensureStock();
  const { lines, text } = await csv("/admin/reports/aging?format=csv&table=oldest");
  assert.equal(lines[0], '"Title","Author","Price","Location","Acquired"');
  assert.equal(lines[1], `"'=cmd","Some Author",4.00,"A1","${daysAgo(800)}"`);
  assert.ok(!text.includes(',"=cmd"') && !text.includes('\n"=cmd"'));
});

test("CSV: the date range and the group choice apply to the download", async () => {
  const month = (await csv(`/admin/reports/sales?format=csv&${Y2024}&group=month`)).lines;
  assert.equal(month[0], '"Period","Reserved-online items","Reserved-online revenue","Shop items","Shop revenue","Total revenue","Average per item"');
  assert.equal(month[1], '"2024-03",1,6.00,1,7.50,13.50,6.75');
  const april = (await csv("/admin/reports/sales?format=csv&from=2024-04-01&to=2024-04-30&group=year")).lines;
  assert.deepEqual(april.slice(1), ['"2024",1,9.00,2,9.00,18.00,6.00', '"Total",1,9.00,2,9.00,18.00,6.00']);
  const dropin = (await csv(`/admin/reports/sales?format=csv&table=dropin&${Y2024}`)).lines;
  assert.equal(dropin[0], '"Period","Seats sold","Revenue"');
  assert.equal(dropin.at(-1), '"Total",2,22.00');
});
