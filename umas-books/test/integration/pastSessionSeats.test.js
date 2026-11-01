// A session that has already started can no longer be reserved (review 6B, M3): the calendar shows no "Add to Cart"
// for it, /cart/add-dropin refuses it with a message, a seat left in a cart is dropped (with a message) and refused
// at checkout, and the reservation itself refuses it under the class lock. English and French.
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");

const h = reserveHarness("past_session_seats", { routers: ["routes/sessions"] });
// After the harness: it points DATABASE_URL at this file's own database first.
const { createReservation } = require("../../src/lib/cart");
before(() => h.start());
after(() => h.stop());

const monthOf = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
const startsOf = async (id) => (await h.pool.query("SELECT starts_at FROM classes WHERE id = $1", [id])).rows[0].starts_at;
const cartLines = async (v) => (await v.get("/api/cart/count")).text;
const toPast = (id) => h.pool.query("UPDATE classes SET starts_at = now() - interval '2 days', ends_at = now() - interval '2 days' + interval '1 hour' WHERE id = $1", [id]);
// French pages carry no-break spaces before ":" (middleware/lang.js): compare with plain spaces.
const plain = (html) => html.replace(/[\u00a0\u202f]/g, " ");
// The card of one session on the calendar page.
const card = (html, title) => {
  const at = html.indexOf(title);
  assert.ok(at >= 0, `${title} is on the page`);
  const start = html.lastIndexOf("<details", at);
  return html.slice(start, html.indexOf("</details>", at));
};

test("the calendar shows no Add to Cart for a session that has started; a later one keeps it", async () => {
  const past = await h.session({ startsInHours: -48, endsInHours: -47, title: `Past Drop-in ${h.uniq()}` });
  const later = await h.session({ startsInHours: 24 * 3, endsInHours: 24 * 3 + 1, title: `Later Drop-in ${h.uniq()}` });
  const v = h.visitor();
  for (const id of [past, later]) {
    const { text } = await v.get(`/sessions?month=${monthOf(new Date(await startsOf(id)))}`);
    const { rows } = await h.pool.query("SELECT title FROM classes WHERE id = $1", [id]);
    const html = card(text, rows[0].title);
    if (id === past) {
      assert.ok(!html.includes(`value="${past}"`), "no add-dropin form for a past session");
      assert.match(html, /Booking closed/);
    } else {
      assert.ok(html.includes(`name="classId" value="${later}"`), "a later session can still be added");
      assert.doesNotMatch(html, /Booking closed/);
    }
  }
  const fr = h.visitor(null, { lang: "fr" });
  const { rows } = await h.pool.query("SELECT title FROM classes WHERE id = $1", [past]);
  const { text } = await fr.get(`/sessions?month=${monthOf(new Date(await startsOf(past)))}`);
  assert.match(card(text, rows[0].title), /Réservation close/);
});

test("adding a seat for a session that has started adds nothing and says why (EN and FR)", async () => {
  const past = await h.session({ startsInHours: -2, endsInHours: 1 });
  const month = monthOf(new Date(await startsOf(past)));
  const v = h.visitor();
  const r = await v.post("/cart/add-dropin", { classId: past, backTo: `/sessions?month=${month}` });
  assert.equal(r.seeOther, `/sessions?month=${month}`, "back to the same calendar view");
  assert.match(r.text, /This session has already started, so its seats can no longer be reserved\./);
  assert.match(await cartLines(v), /"count":0/);
  // Shown once only.
  assert.doesNotMatch((await v.get(`/sessions?month=${month}`)).text, /its seats can no longer be reserved/);

  const fr = h.visitor(null, { lang: "fr" });
  const rf = await fr.post("/cart/add-dropin", { classId: past, backTo: "/elsewhere" });
  assert.equal(rf.seeOther, "/fr/sessions", "only the calendar shows the message (the French calendar)");
  assert.match(plain(rf.text), /Cette séance a déjà commencé : ses places ne peuvent plus être réservées\./);
  assert.match(await cartLines(fr), /"count":0/);
});

test("a seat left in the cart for a session that has since started is dropped from the cart, with a message", async () => {
  const cls = await h.session({ startsInHours: 24, endsInHours: 25, title: `Cart Drop-in ${h.uniq()}` });
  const v = h.visitor();
  await v.post("/cart/add-dropin", { classId: cls });
  await toPast(cls);
  const page = await v.get("/cart");
  assert.match(page.text, /has already started, so we removed its seat from your cart/);
  assert.match(page.text, /Cart Drop-in/);
  assert.match(await cartLines(v), /"count":0/);
});

test("checkout refuses a seat whose session has started: nothing is reserved, no email, and the customer is told why", async () => {
  const buyer = await h.account();
  const copy = await h.copy();
  const cls = await h.session({ startsInHours: 24, endsInHours: 25, title: `Checkout Drop-in ${h.uniq()}` });
  const v = h.visitor(buyer);
  await v.post("/cart/add", { copyId: copy });
  await v.post("/cart/add-dropin", { classId: cls });
  await toPast(cls);
  const r = await v.post("/cart/reserve", { name: "Reserve Buyer", acceptCgv: "on" });
  assert.equal(r.seeOther, "/cart");
  assert.match(r.text, /has already started, so its seat can no longer be reserved\. We removed it from your cart and nothing was reserved/);
  assert.equal((await h.ordersOf(buyer)).length, 0, "no reservation");
  assert.equal(h.emailsTo(buyer.email).length, 0, "no confirmation");
  assert.equal(await h.copyStatus(copy), "in_stock");
  assert.match(await cartLines(v), /"count":1/, "the book stays in the cart");
  // Pressing Reserve again reserves the book alone.
  const again = await v.post("/cart/reserve", { name: "Reserve Buyer", acceptCgv: "on" });
  assert.match(again.location || "", /^\/cart\/return\?order=/);
});

test("guest checkout refuses it too, in French, back on the cart page", async () => {
  const cls = await h.session({ startsInHours: 24, endsInHours: 25 });
  const v = h.visitor(null, { lang: "fr" });
  await v.post("/cart/add-dropin", { classId: cls });
  await toPast(cls);
  const email = `guest-${h.uniq()}@example.test`;
  const r = await v.post("/cart/guest/reserve", { name: "Guest Buyer", email, acceptCgv: "on" });
  assert.equal(r.seeOther, "/cart");
  assert.match(plain(r.text), /a déjà commencé : il n’est plus possible d’y réserver une place\. Nous l’avons retirée de votre panier et rien n’a été réservé/);
  const { rows } = await h.pool.query("SELECT 1 FROM orders WHERE buyer_email = $1", [email]);
  assert.equal(rows.length, 0);
  assert.equal(h.emailsTo(email).length, 0);
});

test("the reservation itself refuses a session that started, under the class lock (no order, no confirmation)", async () => {
  const buyer = await h.account();
  const cls = await h.session({ startsInHours: -48, endsInHours: -46, price: 8, title: `Locked Past ${h.uniq()}` });
  await assert.rejects(
    createReservation(h.pool, {
      user: { id: buyer.id, email: buyer.email }, name: "Reserve Buyer", acceptedVersion: "test",
      items: [{ kind: "dropin", classId: cls, title: "Locked Past", startsAt: await startsOf(cls), price: 8 }],
    }),
    (err) => err.message === "SESSION_STARTED" && Array.isArray(err.sessions) && err.sessions.length === 1
  );
  assert.equal((await h.ordersOf(buyer)).length, 0);
  assert.equal(h.emailsTo(buyer.email).length, 0);
});
