// Proof of acceptance of the terms of sale: the reservation stores when (and
// which version) in orders.cgv_accepted_at / cgv_version, in the same
// transaction that creates the order; without the checkbox no order exists; the
// proof is in the member data export and survives erasure (anonymised orders
// keep it); and the reservation confirmation e-mail carries it.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");

const h = reserveHarness("cgv_acceptance");
const { pool, uniq } = h;
const { TERMS_OF_SALE_VERSION } = require("../../src/lib/legal");
before(() => h.start());
after(() => h.stop());

test("TERMS_OF_SALE_VERSION is a date string", () => {
  assert.match(TERMS_OF_SALE_VERSION, /^\d{4}-\d{2}-\d{2}$/);
});

test("reserving stores cgv_accepted_at and the current cgv_version on the new order", async () => {
  const buyer = await h.account();
  const before = Date.now();
  const { order, r } = await h.reserve(buyer, { copyIds: [await h.copy()], name: "Cgv Buyer" });
  assert.equal(r.status, 302);
  assert.ok(order.cgv_accepted_at instanceof Date);
  assert.ok(Math.abs(order.cgv_accepted_at.getTime() - before) < 60_000);
  assert.equal(order.cgv_version, TERMS_OF_SALE_VERSION);
});

test("reserving without the terms checkbox is refused: no order, nothing stored, nothing held", async () => {
  const buyer = await h.account();
  const copyId = await h.copy();
  const v = h.visitor(buyer);
  await v.post("/cart/add", { copyId });
  const { status, text } = await v.post("/cart/reserve", { name: "No Cgv" });
  assert.equal(status, 200);
  assert.match(text, /Please accept the terms of sale/);
  assert.equal((await h.ordersOf(buyer)).length, 0);
  assert.equal(await h.copyStatus(copyId), "in_stock");
});

// The version string changes whenever the terms change in substance.
// 2026-10-07: online payment is gone, books and seats are reserved and paid at the shop.
test("the reservation confirmation email carries the acceptance line and the current version, in English and in French", async () => {
  for (const [lang, line] of [
    ["en", new RegExp(`Terms of sale accepted on \\d{1,2} \\w+ \\d{4} \\(version ${TERMS_OF_SALE_VERSION}\\)\\.`)],
    ["fr", new RegExp(`Conditions générales de vente acceptées le \\d{1,2} \\S+ \\d{4} \\(version ${TERMS_OF_SALE_VERSION}\\)\\.`)],
  ]) {
    const buyer = await h.account();
    const { order } = await h.reserve(buyer, { copyIds: [await h.copy()], lang, name: "Mail Buyer" });
    assert.equal(order.lang, lang);
    const mail = h.emailsTo(buyer.email)[0];
    assert.ok(mail, "confirmation sent");
    assert.match(mail.text, line, lang);
  }
  assert.equal(TERMS_OF_SALE_VERSION, "2026-10-09", "bump this test with the terms");
});

test("the proof is in the member data export and survives erasure (anonymised order keeps it)", async () => {
  const email = `cgvexp-${uniq()}@example.test`;
  const account = await h.account({ email, displayName: "Export Buyer" });
  await h.reserve(account, { copyIds: [await h.copy()], name: "Export Buyer" });
  const { buildMemberExport } = require("../../src/lib/memberExport");
  const data = await buildMemberExport(pool, account.id);
  assert.equal(data.orders.length, 1);
  assert.equal(data.orders[0].cgv_version, TERMS_OF_SALE_VERSION);
  assert.ok(data.orders[0].cgv_accepted_at);

  const privacy = require("../../src/lib/privacy");
  await privacy.eraseMember(pool, account.id);
  const { rows } = await pool.query("SELECT buyer_email, cgv_accepted_at, cgv_version FROM orders WHERE id = $1", [data.orders[0].id]);
  assert.notEqual(rows[0].buyer_email, email);
  assert.equal(rows[0].cgv_version, TERMS_OF_SALE_VERSION);
  assert.ok(rows[0].cgv_accepted_at);
});

// The legal text (no-returns notice, shop info, VAT
// line, acceptance line) must be in the QUEUED confirmation (outbox row) and in
// the copy the admin "Resend confirmation" queues: same builder.
test("the queued confirmation and the resent one both carry the legal text", async () => {
  const { resendOrderConfirmation } = require("../../src/lib/cart");
  const buyer = await h.account();
  const { order } = await h.reserve(buyer, { copyIds: [await h.copy()], lang: "fr", name: "Queue Buyer" });
  assert.deepEqual((await resendOrderConfirmation(pool, order.id)).ok, true);
  const { rows } = await pool.query("SELECT body_text FROM email_outbox WHERE related_order_id = $1 AND kind = 'order_confirmation' ORDER BY id", [order.id]);
  assert.equal(rows.length, 2, "one queued at the reservation, one by the resend");
  for (const { body_text } of rows) {
    const t = body_text.replace(/[\u00a0\u202f]/g, " "); // French typography uses non-breaking spaces
    assert.ok(!/FORMULAIRE DE RÉTRACTATION|WITHDRAWAL FORM|L\.221-18/.test(t), "no withdrawal notice or form in a reservation email");
    for (const needle of [
      "Used books are not taken back for a change of mind once bought in the shop; the legal guarantees still apply.",
      "Les livres d’occasion ne sont ni repris ni échangés pour simple changement d’avis une fois achetés en boutique",
      "rue Peyrolière, 81000 Albi. Venez retirer vos livres pendant nos horaires habituels, du mercredi au samedi, de 14 h à 19 h.",
      "Conditions générales de vente acceptées le",
      "TVA non applicable",
      "CM2C",
    ]) assert.ok(t.includes(needle), `missing: ${needle}`);
  }
});
