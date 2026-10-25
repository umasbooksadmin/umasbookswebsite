// A drop-in session with a French title (classes.title_fr) in the customer's language: the cart page, the account page
// and the e-mails (reservation confirmation, seat reminder) show the French title to a customer reading French and the
// English one otherwise (and when no French title was written); the accounting record order_items.item_title stays
// English whatever the language of the page it was reserved from.

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");
const { loadOrderItems, orderItemLabel } = require("../../src/lib/orderItems");
const { buildSeatReminder, buildOrderConfirmationText } = require("../../src/lib/orderEmail");

const h = reserveHarness("french_text_orders");
const { pool, uniq } = h;
before(() => h.start());
after(() => h.stop());

async function sessionWithFrench(titleFr) {
  const id = await h.session({ price: 8, title: `Little Explorers ${uniq()}` });
  if (titleFr !== undefined) await pool.query("UPDATE classes SET title_fr = $2 WHERE id = $1", [id, titleFr]);
  return { id, title: (await pool.query("SELECT title FROM classes WHERE id = $1", [id])).rows[0].title };
}

test("the cart page shows the French title to a French reader, the English one to an English reader and when there is no French", async () => {
  const withFr = await sessionWithFrench("Petits Explorateurs du matin");
  const without = await sessionWithFrench();
  for (const [lang, cls, want, notWant] of [["fr", withFr, "Petits Explorateurs du matin", withFr.title], ["en", withFr, withFr.title, "Petits Explorateurs du matin"]]) {
    const v = h.visitor(null, { lang });
    await v.post("/cart/add-dropin", { classId: cls.id });
    const page = (await v.get("/cart")).text;
    assert.ok(page.includes(want), `${lang}: ${want}`);
    assert.ok(!page.includes(notWant), `${lang}: not ${notWant}`);
  }
  const v = h.visitor(null, { lang: "fr" });
  await v.post("/cart/add-dropin", { classId: without.id });
  assert.match((await v.get("/cart")).text, new RegExp(`<div class="cart-item-title" lang="en">${without.title}</div>`), "no French title: English text marked lang=en on the French cart");
});

test("a reservation made from a French page keeps the English accounting title; the confirmation e-mail and the account page use the order's language", async () => {
  const cls = await sessionWithFrench("Séance du jeudi");
  const buyer = await h.account();
  const { order } = await h.reserve(buyer, { classIds: [cls.id], lang: "fr" });
  const item = (await pool.query("SELECT item_title FROM order_items WHERE order_id = $1", [order.id])).rows[0];
  assert.ok(item.item_title.startsWith(cls.title) && !item.item_title.includes("Séance du jeudi"), `stored in English: ${item.item_title}`);
  const mails = h.emailsTo(buyer.email);
  assert.ok(mails.length >= 1);
  const confirmation = mails.find((m) => /Séance du jeudi/.test(m.text));
  assert.ok(confirmation, "the French confirmation names the French title");
  assert.ok(!confirmation.text.includes(cls.title));
  const account = await h.visitor(buyer, { lang: "fr" }).get("/account");
  assert.ok(account.text.includes("Séance du jeudi") && !account.text.includes(cls.title));
  const accountEn = await h.visitor(buyer, { lang: "en" }).get("/account");
  assert.ok(accountEn.text.includes(cls.title) && !accountEn.text.includes("Séance du jeudi"));
});

test("an English order's e-mails use the English title even when a French one exists; a French order without a French title gets the English one", async () => {
  const withFr = await sessionWithFrench("Titre français");
  const without = await sessionWithFrench();
  const buyer = await h.account();
  const en = (await h.reserve(buyer, { classIds: [withFr.id], lang: "en" })).order;
  const fr = (await h.reserve(buyer, { classIds: [without.id], lang: "fr" })).order;
  const seat = async (order) => (await loadOrderItems(pool, order.id)).find((i) => i.class_dropin_seat_id != null);

  const enItem = await seat(en);
  assert.ok(buildSeatReminder({ ...en, lang: "en" }, enItem).text.includes(withFr.title));
  assert.ok(!buildSeatReminder({ ...en, lang: "en" }, enItem).text.includes("Titre français"));
  assert.ok(buildSeatReminder({ ...en, lang: "fr" }, enItem).text.includes("Titre français"), "the same seat read in French");
  const frItem = await seat(fr);
  assert.ok(buildSeatReminder({ ...fr, lang: "fr" }, frItem).text.includes(without.title));
  assert.equal(orderItemLabel(enItem, "fr").split(" — ")[0], "Titre français");
  assert.equal(orderItemLabel(enItem, "en").split(" — ")[0], withFr.title);
  assert.equal(orderItemLabel({ ...enItem, class_title_fr: "   " }, "fr").split(" — ")[0], withFr.title, "a blank French title counts as none");
  const items = await loadOrderItems(pool, fr.id);
  assert.ok(typeof buildOrderConfirmationText({ ...fr, lang: "fr" }, items) === "string");
});
