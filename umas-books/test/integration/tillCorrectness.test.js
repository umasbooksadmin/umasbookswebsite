// The till's money-safety rules (second review): the amount shown is the amount recorded,
// a refusal is shown BEFORE payment, a closed day stays closed, totals are capped, prices are
// not changed silently, a replayed token cannot hide a different basket, and a void cannot
// slip into a day that is being closed. Real app, real database.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");
const { makeOrder } = require("../helpers/orderFixtures");
const { makeCookieJar } = require("../helpers/httpClient");

let h;
before(async () => { h = await tillHarness({ port: 4351, ip: "10.81.1.1" }); });
after(async () => { await h.stop(); });

const parisDay = (offset = 0) => new Date(Date.now() + offset * 86400000).toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
const countSales = async () => (await h.pool.query("SELECT COUNT(*)::int AS n FROM till_sales")).rows[0].n;
const manual = (price, { quantity = 1, category = "merchandise", description = "Thing" } = {}) => ({ kind: "manual", description, price, quantity, category });
async function seed(price = 5, opts = {}) {
  const book = await h.seedBook(`Correct ${h.uniq()}`);
  return h.seedCopy(book.id, { price, ...opts });
}
const reopenToday = () => h.pool.query(
  "UPDATE till_days SET closed_at = NULL, closed_by = NULL, counted_cash_cents = NULL, expected_cash_cents = NULL, difference_cents = NULL WHERE day = $1", [parisDay()]);

// ---------- (1) the displayed total must still be the total ----------

test("a price edited between scan and confirm is refused with the new total and NOTHING is recorded (cash and card)", async () => {
  const c = await seed(5);
  const quick = (await h.pool.query("INSERT INTO till_quick_items (name, price_cents, category, stock) VALUES ($1, 300, 'merchandise', 4) RETURNING id", [`Mug ${h.uniq()}`])).rows[0].id;
  const items = [{ ...h.book(c), expected: 500 }, { kind: "quick", id: quick, quantity: 1, expected: 300 }];
  await h.pool.query("UPDATE book_copies SET price = 8 WHERE id = $1", [c]); // changed after the scan
  const before = await countSales();
  for (const method of ["cash", "card"]) {
    const r = await h.sale(items, { method, received: "100", expectedTotalCents: "800" });
    assert.equal(r.status, 409, method);
    assert.equal(r.body.code, "price_changed");
    assert.equal(r.body.newTotalCents, 1100);
    assert.match(r.body.error, /The price changed: new total €11\.00/);
    assert.deepEqual(r.body.changed.map((x) => [x.fromCents, x.toCents]), [[500, 800]]);
  }
  assert.equal(await countSales(), before, "no sale row");
  assert.equal((await h.copy(c)).status, "in_stock");
  assert.equal((await h.pool.query("SELECT stock FROM till_quick_items WHERE id = $1", [quick])).rows[0].stock, 4);
  assert.equal((await h.pool.query("SELECT COUNT(*)::int AS n FROM shop_sales WHERE copy_id = $1", [c])).rows[0].n, 0);
  // the total alone also has to match, even when the lines carry no price
  const r2 = await h.sale([h.book(c)], { expectedTotalCents: "500" });
  assert.equal(r2.status, 409);
  assert.equal(r2.body.newTotalCents, 800);
  // with the new prices on screen it goes through, at exactly the amount shown
  const ok = await h.sale([{ ...h.book(c), expected: 800 }], { expectedTotalCents: "800", received: "10" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.totalCents, 800);
});

test("a confirm that does not say which total was shown is refused", async () => {
  const c = await seed(5);
  const r = await h.sale([h.book(c)], { expectedTotalCents: null });
  assert.equal(r.status, 422);
  assert.equal(r.body.code, "no_expected_total");
  assert.equal((await h.sale([h.book(c)], { expectedTotalCents: "abc" })).status, 422);
  assert.equal((await h.copy(c)).status, "in_stock");
});

// ---------- (2) the check before payment ----------

test("POST /admin/till/check runs the sale's own validation without writing anything", async () => {
  const c = await seed(6);
  const before = await countSales();
  const ok = await h.json("/admin/till/check", { method: "card", items: JSON.stringify([h.book(c)]) });
  assert.equal(ok.status, 200);
  assert.deepEqual([ok.body.ok, ok.body.totalCents], [true, 600]);
  assert.equal(await countSales(), before);
  assert.equal((await h.copy(c)).status, "in_stock", "a check sells nothing");

  // a copy sold meanwhile: the reason shows BEFORE the customer pays
  await h.pool.query("UPDATE book_copies SET status = 'sold' WHERE id = $1", [c]);
  const sold = await h.json("/admin/till/check", { method: "card", items: JSON.stringify([h.book(c)]) });
  assert.equal(sold.status, 409);
  assert.match(sold.body.error, /already sold/);
  // the same refusals as the sale: bad quantity, too large, wrong total, empty
  const c2 = await seed(6);
  assert.equal((await h.json("/admin/till/check", { method: "cash", items: JSON.stringify([]) })).status, 400);
  const changed = await h.json("/admin/till/check", { method: "cash", items: JSON.stringify([h.book(c2)]), expectedTotalCents: "100" });
  assert.equal(changed.body.code, "price_changed");
  assert.equal((await h.json("/admin/till/check", { method: "cash", items: JSON.stringify([manual("10001")]) })).status, 400, "a price above the maximum");
  assert.equal((await h.json("/admin/till/check", { method: "wire", items: JSON.stringify([h.book(c2)]) })).status, 400);
  const anon = await h.post("/admin/till/check", { method: "cash", items: "[]" }, makeCookieJar());
  assert.notEqual(anon.status, 200);
  assert.equal(await countSales(), before);
});

test("a failure after 'Card paid' never says 'Connection problem': the server answers JSON even when it breaks", async () => {
  // A sale the server cannot finish (a database error inside the handler) still answers JSON with
  // serverError, so the page can tell a server rejection from a network failure.
  const c = await seed(5);
  await h.pool.query("ALTER TABLE till_sales ADD CONSTRAINT tmp_break CHECK (total_cents <> 500) NOT VALID");
  try {
    const r = await h.sale([h.book(c)], { method: "card", expectedTotalCents: "500" });
    assert.equal(r.status, 500);
    assert.equal(r.body.ok, false);
    assert.equal(r.body.serverError, true);
    assert.match(r.body.error, /server had a problem/);
    assert.equal((await h.copy(c)).status, "in_stock", "nothing was recorded");
  } finally {
    await h.pool.query("ALTER TABLE till_sales DROP CONSTRAINT tmp_break");
  }
  // and once the problem is gone the same token (retry) records the sale once
  const token = h.token();
  const first = await h.sale([h.book(c)], { method: "card", token });
  assert.equal(first.status, 200);
  const again = await h.sale([h.book(c)], { method: "card", token });
  assert.equal(again.body.duplicate, true);
  assert.equal(again.body.saleId, first.body.saleId);
});

// ---------- (3) closed day ----------

test("a sale on a closed day is refused unless an admin reopens the day with a reason; the close is then done again", async () => {
  const day = parisDay();
  await h.post("/admin/till/day/open", { openingFloat: "20" });
  const s1 = await h.sale([h.book(await seed(5))], { received: "5" });
  assert.equal(s1.status, 200);
  const close = await h.post("/admin/till/day/close", { day, counted: "25" });
  assert.equal(close.status, 302);
  assert.ok((await h.pool.query("SELECT closed_at FROM till_days WHERE day = $1", [day])).rows[0].closed_at);

  const c = await seed(7);
  const before = await countSales();
  const refused = await h.sale([h.book(c)], { received: "10" });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "day_closed");
  assert.equal(await countSales(), before);
  assert.equal((await h.copy(c)).status, "in_stock");
  // the check shows it before the customer pays
  assert.equal((await h.json("/admin/till/check", { method: "cash", items: JSON.stringify([h.book(c)]) })).body.code, "day_closed");
  // ticking without a reason is not enough
  const noWhy = await h.sale([h.book(c)], { received: "10", reopen: "1", reopenReason: "" });
  assert.equal(noWhy.status, 422);
  assert.equal((await h.pool.query("SELECT closed_at IS NOT NULL AS closed FROM till_days WHERE day = $1", [day])).rows[0].closed, true, "still closed");

  const ok = await h.sale([h.book(c)], { received: "10", reopen: "1", reopenReason: "customer came back after closing" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  const row = (await h.pool.query("SELECT * FROM till_days WHERE day = $1", [day])).rows[0];
  assert.equal(row.closed_at, null, "the day is open again");
  assert.deepEqual([row.counted_cash_cents, row.expected_cash_cents, row.difference_cents], [null, null, null], "the count must be done again");
  assert.equal(row.reopen_reason, "customer came back after closing");
  assert.equal(row.reopened_by, h.adminId);
  const audit = (await h.audit("till.day_reopen")).filter((a) => a.detail.includes("customer came back"));
  assert.equal(audit.length, 1);
  assert.match(audit[0].detail, /was counted 25\.00, expected \d+\.\d\d/);
  // the end-of-day numbers recompute (float 20 + every cash sale of the day, including the new one),
  // and the page says to close again
  const cash = (await h.pool.query("SELECT COALESCE(SUM(total_cents), 0)::int AS t FROM till_sales WHERE payment_method = 'cash' AND status = 'completed' AND (created_at AT TIME ZONE 'Europe/Paris')::date = $1", [day])).rows[0].t;
  const page = (await h.get(`/admin/till/day?day=${day}`)).text;
  assert.ok(page.includes(`<th id="expected">€${((2000 + cash) / 100).toFixed(2)}`), "expected cash recomputed with the new sale");
  assert.ok(cash >= 700, "the new 7.00 sale is in it");
  assert.match(page, /reopened \(customer came back after closing\)/);
  assert.match((await h.get("/admin/till")).text, /Void sale/, "voids are possible again");
  assert.equal((await h.post("/admin/till/day/close", { day, counted: "32" })).status, 302);
  await reopenToday();
});

test("a backdated sale (today or yesterday) on a closed day needs the reopen too, and a reason, always", async () => {
  const yesterday = parisDay(-1);
  await h.pool.query(
    "INSERT INTO till_days (day, opening_float_cents, closed_at, counted_cash_cents, expected_cash_cents, difference_cents, closed_by) VALUES ($1, 0, now(), 0, 0, 0, $2) ON CONFLICT (day) DO UPDATE SET closed_at = now()",
    [yesterday, h.adminId]);
  const c = await seed(5);
  const base = { received: "5", soldAtTime: "11:00", soldAtDay: "yesterday", backdateReason: "paper sale" };
  const r = await h.sale([h.book(c)], base);
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "day_closed");
  assert.equal(r.body.day, yesterday);
  assert.equal((await h.sale([h.book(c)], { ...base, backdateReason: "" })).status, 422, "no reason, no backdating");
  const ok = await h.sale([h.book(c)], { ...base, reopen: "1", reopenReason: "found a paper receipt" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal((await h.pool.query("SELECT closed_at FROM till_days WHERE day = $1", [yesterday])).rows[0].closed_at, null);
  assert.ok((await h.get("/admin/till/day")).text.includes(yesterday), "the reopened past day is listed as never closed");
});

test("late entries are told apart by entered_at, not by the time of the sale", async () => {
  const day = parisDay(-5);
  await h.pool.query(
    "INSERT INTO till_days (day, opening_float_cents, closed_at, counted_cash_cents, expected_cash_cents, difference_cents, closed_by) VALUES ($1, 0, now() - interval '1 hour', 0, 0, 0, $2) ON CONFLICT (day) DO UPDATE SET closed_at = now() - interval '1 hour'",
    [day, h.adminId]);
  // sold at 10:00 that day (before the close), but typed in just now (after it)
  const late = await h.pool.query(
    `INSERT INTO till_sales (staff_user_id, payment_method, total_cents, sale_token, created_at, entered_at)
     VALUES ($1, 'cash', 100, $2, (($3::date + time '10:00') AT TIME ZONE 'Europe/Paris'), now()) RETURNING id`,
    [h.adminId, h.token(), day]);
  await h.pool.query("INSERT INTO till_sale_items (sale_id, kind, description, quantity, unit_price_cents, category) VALUES ($1, 'manual', 'x', 1, 100, 'other')", [late.rows[0].id]);
  assert.match((await h.get(`/admin/till/day?day=${day}`)).text, /1 sale\(s\) were entered after the day was closed/);
  // entered on time (entered_at before the close): not flagged
  await h.pool.query("UPDATE till_sales SET entered_at = created_at WHERE id = $1", [late.rows[0].id]);
  assert.doesNotMatch((await h.get(`/admin/till/day?day=${day}`)).text, /entered after the day was closed/);
});

test("the Reopen button on End of day: admin only, reason required, clears the count, audited", async () => {
  const day = parisDay();
  await h.pool.query(
    "INSERT INTO till_days (day, opening_float_cents, closed_at, counted_cash_cents, expected_cash_cents, difference_cents, closed_by) VALUES ($1, 0, now(), 50, 60, -10, $2) ON CONFLICT (day) DO UPDATE SET closed_at = now(), counted_cash_cents = 50, expected_cash_cents = 60, difference_cents = -10",
    [day, h.adminId]);
  assert.match((await h.get(`/admin/till/day?day=${day}`)).text, /Reopen the day/);
  const noReason = await h.post("/admin/till/day/reopen", { day, reason: "" });
  assert.match(decodeURIComponent(noReason.headers.get("location")), /reason/i);
  assert.ok((await h.pool.query("SELECT closed_at FROM till_days WHERE day = $1", [day])).rows[0].closed_at);
  const ok = await h.post("/admin/till/day/reopen", { day, reason: "miscounted" });
  assert.match(ok.headers.get("location"), /reopened=1/);
  const row = (await h.pool.query("SELECT * FROM till_days WHERE day = $1", [day])).rows[0];
  assert.deepEqual([row.closed_at, row.counted_cash_cents, row.reopen_reason], [null, null, "miscounted"]);
  assert.match((await h.audit("till.day_reopen")).at(-1).detail, /miscounted \(was counted 0\.50, expected 0\.60\)/);
  assert.match(decodeURIComponent((await h.post("/admin/till/day/reopen", { day, reason: "again" })).headers.get("location")), /not closed/);
});

// ---------- (8) the total cap ----------

test("a sale total above €10,000 gets a clear 422, never a 500; exactly €10,000 is fine", async () => {
  assert.equal(require("../../src/lib/till").MAX_TOTAL_CENTS, 1000000);
  const before = await countSales();
  // 60 lines of 99 x €10,000 would overflow an int4 total
  const huge = Array.from({ length: 60 }, (_, i) => manual("10000", { quantity: 99, description: `Pallet ${i}` }));
  const big = await h.sale(huge, { received: "100", expectedTotalCents: "1" });
  assert.equal(big.status, 422);
  assert.match(big.body.error, /Sale total too large/);
  const over = await h.sale([manual("10000.00"), manual("0.01", { description: "extra" })], { expectedTotalCents: "1" });
  assert.equal(over.status, 422);
  assert.match(over.body.error, /Sale total too large/);
  assert.equal((await h.json("/admin/till/check", { method: "cash", items: JSON.stringify(huge) })).status, 422);
  assert.equal(await countSales(), before);
  const exact = await h.sale([manual("10000.00")], { received: "10000" });
  assert.equal(exact.status, 200, JSON.stringify(exact.body));
  assert.equal(exact.body.totalCents, 1000000);
  // quantity and line count stay capped as before
  assert.equal((await h.sale([manual("1", { quantity: 100 })])).status, 400);
  assert.equal((await h.sale(Array.from({ length: 61 }, (_, i) => manual("1", { description: `L${i}` })))).status, 400);
});

// ---------- (9) price overrides ----------

test("price overrides: up to 20% above the asking price is free; below it, or far above it, needs a reason; never 0", async () => {
  const sell = async (price, reason = "") => {
    const c = await seed(10);
    return { c, r: await h.sale([h.book(c, price, reason)], { received: "100" }) };
  };
  assert.equal((await sell("11")).r.status, 200, "10% above: no reason needed");
  assert.equal((await sell("12")).r.status, 200, "exactly 20% above");
  const far = await sell("12.01");
  assert.equal(far.r.status, 422);
  assert.match(far.r.body.error, /Give a reason/);
  assert.equal((await h.copy(far.c)).status, "in_stock");
  const below = await sell("9.99");
  assert.equal(below.r.status, 422, "any amount below the asking price needs a reason");
  assert.equal((await sell("9", " ")).r.status, 422);
  const ok = await sell("9", "pages stained");
  assert.equal(ok.r.status, 200);
  const item = (await h.pool.query("SELECT original_price_cents, unit_price_cents, override_reason FROM till_sale_items WHERE sale_id = $1", [ok.r.body.saleId])).rows[0];
  assert.deepEqual([item.original_price_cents, item.unit_price_cents, item.override_reason], [1000, 900, "pages stained"]);
  assert.ok((await h.audit("till.price_override")).some((a) => a.target_id === ok.c && /10\.00 -> 9\.00: pages stained/.test(a.detail)), "the reason is in the audit entry");
  // 0 is refused for a book, also with a reason
  const zc = await seed(10);
  const zero = await h.sale([h.book(zc, "0", "gift"), manual("2", { description: "Card" })], { received: "5" });
  assert.equal(zero.status, 400, "even beside a paying line");
  assert.match(zero.body.error, /Enter a price above 0/);
  assert.equal((await h.copy(zc)).status, "in_stock");
  // a manual item cannot be 0 either, except in the Donation category
  assert.equal((await h.sale([manual("0"), manual("2", { description: "x" })])).status, 400);
  const donation = await h.sale([manual("0", { category: "donation", description: "Thanks" }), manual("2", { description: "Card" })], { received: "5" });
  assert.equal(donation.status, 200, JSON.stringify(donation.body));
  // a new book: any discount (even within the 5%) needs a reason, a raise does not apply
  const book = await h.seedBook(`NewBook ${h.uniq()}`);
  const n = await h.seedCopy(book.id, { condition: "new", price: 20, publisherPrice: 20 });
  assert.equal((await h.sale([h.book(n, "19")])).status, 422);
  assert.equal((await h.sale([h.book(n, "19", "loyalty")], { received: "50" })).status, 200);
});

// ---------- (10) token replay ----------

test("the same sale token with a different basket is refused, not answered with the first sale", async () => {
  const a = await seed(5);
  const b = await seed(7);
  const token = h.token();
  const first = await h.sale([h.book(a)], { token, received: "10" });
  assert.equal(first.status, 200);
  const stored = (await h.pool.query("SELECT basket_hash FROM till_sales WHERE id = $1", [first.body.saleId])).rows[0].basket_hash;
  assert.match(stored, /^[0-9a-f]{64}$/);
  const other = await h.sale([h.book(b)], { token, received: "10" });
  assert.equal(other.status, 409);
  assert.equal(other.body.code, "token_replay");
  assert.match(other.body.error, /already recorded with different items/);
  assert.equal((await h.copy(b)).status, "in_stock");
  const otherMethod = await h.sale([h.book(a)], { token, method: "card" });
  assert.equal(otherMethod.status, 409, "a different payment method is a different sale");
  // the identical basket (a double click, a retry) still returns the first sale, once
  const same = await h.sale([h.book(a)], { token, received: "10" });
  assert.equal(same.status, 200);
  assert.deepEqual([same.body.duplicate, same.body.saleId], [true, first.body.saleId]);
  assert.equal((await h.pool.query("SELECT COUNT(*)::int AS n FROM till_sales WHERE sale_token = $1", [token])).rows[0].n, 1);
});

// ---------- (11) void vs close ----------

async function holdCloseLock(day) {
  const c = await h.pool.connect();
  await c.query("BEGIN");
  await c.query("SELECT pg_advisory_xact_lock(7243902, ($1::date - DATE '2000-01-01'))", [day]);
  return c;
}
const pending = (p) => Promise.race([p.then(() => false), new Promise((r) => setTimeout(() => r(true), 500))]);

test("a void that arrives while the day is being closed waits, then sees the closed day (expected cash cannot change after the count)", async () => {
  const day = parisDay();
  await reopenToday();
  const sale = await h.sale([h.book(await seed(5))], { received: "5" });
  assert.equal(sale.status, 200);
  const closer = await holdCloseLock(day); // "closeDay" is in progress
  let res;
  try {
    const voiding = h.post(`/admin/till/sales/${sale.body.saleId}/void`, { reason: "race" });
    assert.equal(await pending(voiding), true, "the void waits for the close");
    await closer.query(
      "INSERT INTO till_days (day, opening_float_cents, closed_at, counted_cash_cents, expected_cash_cents, difference_cents) VALUES ($1, 0, now(), 500, 500, 0) ON CONFLICT (day) DO UPDATE SET closed_at = now()", [day]);
    await closer.query("COMMIT");
    res = await voiding;
  } finally {
    await closer.query("ROLLBACK").catch(() => {}); // a failed assertion must not leave the lock held
    closer.release();
  }
  assert.match(decodeURIComponent(res.headers.get("location")), /day is closed/);
  assert.equal((await h.pool.query("SELECT status FROM till_sales WHERE id = $1", [sale.body.saleId])).rows[0].status, "completed");
  await reopenToday();
});

test("a sale that arrives while the day is being closed waits too, and is refused once the day is closed", async () => {
  const day = parisDay();
  await reopenToday();
  const c = await seed(5);
  const closer = await holdCloseLock(day);
  let r;
  try {
    const selling = h.sale([h.book(c)], { received: "5", expectedTotalCents: "500" });
    assert.equal(await pending(selling), true, "the sale waits for the close");
    await closer.query("UPDATE till_days SET closed_at = now(), counted_cash_cents = 0, expected_cash_cents = 0, difference_cents = 0 WHERE day = $1", [day]);
    await closer.query("COMMIT");
    r = await selling;
  } finally {
    await closer.query("ROLLBACK").catch(() => {});
    closer.release();
  }
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "day_closed");
  assert.equal((await h.copy(c)).status, "in_stock");
  await reopenToday();
});

// ---------- (11b) closing with no opening float ----------

test("closing a day with no opening float needs a confirmation; a past unclosed day can be given a float first", async () => {
  const past = parisDay(-2);
  await h.pool.query("DELETE FROM till_days WHERE day = $1", [past]);
  const refused = await h.post("/admin/till/day/close", { day: past, counted: "0" });
  assert.match(decodeURIComponent(refused.headers.get("location")), /did not enter an opening float: it will count as €0/);
  assert.equal((await h.pool.query("SELECT 1 FROM till_days WHERE day = $1", [past])).rowCount, 0, "nothing was written");
  // enter the float for that past day, then it closes without the confirmation
  const saved = await h.post("/admin/till/day/open", { day: past, openingFloat: "40" });
  assert.match(saved.headers.get("location"), new RegExp(`day=${past}.*opened=1`));
  assert.equal((await h.pool.query("SELECT opening_float_cents FROM till_days WHERE day = $1", [past])).rows[0].opening_float_cents, 4000);
  assert.equal((await h.post("/admin/till/day/close", { day: past, counted: "40" })).status, 302);
  const row = (await h.pool.query("SELECT opening_float_cents, difference_cents, closed_at FROM till_days WHERE day = $1", [past])).rows[0];
  assert.deepEqual([row.opening_float_cents, row.difference_cents, !!row.closed_at], [4000, 0, true]);
  // a future day cannot be opened
  assert.match(decodeURIComponent((await h.post("/admin/till/day/open", { day: parisDay(3), openingFloat: "1" })).headers.get("location")), /future/);
  // the page offers the tick
  const other = parisDay(-3);
  await h.pool.query("DELETE FROM till_days WHERE day = $1", [other]);
  assert.match((await h.get(`/admin/till/day?day=${other}`)).text, /name="confirmNoFloat"/);
});

// ---------- (12) one query at a time ----------

test("daySummary runs its queries one at a time on a client (several at once is deprecated in pg and removed in pg 9)", async () => {
  const till = require("../../src/lib/till");
  let inFlight = 0;
  let max = 0;
  const fake = {
    async query() {
      inFlight++; max = Math.max(max, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { rows: [{ n: 0 }] };
    },
  };
  await till.daySummary(fake, "2026-01-01");
  assert.equal(max, 1);
});

// ---------- (13) the 'Other' category ----------

test("manual 'Books (other)' is relabelled and stays 'Other' in the accounting export", async () => {
  const till = require("../../src/lib/till");
  const label = till.OTHER_CATEGORIES.find((c) => c.value === "books_other").label;
  assert.match(label, /^Other \(not new books: scan new books so the price rules apply\)/);
  assert.equal(till.EXPORT_CATEGORY.books_other, "Other");
  assert.match((await h.get("/admin/till")).text, /Other \(not new books: scan new books so the price rules apply\)/);
  const r = await h.sale([manual("3", { category: "books_other", description: "Old map" })], { received: "5" });
  assert.equal(r.status, 200);
  const day = parisDay();
  const csv = await (await fetch(`${h.app.base}/admin/reports/accounting?from=${day}&to=${day}&format=csv`, { headers: { cookie: h.jar.header(), "x-forwarded-for": h.ip } })).text();
  assert.match(csv, /"?Other"?,"?Cash"?/);
  assert.doesNotMatch(csv, /Books other/);
});

// ---------- (15) expired carts ----------

test("a copy in an EXPIRED online cart can be released from the till; a live cart is refused with the time left", async () => {
  const stale = await makeOrder(h.pool, { status: "pending" });
  const staleCopy = stale.copyIds[0];
  await h.pool.query("UPDATE book_copies SET cart_added_at = now() - interval '2 hours' WHERE id = $1", [staleCopy]);
  const scan = await h.scan(`UB-${staleCopy}`);
  assert.equal(scan.body.type, "expired_cart");
  assert.equal(scan.body.line.copyId, staleCopy);
  assert.match(scan.body.message, /Release it from that cart/);
  // not released by scanning
  assert.equal((await h.copy(staleCopy)).status, "in_cart");
  // a sale of it before releasing is refused
  assert.equal((await h.sale([h.book(staleCopy)])).status, 409);
  const rel = await h.json("/admin/till/release", { copyId: String(staleCopy) });
  assert.equal(rel.status, 200, JSON.stringify(rel.body));
  assert.equal(rel.body.type, "line");
  assert.equal((await h.copy(staleCopy)).status, "in_stock");
  assert.equal((await h.pool.query("SELECT status FROM orders WHERE id = $1", [stale.order.id])).rows[0].status, "expired", "the cart's own release function ran");
  assert.equal((await h.audit("till.release_cart")).filter((a) => a.target_id === staleCopy).length, 1);
  assert.equal((await h.sale([h.book(staleCopy)], { received: "10" })).status, 200);

  const live = await makeOrder(h.pool, { status: "pending" });
  const liveCopy = live.copyIds[0];
  await h.pool.query("UPDATE book_copies SET cart_added_at = now() - interval '10 minutes' WHERE id = $1", [liveCopy]);
  const refused = await h.scan(`UB-${liveCopy}`);
  assert.equal(refused.body.type, "error");
  assert.match(refused.body.message, /in someone's online cart \(the hold ends in (49|50|51) minutes\)/);
  const relLive = await h.json("/admin/till/release", { copyId: String(liveCopy) });
  assert.equal(relLive.status, 409);
  assert.match(relLive.body.error, /ends in (49|50|51) minutes/);
  assert.equal((await h.copy(liveCopy)).status, "in_cart");
  assert.equal((await h.json("/admin/till/release", { copyId: "abc" })).status, 400);
  assert.equal((await h.json("/admin/till/release", { copyId: "999999999" })).status, 404);
  // by ISBN too
  const book = await h.seedBook(`Cart ISBN ${h.uniq()}`);
  const inCart = await h.seedCopy(book.id, { status: "in_cart" });
  await h.pool.query("UPDATE book_copies SET cart_added_at = now() - interval '3 hours' WHERE id = $1", [inCart]);
  assert.equal((await h.scan(book.isbn)).body.type, "expired_cart");
});

// ---------- (6) voiding a card sale ----------

test("voiding a card sale: warned on the form, the refund is ticked by staff, and an unticked one is listed until it is", async () => {
  await reopenToday();
  const card = await h.sale([h.book(await seed(9))], { method: "card" });
  const cash = await h.sale([h.book(await seed(4))], { received: "5" });
  const page = (await h.get("/admin/till")).text;
  const formOf = (id) => (page.match(new RegExp(`action="/admin/till/sales/${id}/void">[\\s\\S]*?</form>`)) || [""])[0];
  assert.match(formOf(card.body.saleId), /This was a card payment: refund it on the SumUp reader or app yourself/);
  assert.match(formOf(card.body.saleId), /I refunded the card/);
  assert.ok(formOf(cash.body.saleId).length > 50, "the cash sale has a void form");
  assert.doesNotMatch(formOf(cash.body.saleId), /card payment|refunded the card/, "no card warning on a cash sale");

  const v = await h.post(`/admin/till/sales/${card.body.saleId}/void`, { reason: "wrong book" });
  assert.match(v.headers.get("location"), /voided=\d+&card=1/);
  await h.post(`/admin/till/sales/${cash.body.saleId}/void`, { reason: "oops" });
  const row = (await h.pool.query("SELECT refund_confirmed FROM till_sales WHERE id = $1", [card.body.saleId])).rows[0];
  assert.equal(row.refund_confirmed, false);
  assert.match((await h.get(v.headers.get("location"))).text, /It was a card sale: refund the card/);
  // Needs attention (dashboard) and End of day list it; the cash void is not listed
  const dash = (await h.get("/admin")).text;
  assert.match(dash, /voided card sale[^<]*not marked as refunded/);
  const day = (await h.get("/admin/till/day")).text;
  assert.match(day, /Voided card sales: refund the card/);
  assert.match(day, new RegExp(`/admin/till/sales/${card.body.saleId}/refunded`));
  assert.doesNotMatch(day, new RegExp(`/admin/till/sales/${cash.body.saleId}/refunded`));
  assert.match(day, /CARD REFUND NEEDED/);
  // ticking it
  assert.match((await h.post(`/admin/till/sales/${card.body.saleId}/refunded`, {})).headers.get("location"), /\/admin\/till/);
  assert.equal((await h.pool.query("SELECT refund_confirmed, refund_confirmed_by FROM till_sales WHERE id = $1", [card.body.saleId])).rows[0].refund_confirmed, true);
  assert.doesNotMatch((await h.get("/admin")).text, /voided card sale[^<]*not marked as refunded/);
  assert.equal((await h.audit("till.refund_confirmed")).length >= 1, true);
  // a second tick, or a cash sale, is refused
  assert.match(decodeURIComponent((await h.post(`/admin/till/sales/${card.body.saleId}/refunded`, {})).headers.get("location")), /not a voided card sale/);
  assert.match(decodeURIComponent((await h.post(`/admin/till/sales/${cash.body.saleId}/refunded`, {})).headers.get("location")), /not a voided card sale/);

  // ticked at void time
  const card2 = await h.sale([h.book(await seed(6))], { method: "card" });
  await h.post(`/admin/till/sales/${card2.body.saleId}/void`, { reason: "changed mind", refundConfirmed: "1" });
  assert.equal((await h.pool.query("SELECT refund_confirmed FROM till_sales WHERE id = $1", [card2.body.saleId])).rows[0].refund_confirmed, true);
  assert.match((await h.audit("till.void")).at(-1).detail, /card refunded/);
});

// ---------- (7) cash received ----------

test("cash received '20.' (a trailing dot from the keypad) is accepted; other bad amounts are not", async () => {
  const c = await seed(12.5);
  const bad = await h.sale([h.book(c)], { received: "20.." });
  assert.equal(bad.status, 400);
  assert.equal((await h.sale([h.book(c)], { received: "." })).status, 400);
  const ok = await h.sale([h.book(c)], { received: "20." });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.changeCents, 750);
  const row = (await h.pool.query("SELECT cash_received_cents FROM till_sales WHERE id = $1", [ok.body.saleId])).rows[0];
  assert.equal(row.cash_received_cents, 2000);
  // the tolerance is for cash received only: a price with a trailing dot is still refused
  assert.equal((await h.sale([h.book(await seed(5), "6.")], { received: "20" })).status, 400);
});
