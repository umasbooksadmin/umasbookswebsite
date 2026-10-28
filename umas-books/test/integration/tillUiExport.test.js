// Second review: admin nav, French receipt with gapless numbering,
// accounting export (refund rows, accounts, over/short, no float), mapping page,
// French CSV, add-book form, order language.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { tillHarness } = require("../helpers/tillHarness");
const { makeOrder } = require("../helpers/orderFixtures");

let h;
before(async () => { h = await tillHarness({ port: 4240, ip: "10.80.40.40" }); });
after(async () => { await h.stop(); });

const today = () => new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Paris" });
const decode = (t) => t.replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&quot;/g, '"');

async function sell(price, method = "cash") {
  const book = await h.seedBook(`UI Book ${h.uniq()}`);
  const c = await h.seedCopy(book.id, { price });
  const r = await h.sale([h.book(c)], { method });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.saleId;
}

test("admin nav: grouped sections, Till pill distinct and readable, no search box where it does nothing", async () => {
  const { text } = await h.get("/admin/members");
  for (const heading of ["Sell", "Reservations &amp; members", "Reports", "Site content", "Settings"]) assert.match(text, new RegExp(`class="admin-nav-heading"[^>]*>${heading}<`));
  assert.match(text, /class="admin-nav-till"/, "on other pages the Till pill is not 'active'");
  assert.doesNotMatch(text, /class="admin-search"/, "Accounts has no book search");
  const till = (await h.get("/admin/till")).text;
  assert.match(till, /class="admin-nav-till is-active"/);
  assert.match((await h.get("/admin")).text, /class="admin-search"/);
  const css = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../public/admin.css"), "utf8");
  assert.match(css, /\.admin-nav \.admin-nav-till\.is-active \{[^}]*color: #fff/);
  assert.match(css, /@media \(max-width: 900px\) \{[^}]*admin-layout \{ grid-template-columns: 1fr/);
  const tillCss = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../public/till.css"), "utf8");
  assert.match(tillCss, /@media \(max-width: 1100px\) \{ \.till-grid \{ grid-template-columns: minmax\(0, 1fr\)/);
});

test("till page: live regions, scanner suffix hint", async () => {
  const { text } = await h.get("/admin/till");
  assert.match(text, /id="total" aria-live="polite"/);
  assert.match(text, /id="lines-status"[^>]*aria-live="polite"/);
  assert.match(text, /suffix to <strong>Enter<\/strong>, not Tab/);
  assert.match(text, /till-change-row" aria-live="polite"/);
});

test("till on a phone: pay bar, errors above the keypad, scroll lock, card rows (markup and CSS)", async () => {
  const { text } = await h.get("/admin/till");
  assert.match(text, /class="till-paybar"[^]*id="total"[^]*id="pay-cash"[^]*id="pay-card"/, "Total, Cash and Card sit in one bar");
  assert.ok(text.indexOf('id="cash-error"') < text.indexOf('class="till-keypad"'), "a refusal is above the keypad");
  assert.ok(text.indexOf('id="cash-check"') < text.indexOf('class="till-keypad"'), "the check message is above the keypad");
  assert.match(text, /id="cash-error" class="till-err" role="alert"/);
  const css = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../public/till.css"), "utf8");
  assert.match(css, /@media \(max-width: 1100px\) \{\s*\/\* Total, Cash and Card[^]*\.till-paybar \{\s*position: fixed;[^}]*bottom: 0/);
  assert.match(css, /body\.modal-open \{ position: fixed/);
  assert.match(css, /\.till-modal-box \.till-actions \{\s*position: sticky; bottom: 0/);
  assert.match(css, /\.till-recent td\[data-label\]::before/);
  const js = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../public/till.js"), "utf8");
  assert.match(js, /classList\.add\("modal-open"\)/);
  assert.match(js, /scrollIntoView/);
  assert.match(text, /<option value="books_other"[^>]*>Other \(not new books\)<\/option>/, "the category fits a phone");
  assert.match(require("node:fs").readFileSync(require("node:path").join(__dirname, "../../views/admin/till/index.ejs"), "utf8"), /data-label="Items"/, "each cell of Today's sales has its label for the card layout");
});

test("printing hides the topbar and its heading", async () => {
  const css = require("node:fs").readFileSync(require("node:path").join(__dirname, "../../public/admin.css"), "utf8");
  const print = css.slice(css.indexOf("@media print"));
  assert.match(print, /\.admin-topbar,/, "the topbar (and its h1) is hidden when printing");
});

test("receipt: French, numbered without gaps, voided prints ANNULÉ, amounts in French format", async () => {
  const s1 = await sell(5);
  const s2 = await sell(7.5, "card");
  const s3 = await sell(2);
  const no = async (id) => (await h.pool.query("SELECT receipt_year, receipt_no FROM till_sales WHERE id = $1", [id])).rows[0];
  const [a, b, c] = [await no(s1), await no(s2), await no(s3)];
  assert.equal(b.receipt_no, a.receipt_no + 1);
  assert.equal(c.receipt_no, b.receipt_no + 1);
  // a refused sale (unknown copy) rolls back and takes no number
  const bad = await h.sale([h.book(99999999)]);
  assert.notEqual(bad.status, 200);
  const s4 = await sell(1);
  assert.equal((await no(s4)).receipt_no, c.receipt_no + 1, "no gap after a rolled-back sale");

  const r = (await h.get(`/admin/till/sales/${s1}/receipt`)).text;
  assert.match(r, /<html lang="fr">/);
  assert.match(r, new RegExp(`Ticket n° ${a.receipt_year}-${String(a.receipt_no).padStart(4, "0")}`));
  assert.match(r, /Payé en espèces/);
  assert.match(r, /Reçu/);
  assert.match(r, /Rendu/);
  assert.match(r, /Merci de votre visite/);
  assert.match(r, /TVA non applicable/);
  assert.match(r, /5,00\s€/);
  assert.doesNotMatch(r, /Receipt no|Paid by|Thank you/);
  assert.match((await h.get(`/admin/till/sales/${s2}/receipt`)).text, /Payé par carte/);

  await h.post(`/admin/till/sales/${s1}/void`, { reason: "test" });
  const v = (await h.get(`/admin/till/sales/${s1}/receipt`)).text;
  assert.match(v, /ANNULÉ/);
  assert.match(v, new RegExp(`Ticket n° ${a.receipt_year}-${String(a.receipt_no).padStart(4, "0")}`), "a voided sale keeps its number");
});

test("concurrent sales get distinct receipt numbers", async () => {
  const items = [];
  for (let i = 0; i < 4; i++) {
    const b = await h.seedBook(`Race ${h.uniq()}`);
    items.push(await h.seedCopy(b.id, { price: 3 }));
  }
  const res = await Promise.all(items.map((c) => h.sale([h.book(c)])));
  assert.ok(res.every((r) => r.status === 200));
  const { rows } = await h.pool.query("SELECT receipt_no FROM till_sales WHERE id = ANY($1)", [res.map((r) => r.body.saleId)]);
  assert.equal(new Set(rows.map((r) => r.receipt_no)).size, 4);
});

const exportRows = async (qs = "") => {
  const res = await fetch(`${h.app.base}/admin/reports/accounting?format=csv&from=2000-01-01&to=2100-01-01${qs}`, { headers: { cookie: h.jar.header(), "x-forwarded-for": h.ip } });
  return { res, text: Buffer.from(await res.arrayBuffer()).toString("utf8") }; // fetch().text() would strip the BOM
};

test("accounting export: refunds are negative rows on the refund day, accounts and label columns, over/short, float is not revenue", async () => {
  // an online order paid 10 days ago and refunded today
  const { order } = await makeOrder(h.pool, { books: 1, price: 9, paidDaysAgo: 10 });
  await h.pool.query("UPDATE orders SET status = 'refunded', refunded_at = now() WHERE id = $1", [order.id]);
  // a till day: float 50, cash sale 5, counted 52 (2 over)
  const day = today();
  assert.equal((await h.post("/admin/till/day/open", { openingFloat: "50" })).status, 302);
  const before = await h.pool.query("SELECT COALESCE(SUM(total_cents),0)::int AS t FROM till_sales WHERE status = 'completed' AND payment_method = 'cash' AND (created_at AT TIME ZONE 'Europe/Paris')::date = $1::date", [day]);
  const expected = 5000 + before.rows[0].t;
  assert.equal((await h.post("/admin/till/day/close", { day, counted: String((expected + 200) / 100), note: "" })).status, 302);

  const { res, text } = await exportRows();
  assert.equal(res.status, 200);
  const lines = text.replace(/^\uFEFF/, "").split("\r\n").filter(Boolean);
  assert.equal(lines[0], '"Date","Category","Payment method","Count","Total (EUR)","Libellé","Compte débit","Compte crédit","Journal"');
  const refund = lines.filter((l) => /,-1,-9\.00,/.test(l));
  assert.equal(refund.length, 1, lines.join("\n"));
  assert.ok(refund[0].startsWith(`"${day}"`), "dated at the refund");
  assert.match(refund[0], /"Remboursement livres d'occasion, HelloAsso/);
  const original = lines.filter((l) => /,1,9\.00,/.test(l) && l.includes("HelloAsso") && !l.startsWith(`"${day}"`));
  assert.equal(original.length, 1, "the original row stays on its own day");
  assert.match(original[0], /,"511","707","BQ"$/);
  const over = lines.filter((l) => l.includes("Cash over/short"));
  assert.equal(over.length, 1);
  assert.match(over[0], /"Cash over",0,2\.00,.*"530","758","OD"$/);
  // the float (50.00) never shows up as revenue
  assert.ok(!lines.some((l) => /,50\.00,/.test(l)), "opening float is not revenue");
  const cash = lines.filter((l) => l.includes('"Cash",') && l.includes("Books used"));
  assert.ok(cash.length && cash.every((l) => /"530","707","CA"$/.test(l)));

  const fr = await exportRows("&locale=fr");
  assert.match(fr.res.headers.get("content-disposition"), /-fr\.csv/);
  assert.ok(fr.text.startsWith("\uFEFF"));
  assert.match(fr.text, /"Cash over";0;2,00;/);
  assert.match(fr.text, /;-1;-9,00;/, "negative refund row with decimal comma");
});

test("accounting mapping page: edit is validated, saved, audited and used by the export", async () => {
  const page = await h.get("/admin/reports/accounting/mapping");
  assert.equal(page.res.status, 200);
  assert.match(page.text, /ask the treasurer to confirm/);
  const rows = (page.text.match(/name="debit_\d+"/g) || []).length;
  assert.equal(rows, 6 * 8 + 5 + 2, "8 categories x 6 methods (Bank transfer: refunds only), Discount x 5 methods (never HelloAsso), 2 over/short");
  const body = {};
  for (let i = 0; i < rows; i++) {
    const g = (f) => page.text.match(new RegExp(`name="${f}_${i}" value="([^"]*)"`))[1];
    body[`debit_${i}`] = g("debit"); body[`credit_${i}`] = g("credit"); body[`journal_${i}`] = g("journal");
  }
  const bad = await h.post("/admin/reports/accounting/mapping", { ...body, debit_0: "5 30!" });
  assert.equal(bad.status, 200);
  const ok = await h.post("/admin/reports/accounting/mapping", { ...body, credit_0: "7071" });
  assert.equal(ok.status, 302);
  const log = await h.audit("accounting.map_edit");
  assert.equal(log.length, 1);
  assert.match(log[0].detail, /Books used \/ Cash: 530\|707\|CA -> 530\|7071\|CA/);
  const book = await h.seedBook(`Map ${h.uniq()}`);
  await h.sale([h.book(await h.seedCopy(book.id, { price: 4 }))]);
  assert.match((await exportRows()).text, /Books used","Cash",\d+,[\d.]+,"[^"]*","530","7071","CA"/);
  const anon = await fetch(`${h.app.base}/admin/reports/accounting/mapping`, { redirect: "manual" });
  assert.equal(anon.status, 302);
});

test("end of day offers the French Excel download and the till CSV follows the dialect", async () => {
  const d = await h.get("/admin/till/day");
  assert.match(decode(d.text), /format=csv&locale=fr"[^>]*>Download for French Excel/);
  const fr = await fetch(`${h.app.base}/admin/till/day?day=${today()}&format=csv&locale=fr`, { headers: { cookie: h.jar.header(), "x-forwarded-for": h.ip } });
  const t = Buffer.from(await fr.arrayBuffer()).toString("utf8");
  assert.ok(t.startsWith("\uFEFF\"Sale\";\"Time (Paris)\";"));
  assert.match(t, /;\d+,\d\d;/);
  const neutral = Buffer.from(await (await fetch(`${h.app.base}/admin/till/day?day=${today()}&format=csv`, { headers: { cookie: h.jar.header(), "x-forwarded-for": h.ip } })).arrayBuffer()).toString("utf8");
  assert.match(neutral, /^\uFEFF"Sale","Time \(Paris\)",/);
});

test("order page shows the language in words, add-book form: no alert on a blank form, ISBN focused, sticky Save bar", async () => {
  const { order } = await makeOrder(h.pool, { lang: "fr" });
  assert.match((await h.get(`/admin/orders/${order.id}`)).text, /Language: French/);
  const form = (await h.get("/admin/inventory/new")).text;
  assert.doesNotMatch(form, /data-ps-review role="alert"><span data-ps-review-text>Manual review/);
  assert.match(form, /id="isbn"[^>]*autofocus/);
  assert.doesNotMatch(form, /id="price"[^>]*autofocus/);
  assert.match(form, /class="form-actions-sticky"[\s\S]*Save and add another/);
  assert.match(form, /data-ps-box hidden/);
});

test("accounting export page: the hint about the monthly email and the 10-year copy", async () => {
  const page = await h.get("/admin/reports/accounting");
  assert.match(page.text, /The previous month is also emailed to you on the 1st at 07:00 and stored for 10 years/);
  const other = await h.get("/admin/reports/accounts");
  assert.doesNotMatch(other.text, /stored for 10 years/);
});
