// The barcode of an educational item (migration 116) is ADMIN ONLY: it never reaches a customer. An item with a
// barcode is put in the cart, reserved, and the cart page, the cart JSON, the confirmation page and email (text and
// HTML), the account page and the member's own data export are searched for it. The public reads (Browse page, cart)
// never select it. Real routes on the reserveHarness (the Browse page itself: eduItemsBrowse.test.js).
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");
const { gtinCheckDigit } = require("../../src/lib/barcode");

const h = reserveHarness("edu_barcode_public", { routers: ["routes/accountPrivacy"] });
const { pool, uniq } = h;
before(() => h.start());
after(() => h.stop());

const body = `40${String(Date.now()).slice(-10)}`;
const CODE = body + gtinCheckDigit(body); // a valid EAN-13 nobody else uses

test("a reserved item's barcode is on no customer page, JSON or email (EN and FR)", async () => {
  const edu = require("../../src/lib/eduItems");
  const { rows } = await pool.query("INSERT INTO edu_items (name, price, stock, barcode) VALUES ($1, 3, 5, $2) RETURNING *", [`Barcode Cards ${uniq()}`, CODE]);
  const it = rows[0];
  for (const r of await edu.loadPublicItems(pool)) assert.ok(!("barcode" in r), "the Browse read has no barcode");
  for (const r of (await edu.loadCartEduItems(pool, [it.id])).values()) assert.ok(!("barcode" in r), "the cart read has no barcode");
  for (const lang of ["en", "fr"]) {
    const account = await h.account({ lang });
    const v = h.visitor(account, { lang });
    const seen = [];
    await v.post("/cart/add-edu", { eduItemId: it.id, qty: "1", backTo: "/educational-items.html" });
    seen.push((await v.get("/cart")).text, (await v.get("/api/cart/count")).text);
    const sentBefore = h.sent.length;
    const r = await v.post("/cart/reserve", { acceptCgv: "on", name: "Barcode Buyer" });
    assert.equal(r.status, 302, r.text.slice(0, 300));
    seen.push((await v.get(r.location)).text, (await v.get("/account")).text);
    const mail = h.sent.slice(sentBefore).find((m) => m.to === account.email);
    assert.ok(mail, "a confirmation email");
    assert.ok(mail.text.includes(it.name), "the email is about this item");
    seen.push(mail.text, mail.html || "", mail.subject || "");
    const exp = await v.post("/account/privacy/export", {});
    assert.equal(exp.status, 200);
    seen.push(exp.text);
    assert.ok(seen.some((s) => s.includes(it.name)), "the item is on the pages");
    for (const s of seen) assert.ok(!s.includes(CODE), `the barcode leaked to a ${lang} customer page / email`);
  }
});
