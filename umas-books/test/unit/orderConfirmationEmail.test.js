const test = require("node:test");
const assert = require("node:assert/strict");
const { buildOrderConfirmationText } = require("../../src/lib/orderEmail");

const order = { id: 42, buyer_name: "Ada", total_amount: "12.50", created_at: "2026-03-05T23:30:00Z" };
const items = [{ item_title: "Emma", price: "12.50" }];

test("order email states order number, Paris date, payment method, seller identity and VAT", () => {
  const t = buildOrderConfirmationText(order, items, "https://shop.test/");
  assert.match(t, /Order #42/);
  assert.match(t, /06\/03\/2026/); // 23:30 UTC is already 6 March in Paris
  assert.match(t, /Paid online via HelloAsso/);
  assert.match(t, /RNA W811011706/);
  assert.match(t, /SIRET 109 441 147 00013/);
  assert.match(t, /5 rue Hippolyte Savary, 81000 Albi/);
  assert.match(t, /TVA non applicable/);
  assert.match(t, /https:\/\/shop\.test\/terms-of-sale\.html/);
  assert.match(t, /Rue Peyrolière, 81000 Albi\) during opening hours/, "pickup is at the shop, not the registered office");
  assert.match(t, /- Emma — €12\.50/);
});

test("order email carries the withdrawal information and model form itself, in French and English (L.221-13)", () => {
  const t = buildOrderConfirmationText({ id: 7, buyer_name: "A", total_amount: 5, created_at: new Date() }, [{ item_title: "B", price: 5 }], "");
  for (const needle of ["L.221-18", "FORMULAIRE DE RÉTRACTATION", "WITHDRAWAL FORM", "Droit de rétractation", "Right of withdrawal", "CM2C", "1641", "TVA non applicable"]) {
    assert.ok(t.includes(needle), `missing ${needle}`);
  }
});

