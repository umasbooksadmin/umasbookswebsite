// The till (/admin/till): scanning, selling, voiding, receipts. Real app, real database.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");
const { makeCookieJar } = require("../helpers/httpClient");

let h;
before(async () => { h = await tillHarness({ port: 4201, ip: "10.80.1.1" }); });
after(async () => { await h.stop(); });

// ---------- access and page ----------

test("till pages need an admin; the till page has an autofocused scan box and no inline script", async () => {
  for (const path of ["/admin/till", "/admin/till/day", "/admin/till/items", "/admin/till/sales/1/receipt"]) {
    const { res } = await h.get(path, makeCookieJar());
    assert.equal(res.status, 302, path);
    assert.match(res.headers.get("location"), /login/);
  }
  const anonPost = await h.post("/admin/till/scan", { code: "UB-1" }, makeCookieJar());
  assert.notEqual(anonPost.status, 200);
  const { res, text } = await h.get("/admin/till");
  assert.equal(res.status, 200);
  assert.match(text, /id="scan"[^>]*autofocus/);
  assert.match(text, /<script src="\/till\.js">/);
  assert.doesNotMatch(text, /<script[^>]*>[^<]/, "no inline script (CSP)");
  assert.match(text, /href="\/admin\/till"[^>]*><strong>Till<\/strong>/, "Till is in the admin menu");
  assert.match(text, /Cash<\/button>/);
  assert.match(text, /Card<\/button>/);
});

// ---------- scanning ----------

test("scan UB-<id> adds exactly that in-stock copy", async () => {
  const book = await h.seedBook(`Label Scan ${h.uniq()}`);
  const a = await h.seedCopy(book.id, { price: 5 });
  const b = await h.seedCopy(book.id, { price: 3 });
  const r = await h.scan(`UB-${b}`);
  assert.equal(r.body.type, "line");
  assert.equal(r.body.line.copyId, b);
  assert.equal(r.body.line.priceCents, 300);
  assert.notEqual(r.body.line.copyId, a);
});

test("scan an ISBN: one copy is added; several show a picker; hyphens ignored; ISBN-10 works", async () => {
  const one = await h.seedBook(`One Copy ${h.uniq()}`);
  const c1 = await h.seedCopy(one.id, { price: 8 });
  const r1 = await h.scan(one.isbn.replace(/^(\d{3})(\d)(\d{2})(\d{6})(\d)$/, "$1-$2-$3-$4-$5"));
  assert.equal(r1.body.type, "line");
  assert.equal(r1.body.line.copyId, c1);

  const many = await h.seedBook(`Many Copies ${h.uniq()}`);
  const m1 = await h.seedCopy(many.id, { price: 3, location: "A1", condition: "acceptable" });
  const m2 = await h.seedCopy(many.id, { price: 10, location: "B2", condition: "good" });
  const r2 = await h.scan(many.isbn);
  assert.equal(r2.body.type, "choose");
  assert.deepEqual(r2.body.copies.map((c) => c.copyId).sort(), [m1, m2].sort());
  const pick = r2.body.copies.find((c) => c.copyId === m2);
  assert.equal(pick.priceCents, 1000);
  assert.equal(pick.location, "B2");
  assert.equal(pick.conditionLabel, "Good");
  // one already on the sale: the other is added directly
  const r3 = await h.scan(many.isbn, [m1]);
  assert.equal(r3.body.type, "line");
  assert.equal(r3.body.line.copyId, m2);

  // ISBN-10 of a 978 book
  const isbn10 = require("../../src/lib/inventory").isbnVariants(one.isbn).find((v) => v.length === 10);
  assert.equal((await h.scan(isbn10)).body.line.copyId, c1);
});

test("unknown codes get a friendly error; so do unknown labels and unknown ISBNs", async () => {
  for (const code of ["hello", "UB-999999999", "9780000000002"]) {
    const r = await h.scan(code);
    assert.equal(r.body.type, "error", code);
    assert.ok(r.body.message.length > 10);
  }
  assert.match((await h.scan("hello")).body.message, /not recognised/);
});

test("the same copy twice on one sale is refused: 'already on this sale'", async () => {
  const book = await h.seedBook(`Twice ${h.uniq()}`);
  const c = await h.seedCopy(book.id);
  const r = await h.scan(`UB-${c}`, [c]);
  assert.equal(r.body.type, "error");
  assert.match(r.body.message, /already on this sale/);
  const viaIsbn = await h.scan(book.isbn, [c]);
  assert.match(viaIsbn.body.message, /already on this sale/);
  // and the server refuses a sale with the same copy twice
  const dup = await h.sale([h.book(c), h.book(c)]);
  assert.equal(dup.status, 400);
  assert.match(dup.body.error, /twice/);
});

test("sold, reserved and in-cart copies are refused with the reason", async () => {
  const book = await h.seedBook(`Refused ${h.uniq()}`);
  for (const [status, re] of [["sold", /already sold/], ["reserved", /reserved for a customer/], ["in_cart", /online cart/], ["damaged", /withdrawn/]]) {
    const c = await h.seedCopy(book.id, { status });
    const r = await h.scan(`UB-${c}`);
    assert.equal(r.body.type, "error", status);
    assert.match(r.body.message, re);
    const sale = await h.sale([h.book(c)]);
    assert.equal(sale.status, 409, status);
    assert.match(sale.body.error, re);
  }
  const only = await h.seedBook(`Only Sold ${h.uniq()}`);
  await h.seedCopy(only.id, { status: "sold" });
  assert.match((await h.scan(only.isbn)).body.message, /already sold/);
});

test("scanning ORDER-<n> of an order that does not exist says so (collecting a real reservation is tested in tillReservations.test.js)", async () => {
  const r = await h.scan("ORDER-999998");
  assert.equal(r.body.type, "error");
  assert.match(r.body.message, /No reservation 999998/);
});

// ---------- prices ----------

test("used book: price override accepted, validated and audited; unpriced copy needs a price", async () => {
  const book = await h.seedBook(`Override ${h.uniq()}`);
  const c = await h.seedCopy(book.id, { price: 8 });
  for (const bad of ["abc", "-1", "4.999", "1e3", "20000"]) {
    const r = await h.sale([h.book(c, bad)]);
    assert.equal(r.status, 400, bad);
    assert.equal((await h.copy(c)).status, "in_stock", "a refused sale leaves the copy in stock");
  }
  const ok = await h.sale([h.book(c, "6,50", "damaged cover")], { received: "10" });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.totalCents, 650);
  assert.equal(ok.body.changeCents, 350);
  const item = (await h.pool.query("SELECT * FROM till_sale_items WHERE sale_id = $1", [ok.body.saleId])).rows[0];
  assert.equal(item.unit_price_cents, 650);
  assert.equal(item.original_price_cents, 800);
  assert.equal(item.override_reason, "damaged cover");
  const audits = (await h.audit("till.price_override")).filter((a) => a.target_id === c);
  assert.equal(audits.length, 1);
  assert.match(audits[0].detail, /8\.00 -> 6\.50/);

  const unpriced = await h.seedCopy(book.id, { price: null });
  assert.match((await h.scan(`UB-${unpriced}`)).body.line.priceCents === null ? "null" : "x", /null/);
  const none = await h.sale([h.book(unpriced)]);
  assert.equal(none.status, 400);
  assert.match(none.body.error, /Enter a price/);
  const set = await h.sale([h.book(unpriced, "2")], { received: "2" });
  assert.equal(set.status, 200);
});

test("new books follow loi Lang: 95-100% of the publisher price, enforced at the till", async () => {
  const book = await h.seedBook(`New Book ${h.uniq()}`);
  const mk = () => h.seedCopy(book.id, { condition: "new", price: 20, publisherPrice: 20 });
  for (const [price, status] of [["19", 200], ["20", 200], ["19.01", 200], ["18.99", 400], ["18", 400], ["20.01", 400], ["10", 400]]) {
    const c = await mk();
    // below the asking price (even within the 5%) needs a reason
    const r = await h.sale([h.book(c, price, "agreed discount")], { received: "50" });
    assert.equal(r.status, status, `price ${price}: ${JSON.stringify(r.body)}`);
    if (status === 400) assert.match(r.body.error, /publisher's price/);
  }
  // blank price on a new copy = the publisher's price
  const c = await mk();
  const r = await h.sale([h.book(c)], { received: "20" });
  assert.equal(r.body.totalCents, 2000);
  const item = (await h.pool.query("SELECT category FROM till_sale_items WHERE sale_id = $1", [r.body.saleId])).rows[0];
  assert.equal(item.category, "books_new");
  // a copy without a publisher price cannot be sold as new
  const bad = await h.seedCopy(book.id, { condition: "new", price: 20, publisherPrice: null });
  assert.equal((await h.sale([h.book(bad, "20")])).status, 400);
});

test("a New book published over 2 years ago is free-priced at the till; a recent or undated one keeps loi Lang", async () => {
  const year = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Paris", year: "numeric" }).format(new Date()));
  const oldBook = await h.seedBook(`Old New ${h.uniq()}`);
  await h.pool.query("UPDATE books SET published_year = $1 WHERE id = $2", [year - 3, oldBook.id]);
  // no publisher's price, no price: the till asks for one (like a used copy) and the scan marks the line free-priced
  const unpriced = await h.seedCopy(oldBook.id, { condition: "new", price: null, publisherPrice: null });
  const scanned = await h.scan(`UB-${unpriced}`);
  assert.equal(scanned.body.line.fixedPrice, false);
  assert.equal(scanned.body.line.priceCents, null);
  assert.equal((await h.sale([h.book(unpriced)])).status, 400);
  const own = await h.sale([h.book(unpriced, "4.50")], { received: "10" });
  assert.equal(own.status, 200, JSON.stringify(own.body));
  assert.equal(own.body.totalCents, 450);
  const item = (await h.pool.query("SELECT category FROM till_sale_items WHERE sale_id = $1", [own.body.saleId])).rows[0];
  assert.equal(item.category, "books_new");
  // a publisher's price on an old copy: any price is accepted (admin, with a reason below the asking price)
  const priced = await h.seedCopy(oldBook.id, { condition: "new", price: 20, publisherPrice: 20 });
  assert.equal((await h.scan(`UB-${priced}`)).body.line.priceCents, 2000);
  const cheap = await h.sale([h.book(priced, "6", "old stock")], { received: "10" });
  assert.equal(cheap.status, 200, JSON.stringify(cheap.body));
  assert.equal(cheap.body.totalCents, 600);
  // recent and undated books: unchanged
  const recent = await h.seedBook(`Recent New ${h.uniq()}`);
  await h.pool.query("UPDATE books SET published_year = $1 WHERE id = $2", [year - 2, recent.id]);
  const undated = await h.seedBook(`Undated New ${h.uniq()}`);
  for (const b of [recent, undated]) {
    const c = await h.seedCopy(b.id, { condition: "new", price: 20, publisherPrice: 20 });
    assert.equal((await h.scan(`UB-${c}`)).body.line.fixedPrice, true);
    const low = await h.sale([h.book(c, "6", "x")], { received: "50" });
    assert.equal(low.status, 400);
    assert.match(low.body.error, /publisher's price/);
    const missing = await h.seedCopy(b.id, { condition: "new", price: 20, publisherPrice: null });
    assert.equal((await h.sale([h.book(missing, "20")])).status, 400);
  }
});

// ---------- payment ----------

test("cash: received must cover the total; change is computed in cents and recorded", async () => {
  const book = await h.seedBook(`Cash ${h.uniq()}`);
  const c = await h.seedCopy(book.id, { price: 5 });
  assert.equal((await h.sale([h.book(c)], { received: "4.99" })).status, 400);
  assert.equal((await h.sale([h.book(c)], { received: "" })).status, 400);
  assert.equal((await h.sale([h.book(c)], { received: "abc" })).status, 400);
  assert.equal((await h.copy(c)).status, "in_stock");
  const r = await h.sale([h.book(c)], { received: "20" });
  assert.equal(r.status, 200);
  assert.equal(r.body.changeCents, 1500);
  const s = (await h.pool.query("SELECT * FROM till_sales WHERE id = $1", [r.body.saleId])).rows[0];
  assert.deepEqual([s.payment_method, s.total_cents, s.cash_received_cents, s.change_given_cents, s.staff_user_id], ["cash", 500, 2000, 1500, h.adminId]);
  const copy = await h.copy(c);
  assert.equal(copy.status, "sold");
  assert.equal(copy.sold_via, "till");
  assert.ok(copy.sold_at);
  const shop = (await h.pool.query("SELECT * FROM shop_sales WHERE copy_id = $1", [c])).rows;
  assert.equal(shop.length, 1, "one shop_sales row, so reports count it once");
  assert.equal(shop[0].till_sale_id, r.body.saleId);
  assert.equal(shop[0].payment_method, "cash");
  assert.equal(Number(shop[0].price), 5);
});

test("card (manual): needs the 'Card paid' confirmation; reference is stored; no cash fields", async () => {
  const book = await h.seedBook(`Card ${h.uniq()}`);
  const c = await h.seedCopy(book.id, { price: 6 });
  const unconfirmed = await h.json("/admin/till/sale", { token: h.token(), method: "card", items: JSON.stringify([h.book(c)]), expectedTotalCents: "600" });
  assert.equal(unconfirmed.status, 400);
  assert.match(unconfirmed.body.error, /not confirmed/);
  assert.equal((await h.copy(c)).status, "in_stock");
  const r = await h.sale([h.book(c)], { method: "card", cardReference: "4242" });
  assert.equal(r.status, 200);
  const s = (await h.pool.query("SELECT * FROM till_sales WHERE id = $1", [r.body.saleId])).rows[0];
  assert.deepEqual([s.payment_method, s.card_reference, s.cash_received_cents, s.change_given_cents], ["card", "4242", null, null]);
  assert.equal(r.body.changeCents, null);
});

test("idempotent: the same sale token twice (double click, retry) makes ONE sale", async () => {
  const book = await h.seedBook(`Idem ${h.uniq()}`);
  const c = await h.seedCopy(book.id, { price: 5 });
  const token = h.token();
  const [a, b] = await Promise.all([h.sale([h.book(c)], { token, received: "5" }), h.sale([h.book(c)], { token, received: "5" })]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.body.saleId, b.body.saleId);
  assert.equal([a.body, b.body].filter((x) => x.duplicate).length, 1);
  const again = await h.sale([h.book(c)], { token, received: "5" });
  assert.equal(again.body.saleId, a.body.saleId);
  assert.equal(Number((await h.pool.query("SELECT count(*) FROM till_sales WHERE sale_token = $1", [token])).rows[0].count), 1);
  assert.equal(Number((await h.pool.query("SELECT count(*) FROM shop_sales WHERE copy_id = $1", [c])).rows[0].count), 1);
  assert.equal((await h.audit("till.sale")).filter((x) => x.target_id === a.body.saleId).length, 1, "one audit entry");
});

test("two tills selling the same copy at once: one succeeds, the other fails cleanly", async () => {
  const book = await h.seedBook(`Race ${h.uniq()}`);
  const c = await h.seedCopy(book.id, { price: 5 });
  const results = await Promise.all(Array.from({ length: 4 }, () => h.sale([h.book(c)], { received: "5" })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 3);
  for (const r of results.filter((x) => x.status === 409)) assert.match(r.body.error, /already sold/);
  assert.equal(Number((await h.pool.query("SELECT count(*) FROM shop_sales WHERE copy_id = $1", [c])).rows[0].count), 1);
});

test("a failed sale leaves nothing behind (no half sale, token reusable)", async () => {
  const book = await h.seedBook(`Atomic ${h.uniq()}`);
  const good = await h.seedCopy(book.id, { price: 5 });
  const sold = await h.seedCopy(book.id, { status: "sold" });
  const token = h.token();
  const r = await h.sale([h.book(good), h.book(sold)], { token });
  assert.equal(r.status, 409);
  assert.equal((await h.copy(good)).status, "in_stock");
  assert.equal(Number((await h.pool.query("SELECT count(*) FROM till_sales WHERE sale_token = $1", [token])).rows[0].count), 0);
  const ok = await h.sale([h.book(good)], { token, received: "5" });
  assert.equal(ok.status, 200);
});

test("empty sale, bad token, bad method are refused", async () => {
  assert.equal((await h.sale([])).status, 400);
  assert.equal((await h.sale([{ kind: "bogus" }])).status, 400);
  const book = await h.seedBook(`Bad ${h.uniq()}`);
  const c = await h.seedCopy(book.id);
  assert.equal((await h.sale([h.book(c)], { token: "short" })).status, 400);
  assert.equal((await h.sale([h.book(c)], { method: "cheque" })).status, 400);
  assert.equal((await h.copy(c)).status, "in_stock");
});

// ---------- manual items, quick items ----------

test("manual items: description, price, quantity, category validated; no stock; category stored", async () => {
  const book = await h.seedBook(`With Manual ${h.uniq()}`);
  const c = await h.seedCopy(book.id, { price: 4 });
  const man = (o) => ({ kind: "manual", description: "Tote bag", price: "7.50", quantity: 2, category: "merchandise", ...o });
  for (const [bad, re] of [
    [{ description: "" }, /description/], [{ description: "x".repeat(81) }, /80/], [{ price: "0" }, /needs a price above 0/], [{ price: "abc" }, /number/],
    [{ quantity: 0 }, /Quantity/], [{ quantity: 100 }, /Quantity/], [{ category: "nope" }, /category/],
  ]) {
    const r = await h.sale([man(bad)]);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.match(r.body.error, re);
  }
  const r = await h.sale([h.book(c), man({})], { received: "50" });
  assert.equal(r.status, 200);
  assert.equal(r.body.totalCents, 400 + 1500);
  const items = (await h.pool.query("SELECT * FROM till_sale_items WHERE sale_id = $1 ORDER BY id", [r.body.saleId])).rows;
  assert.deepEqual(items.map((i) => [i.kind, i.category, i.quantity, i.unit_price_cents, i.copy_id]), [["book", "books_used", 1, 400, c], ["manual", "merchandise", 2, 750, null]]);
  assert.equal(Number((await h.pool.query("SELECT count(*) FROM shop_sales WHERE till_sale_id = $1", [r.body.saleId])).rows[0].count), 1, "only the book has a shop_sales row");
});

test("quick items: managed on /admin/till/items, shown on the till, stock counted, refused at 0, restocked on void", async () => {
  assert.equal((await h.post("/admin/till/items", { name: "", price: "3", category: "merchandise" })).status, 200);
  assert.equal((await h.post("/admin/till/items", { name: "X", price: "0", category: "merchandise" })).status, 200);
  assert.equal((await h.post("/admin/till/items", { name: "X", price: "3", category: "bogus" })).status, 200);
  assert.equal((await h.post("/admin/till/items", { name: "Bookmark", price: "1.50", category: "merchandise", stock: "2" })).status, 302);
  const { rows } = await h.pool.query("SELECT * FROM till_quick_items WHERE name = 'Bookmark'");
  const q = rows[0];
  assert.equal(q.price_cents, 150);
  const page = await h.get("/admin/till");
  assert.match(page.text, new RegExp(`data-quick="${q.id}"`));
  assert.match(page.text, /2 left/);
  assert.match((await h.get("/admin/till/items")).text, /Bookmark/);

  const quick = (n) => ({ kind: "quick", id: q.id, quantity: n });
  const tooMany = await h.sale([quick(3)], { received: "10" });
  assert.equal(tooMany.status, 409);
  assert.match(tooMany.body.error, /2 left/);
  const s1 = await h.sale([quick(2)], { received: "10" });
  assert.equal(s1.status, 200);
  assert.equal(s1.body.totalCents, 300);
  assert.equal((await h.pool.query("SELECT stock FROM till_quick_items WHERE id = $1", [q.id])).rows[0].stock, 0);
  const none = await h.sale([quick(1)], { received: "10" });
  assert.equal(none.status, 409);

  const v = await h.post(`/admin/till/sales/${s1.body.saleId}/void`, { reason: "test" });
  assert.equal(v.status, 302);
  assert.equal((await h.pool.query("SELECT stock FROM till_quick_items WHERE id = $1", [q.id])).rows[0].stock, 2, "void restocks quick items");

  // disabled items are not sold any more and not shown
  assert.equal((await h.post(`/admin/till/items/${q.id}`, { name: "Bookmark", price: "1.50", category: "merchandise", stock: "2", active: "" })).status, 302);
  assert.doesNotMatch((await h.get("/admin/till")).text, new RegExp(`data-quick="${q.id}"`));
  assert.equal((await h.sale([quick(1)], { received: "10" })).status, 409);
});

// ---------- void ----------

test("void restocks the copies, needs a reason, removes the sale from reports, is audited, and cannot repeat", async () => {
  const { runReport, getReport } = require("../../src/lib/reports");
  const book = await h.seedBook(`Void ${h.uniq()}`);
  const c = await h.seedCopy(book.id, { price: 5 });
  const r = await h.sale([h.book(c)], { received: "5" });
  const range = { from: "2000-01-01", to: "2100-01-01" };
  const shopCount = async () => {
    const res = await runReport(h.pool, getReport("sales"), range);
    return res.sections[0].totals.shop_items;
  };
  const before = await shopCount();
  assert.ok(before >= 1);

  const noReason = await h.post(`/admin/till/sales/${r.body.saleId}/void`, { reason: "  " });
  assert.equal(noReason.status, 302);
  assert.match(noReason.headers.get("location"), /error=/);
  assert.equal((await h.copy(c)).status, "sold");

  const v = await h.post(`/admin/till/sales/${r.body.saleId}/void`, { reason: "customer changed mind" });
  assert.equal(v.status, 302);
  assert.match(v.headers.get("location"), /voided=/);
  const copy = await h.copy(c);
  assert.equal(copy.status, "in_stock");
  assert.equal(copy.sold_at, null);
  const sale = (await h.pool.query("SELECT * FROM till_sales WHERE id = $1", [r.body.saleId])).rows[0];
  assert.equal(sale.status, "voided");
  assert.equal(sale.void_reason, "customer changed mind");
  assert.equal(sale.voided_by, h.adminId);
  assert.equal(await shopCount(), before - 1, "a voided sale is not counted in the reports");
  const audits = (await h.audit("till.void")).filter((a) => a.target_id === r.body.saleId);
  assert.equal(audits.length, 1);
  // the copy can be sold again, once
  const again = await h.sale([h.book(c)], { received: "5" });
  assert.equal(again.status, 200);
  assert.equal(await shopCount(), before);
  // voiding twice does nothing
  const twice = await h.post(`/admin/till/sales/${r.body.saleId}/void`, { reason: "again" });
  assert.match(decodeURIComponent(twice.headers.get("location")), /already voided/);
  assert.equal((await h.copy(c)).status, "sold");
  // the till page lists it as voided
  assert.match((await h.get("/admin/till")).text, /\(voided\)/);
});

test("void works the same day only", async () => {
  const book = await h.seedBook(`Old Sale ${h.uniq()}`);
  const c = await h.seedCopy(book.id, { price: 5 });
  const r = await h.sale([h.book(c)], { received: "5" });
  await h.pool.query("UPDATE till_sales SET created_at = now() - interval '2 days' WHERE id = $1", [r.body.saleId]);
  const v = await h.post(`/admin/till/sales/${r.body.saleId}/void`, { reason: "too late" });
  assert.match(decodeURIComponent(v.headers.get("location")), /error=.*today/);
  assert.equal((await h.copy(c)).status, "sold");
  assert.equal((await h.pool.query("SELECT status FROM till_sales WHERE id = $1", [r.body.saleId])).rows[0].status, "completed");
});

test("sale time can be set earlier (admin, with a reason, today or yesterday), never in the future, and is audited", async () => {
  const book = await h.seedBook(`Backdate ${h.uniq()}`);
  const c = await h.seedCopy(book.id, { price: 5 });
  const why = { backdateReason: "internet was down" };
  assert.equal((await h.sale([h.book(c)], { soldAtTime: "25:99", ...why })).status, 400);
  assert.equal((await h.sale([h.book(c)], { soldAtTime: "00:00" })).status, 422, "an earlier time always needs a reason");
  assert.equal((await h.sale([h.book(c)], { soldAtTime: "00:00", soldAtDay: "last week", ...why })).status, 400, "only today or yesterday");
  const parisNow = new Date().toLocaleTimeString("en-GB", { timeZone: "Europe/Paris", hour: "2-digit", minute: "2-digit" });
  if (parisNow < "23:58") {
    const [hh, mm] = parisNow.split(":").map(Number);
    const future = `${String(Math.min(23, hh + (mm >= 59 ? 1 : 0))).padStart(2, "0")}:${String((mm + 1) % 60).padStart(2, "0")}`;
    if (future > parisNow) assert.equal((await h.sale([h.book(c)], { soldAtTime: future, ...why })).status, 400, "future time refused");
  }
  const r = await h.sale([h.book(c)], { received: "5", soldAtTime: "00:00", ...why });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const s = (await h.pool.query("SELECT adjusted_time, backdate_reason, to_char(created_at AT TIME ZONE 'Europe/Paris', 'HH24:MI') AS t FROM till_sales WHERE id = $1", [r.body.saleId])).rows[0];
  assert.equal(s.adjusted_time, true);
  assert.equal(s.t, "00:00");
  assert.equal(s.backdate_reason, "internet was down");
  const audit = (await h.audit("till.sale_backdated")).filter((a) => a.target_id === r.body.saleId);
  assert.equal(audit.length, 1);
  assert.match(audit[0].detail, /internet was down/);

  // yesterday works the same way
  const c2 = await h.seedCopy(book.id, { price: 5 });
  const y = await h.sale([h.book(c2)], { received: "5", soldAtTime: "10:15", soldAtDay: "yesterday", ...why });
  assert.equal(y.status, 200, JSON.stringify(y.body));
  const ys = (await h.pool.query("SELECT (created_at AT TIME ZONE 'Europe/Paris')::date = ((now() AT TIME ZONE 'Europe/Paris')::date - 1) AS yesterday FROM till_sales WHERE id = $1", [y.body.saleId])).rows[0];
  assert.equal(ys.yesterday, true);
  // entered_at is when it was typed in, not the time of the sale
  const e = (await h.pool.query("SELECT entered_at > created_at + interval '1 hour' AS late FROM till_sales WHERE id = $1", [y.body.saleId])).rows[0];
  assert.equal(e.late, true, "a backdated sale keeps its real entry time in entered_at");
});

// ---------- receipt ----------

test("receipt: items, total, method, TVA line, shop identity, no customer data", async () => {
  const book = await h.seedBook(`Receipt ${h.uniq()}`);
  const c = await h.seedCopy(book.id, { price: 5 });
  const r = await h.sale([h.book(c), { kind: "manual", description: "Donation <b>", price: "2", quantity: 1, category: "donation" }], { received: "10" });
  const { res, text } = await h.get(`/admin/till/sales/${r.body.saleId}/receipt`);
  assert.equal(res.status, 200);
  assert.match(text, /Ticket n° \d{4}-\d{4}/);
  assert.match(text, /7,00\s€/);
  assert.match(text, /Payé en espèces/);
  assert.match(text, /Rendu<\/td>\s*<td class="r-amt">3,00\s€/);
  assert.match(text, /TVA non applicable/);
  assert.match(text, /SIRET/);
  assert.match(text, /Donation &lt;b&gt;/, "escaped");
  assert.doesNotMatch(text, new RegExp(h.email), "no staff or customer email");
  assert.equal((await h.get("/admin/till/sales/99999999/receipt")).res.status, 404);
  assert.equal((await h.get("/admin/till/sales/abc/receipt")).res.status, 404);
});

test("audit entries exist for sale, void and override (no customer data)", async () => {
  const sales = await h.audit("till.sale");
  assert.ok(sales.length >= 5);
  for (const a of sales) {
    assert.equal(a.actor_user_id, h.adminId);
    assert.doesNotMatch(String(a.detail), /@/);
  }
});

// ---------- removed sections ----------

test("the price stickers and labels sections are gone: no pages, no links", async () => {
  const book = await h.seedBook(`Gone Book ${h.uniq()}`);
  const c = await h.seedCopy(book.id, { price: 5, location: "LBL1" });
  for (const path of ["/admin/inventory/stickers", "/admin/inventory/stickers?format=csv", "/admin/inventory/labels", `/admin/inventory/labels?id=${c}`, "/admin/till/items/1/label"]) {
    assert.notEqual((await h.get(path)).res.status, 200, path);
  }
  const pages = [
    "/admin/inventory", "/admin/inventory/scan", "/admin/inventory/scan?saved=1&label=" + c, "/admin/till", "/admin/till/items",
    `/admin/inventory/${book.id}`, `/admin/inventory/${book.id}?label=${c}`,
  ];
  for (const path of pages) {
    const { text } = await h.get(path);
    assert.doesNotMatch(text, /inventory\/(labels|stickers)|Price stickers?|Print label|sticker-chip|data-sticker/i, path);
  }
});
