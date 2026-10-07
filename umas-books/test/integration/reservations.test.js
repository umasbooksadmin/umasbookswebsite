// "Reserve online, pay at the shop": the reservation itself.
//
//  - a logged-in account reserves books and drop-in seats; NOTHING is paid
//    online and NOTHING talks to HelloAsso (the harness makes any such call throw);
//  - a guest is sent to log in (cart kept); preview mode refuses;
//  - limits (10 copies, 3 open reservations), the price guard, and races;
//  - the confirmation e-mail (through the outbox, EN and FR) and the reservation page;
//  - the customer cancels (owner only), seats follow their own cutoff.
//
// Real database, own throwaway database, unique visitor IPs (see reserveHarness).

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");
const { TERMS_OF_SALE_VERSION, RESERVATION_DAYS, MAX_RESERVED_COPIES, MAX_ACTIVE_RESERVATIONS } = require("../../src/lib/legal");

const h = reserveHarness("reservations");
before(() => h.start());
after(() => h.stop());
beforeEach(() => { h.sent.length = 0; delete process.env.PREVIEW_MODE; });

const reservedUntilDays = (order) => (new Date(order.reserved_until).getTime() - Date.now()) / 86400000;

test("a reservation: order 'reserved', copies held for the account, deadline = end of day 14, terms version stored, no payment, no HelloAsso", async () => {
  const buyer = await h.account({ displayName: "Ana Reader" });
  const a = await h.copy({ price: 6.5 });
  const b = await h.copy({ price: 4 });
  const { order, r } = await h.reserve(buyer, { copyIds: [a, b], name: "Ana Reader" });

  assert.equal(r.status, 302);
  assert.match(r.location, /^\/cart\/return\?order=[0-9a-f-]{36}$/);
  assert.equal(order.status, "reserved");
  assert.equal(order.user_id, buyer.id);
  assert.equal(order.buyer_email, buyer.email);
  assert.equal(Number(order.total_amount), 10.5);
  assert.equal(order.cgv_version, TERMS_OF_SALE_VERSION);
  assert.ok(order.cgv_accepted_at);
  assert.equal(order.paid_at, null, "nothing is paid");
  assert.equal(order.checkout_intent_id, null, "no checkout intent");
  assert.equal(order.client_ip, null, "no buyer IP is kept");
  // The deadline is the end of the 14th Paris day: between 14 and 15 days away.
  const days = reservedUntilDays(order);
  assert.ok(days > RESERVATION_DAYS && days <= RESERVATION_DAYS + 1, `deadline is ${days} days away`);
  const { rows: copies } = await h.pool.query("SELECT status, reserved_by_email, cart_order_id FROM book_copies WHERE id = ANY($1::int[])", [[a, b]]);
  for (const c of copies) {
    assert.equal(c.status, "reserved");
    assert.equal(c.reserved_by_email, buyer.email);
    assert.equal(c.cart_order_id, order.id);
  }
  const { rows: items } = await h.pool.query("SELECT price FROM order_items WHERE order_id = $1 ORDER BY id", [order.id]);
  assert.deepEqual(items.map((i) => Number(i.price)), [6.5, 4]);
  assert.deepEqual(h.helloassoCalls, [], "HelloAsso was never called");
});

test("the cart is emptied by the reservation, and the reservation page shows the deadline and 'nothing is paid online'", async () => {
  const buyer = await h.account();
  const copy = await h.copy();
  const { order, v } = await h.reserve(buyer, { copyIds: [copy] });
  assert.equal(JSON.parse((await v.get("/api/cart/count")).text).count, 0);
  const page = await v.get(`/cart/return?order=${order.access_token}`);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`Reservation #${order.id} recorded`));
  assert.match(page.text, /Nothing is paid online/);
  assert.match(page.text, /We hold your books until the end of/);
  assert.match(page.text, /Cancel reservation/, "the owner sees the cancel button");
  // Someone holding the link but not logged in sees the page, without the cancel button.
  const stranger = h.visitor();
  const view = await stranger.get(`/cart/return?order=${order.access_token}`);
  assert.equal(view.status, 200);
  assert.doesNotMatch(view.text, /Cancel reservation/);
});

test("a guest is sent to log in and creates nothing; the cart is kept", async () => {
  const copy = await h.copy();
  const g = h.visitor();
  await g.post("/cart/add", { copyId: copy });
  const before = (await h.pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n;
  const r = await g.post("/cart/reserve", { name: "Guest", acceptCgv: "on" });
  assert.equal(r.status, 302);
  assert.equal(r.location, "/login?returnTo=%2Fcart");
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM orders")).rows[0].n, before);
  assert.equal(await h.copyStatus(copy), "in_stock");
  assert.equal(JSON.parse((await g.get("/api/cart/count")).text).count, 1);
  // The old online-payment endpoint is gone.
  assert.equal((await g.post("/cart/checkout", { name: "Guest", acceptCgv: "on" })).status, 404);
});

test("the cart page offers 'Reserve (free, no commitment)' (EN) / « Réserver (gratuit, sans engagement) » (FR) and no online payment", async () => {
  const buyer = await h.account();
  const copy = await h.copy();
  for (const [lang, button, note] of [
    ["en", "Reserve (free, no commitment)", "Nothing is paid online. We hold your books for 14 days: come to the shop and pay when you collect them."],
    ["fr", "Réserver (gratuit, sans engagement)", "Rien n’est payé en ligne. Nous gardons vos livres 14 jours"],
  ]) {
    const v = h.visitor(buyer, { lang });
    await v.post("/cart/add", { copyId: copy });
    const html = (await v.get("/cart")).text.replace(/&nbsp;| /g, " ");
    assert.ok(html.includes(`>${button}</button>`), `${lang}: button`);
    assert.ok(html.includes('action="/cart/reserve"'), `${lang}: form posts to /cart/reserve`);
    assert.ok(html.replace(/&#39;/g, "'").includes(note.replace(/ /g, " ")), `${lang}: explanation`);
    assert.doesNotMatch(html, /HelloAsso|obligation (to pay|de paiement)|Pay &amp; Buy|Resume payment|Reprendre le paiement/i, `${lang}: no online-payment wording`);
  }
});

test("the confirmation e-mail goes through the outbox, in English and in French", async () => {
  for (const lang of ["en", "fr"]) {
    const buyer = await h.account({ displayName: "Mail Person" });
    const copy = await h.copy({ price: 7.25, title: `Mail Book ${lang}` });
    const { order } = await h.reserve(buyer, { copyIds: [copy], lang, name: "Mail Person" });
    const { rows: outbox } = await h.pool.query("SELECT kind, status, lang, related_order_id FROM email_outbox WHERE related_order_id = $1", [order.id]);
    assert.equal(outbox.length, 1, `${lang}: one outbox row`);
    assert.equal(outbox[0].kind, "order_confirmation");
    assert.equal(outbox[0].status, "sent");
    assert.equal(outbox[0].lang, lang);
    const mail = h.emailsTo(buyer.email);
    assert.equal(mail.length, 1);
    const body = mail[0].text;
    assert.match(body, new RegExp(`${order.id}`), "order number");
    assert.match(body, /Mail Book/, "the item");
    assert.match(body, /[Rr]ue Peyrolière/);
    assert.match(body, /CM2C/, "mediator");
    assert.match(body, /TVA non applicable/);
    assert.match(body, /\/account/, "how to cancel: the account page link");
    if (lang === "en") {
      assert.match(mail[0].subject, /^Your reservation at Uma's Books$/);
      assert.match(body, /Nothing has been paid online/);
      assert.match(body, /€7\.25/);
      assert.match(body, /Pay at the shop|PAY AT THE SHOP/i);
      assert.match(body, /We hold your books until the end of \d{1,2} \w+ 20\d\d \(Paris time\)/);
      assert.match(body, /Reserving is free and commits you to nothing/);
      assert.match(body, /Used books are not taken back for a change of mind once bought in the shop/);
      assert.doesNotMatch(body, /withdraw|WITHDRAWAL/i, "no withdrawal notice or form");
      assert.match(body, /legal guarantee of conformity/);
      assert.match(body, new RegExp(`version ${TERMS_OF_SALE_VERSION}`));
    } else {
      assert.match(mail[0].subject, /^Votre réservation chez Uma's Books$/);
      assert.match(body, /Rien n’a été payé en ligne/);
      assert.match(body, /7,25\s€/);
      assert.match(body, /À RÉGLER À LA BOUTIQUE/);
      assert.match(body, /jusqu’à la fin de la journée du \d{1,2} \w+ 20\d\d \(heure de Paris\)/);
      assert.match(body, /Réserver est gratuit et ne vous engage à rien/);
      assert.doesNotMatch(body, /rétractation/i, "no withdrawal notice or form");
      assert.match(body, /garantie légale de conformité/);
    }
    assert.doesNotMatch(body, /HelloAsso|Paid online|Payée en ligne/);
  }
});

test("a copy with no price (or 0) cannot be reserved: it never reaches the cart, and a forced reservation holds nothing", async () => {
  const buyer = await h.account();
  const free = await h.copy({ price: 0 });
  const none = await h.copy({ price: null });
  const v = h.visitor(buyer);
  await v.post("/cart/add", { copyId: free });
  await v.post("/cart/add", { copyId: none });
  assert.equal(JSON.parse((await v.get("/api/cart/count")).text).count, 0);
  const r = await v.post("/cart/reserve", { name: "X", acceptCgv: "on" });
  assert.equal(r.seeOther, "/cart", "refused with 303 to the cart");
  assert.match(r.text, /Your cart is empty/);
  assert.equal(await h.copyStatus(free), "in_stock");
  assert.equal(await h.copyStatus(none), "in_stock");
  // Even a copy whose price was cleared AFTER it was added to a cart is refused at the write.
  const ok = await h.copy({ price: 5 });
  const w = h.visitor(buyer);
  await w.post("/cart/add", { copyId: ok });
  await h.pool.query("UPDATE book_copies SET price = NULL WHERE id = $1", [ok]);
  const r2 = await w.post("/cart/reserve", { name: "X", acceptCgv: "on" });
  assert.equal(r2.seeOther, "/cart");
  assert.equal(await h.copyStatus(ok), "in_stock");
  assert.equal(await h.pool.query("SELECT 1 FROM orders WHERE user_id = $1", [buyer.id]).then((q) => q.rowCount), 0);
});

test("the terms box and the name are required; an unconfirmed account cannot reserve", async () => {
  const buyer = await h.account();
  const copy = await h.copy();
  const v = h.visitor(buyer);
  await v.post("/cart/add", { copyId: copy });
  const noTerms = await v.post("/cart/reserve", { name: "A" });
  assert.equal(noTerms.seeOther, "/cart");
  assert.match(noTerms.text, /accept the terms of sale/);
  assert.equal(await h.copyStatus(copy), "in_stock");

  const unconfirmed = await h.account({ confirmed: false });
  const u = h.visitor(unconfirmed);
  await u.post("/cart/add", { copyId: copy });
  const r = await u.post("/cart/reserve", { name: "U", acceptCgv: "on" });
  assert.equal(r.seeOther, "/cart");
  assert.match(r.text, /confirm your email address before reserving/);
  assert.equal(await h.copyStatus(copy), "in_stock");
});

test(`limits: at most ${MAX_RESERVED_COPIES} copies and ${MAX_ACTIVE_RESERVATIONS} open reservations per account, with clear messages (EN/FR)`, async () => {
  // copies
  const a = await h.account();
  const many = [];
  for (let i = 0; i < MAX_RESERVED_COPIES + 1; i++) many.push(await h.copy());
  const v = h.visitor(a, { lang: "en" });
  for (const c of many) await v.post("/cart/add", { copyId: c });
  const tooMany = await v.post("/cart/reserve", { name: "A", acceptCgv: "on" });
  assert.equal(tooMany.seeOther, "/cart");
  assert.match(tooMany.text, new RegExp(`at most ${MAX_RESERVED_COPIES} books`));
  assert.equal((await h.ordersOf(a)).length, 0);
  assert.equal(await h.copyStatus(many[0]), "in_stock");
  // exactly the maximum is fine, and then no more even for one book
  await v.post("/cart/remove", { lineId: 11 });
  const cart = (await v.get("/cart")).text;
  assert.ok(cart.includes("Reserve (free, no commitment)"));
  const keep = many.slice(0, MAX_RESERVED_COPIES);
  const w = h.visitor(a);
  for (const c of keep) await w.post("/cart/add", { copyId: c });
  const ok = await w.post("/cart/reserve", { name: "A", acceptCgv: "on" });
  assert.equal(ok.status, 302);
  const more = h.visitor(a, { lang: "fr" });
  await more.post("/cart/add", { copyId: many[MAX_RESERVED_COPIES] });
  const refused = await more.post("/cart/reserve", { name: "A", acceptCgv: "on" });
  assert.match(refused.text, new RegExp(`au plus ${MAX_RESERVED_COPIES} livres`));
  assert.equal(await h.copyStatus(many[MAX_RESERVED_COPIES]), "in_stock");

  // reservations
  const b = await h.account();
  for (let i = 0; i < MAX_ACTIVE_RESERVATIONS; i++) {
    const { order } = await h.reserve(b, { copyIds: [await h.copy()] });
    assert.equal(order.status, "reserved");
  }
  const extra = await h.copy();
  const fr = h.visitor(b, { lang: "fr" });
  await fr.post("/cart/add", { copyId: extra });
  const refusedFr = await fr.post("/cart/reserve", { name: "B", acceptCgv: "on" });
  assert.equal(refusedFr.seeOther, "/cart");
  assert.match(refusedFr.text, new RegExp(`${MAX_ACTIVE_RESERVATIONS} réservations en cours`));
  assert.equal(await h.copyStatus(extra), "in_stock");
  const en = h.visitor(b, { lang: "en" });
  await en.post("/cart/add", { copyId: extra });
  assert.match((await en.post("/cart/reserve", { name: "B", acceptCgv: "on" })).text, new RegExp(`${MAX_ACTIVE_RESERVATIONS} open reservations`));
  // Cancelling one frees a slot.
  const [first] = await h.ordersOf(b);
  assert.equal((await en.post(`/cart/reservations/${first.id}/cancel`)).location, "/account?notice=reservation-cancelled");
  assert.equal((await en.post("/cart/reserve", { name: "B", acceptCgv: "on" })).status, 302);
});

test("two accounts reserving the same single copy at the same moment: exactly one gets it", async () => {
  const copy = await h.copy();
  const [x, y] = [await h.account(), await h.account()];
  const vx = h.visitor(x);
  const vy = h.visitor(y);
  await vx.post("/cart/add", { copyId: copy });
  await vy.post("/cart/add", { copyId: copy });
  const [rx, ry] = await Promise.all([
    vx.post("/cart/reserve", { name: "X", acceptCgv: "on" }),
    vy.post("/cart/reserve", { name: "Y", acceptCgv: "on" }),
  ]);
  const winners = [rx, ry].filter((r) => r.status === 302);
  const losers = [rx, ry].filter((r) => r.seeOther === "/cart");
  assert.equal(winners.length, 1, "one reservation");
  assert.equal(losers.length, 1);
  assert.match(losers[0].text, /taken by someone else|cart is empty/, "the loser is told it is gone (or its cart is now empty)");
  assert.equal(await h.copyStatus(copy), "reserved");
  const { rows } = await h.pool.query("SELECT count(*)::int AS n FROM order_items WHERE book_copy_id = $1", [copy]);
  assert.equal(rows[0].n, 1, "the loser left no order line");
  const { rows: orders } = await h.pool.query("SELECT count(*)::int AS n FROM orders WHERE user_id = ANY($1::int[])", [[x.id, y.id]]);
  assert.equal(orders[0].n, 1, "and no order at all (it rolled back)");
});

test("the same account pressing Reserve twice at once (double click) holds the books once", async () => {
  const buyer = await h.account();
  const copy = await h.copy();
  const v = h.visitor(buyer);
  await v.post("/cart/add", { copyId: copy });
  const [r1, r2] = await Promise.all([
    v.post("/cart/reserve", { name: "Dbl", acceptCgv: "on" }),
    v.post("/cart/reserve", { name: "Dbl", acceptCgv: "on" }),
  ]);
  assert.equal([r1, r2].filter((r) => r.status === 302).length, 1);
  assert.equal((await h.ordersOf(buyer)).length, 1);
});

test("a reservation is refused in preview mode: nothing is held, friendly notice (EN/FR)", async () => {
  process.env.PREVIEW_MODE = "true";
  const buyer = await h.account();
  const copy = await h.copy();
  for (const [lang, notice] of [["en", "Online reservations open when we launch"], ["fr", "Les réservations en ligne ouvriront au lancement"]]) {
    const v = h.visitor(buyer, { lang });
    await v.post("/cart/add", { copyId: copy });
    const r = await v.post("/cart/reserve", { name: "P", acceptCgv: "on" });
    assert.equal(r.seeOther, "/cart", lang);
    assert.ok(r.text.includes(notice), lang);
  }
  assert.equal(await h.copyStatus(copy), "in_stock");
  assert.equal((await h.ordersOf(buyer)).length, 0);
  // a guest in preview mode is not sent to log in either
  const g = h.visitor();
  await g.post("/cart/add", { copyId: copy });
  const gr = await g.post("/cart/reserve", { name: "G", acceptCgv: "on" });
  assert.equal(gr.seeOther, "/cart");
  assert.ok(gr.text.includes("Online reservations open when we launch"));
});

test("a drop-in seat is reserved too: capacity counts reserved seats, a full session refuses, the deadline is the end of the session", async () => {
  const classId = await h.session({ capacity: 2, price: 9, startsInHours: 48, endsInHours: 50 });
  const [p, q, s] = [await h.account(), await h.account(), await h.account()];
  const { order: o1 } = await h.reserve(p, { classIds: [classId] });
  assert.equal(o1.status, "reserved");
  const seat = (await h.pool.query("SELECT status, order_id FROM class_dropin_seats WHERE class_id = $1", [classId])).rows[0];
  assert.equal(seat.status, "reserved");
  assert.equal(seat.order_id, o1.id);
  // Held until the session is over (about 50 hours), not 14 days.
  const hours = (new Date(o1.reserved_until).getTime() - Date.now()) / 3600000;
  assert.ok(hours > 49 && hours < 51, `deadline in ${hours} h`);
  assert.equal(o1.withdrawal_waiver_at, null, "no withdrawal waiver is asked: nothing is paid online");

  const { order: o2 } = await h.reserve(q, { classIds: [classId] });
  assert.equal(o2.status, "reserved");
  // two seats taken of two: the third person is refused, and the cart page no longer offers it
  const v = h.visitor(s);
  await v.post("/cart/add-dropin", { classId });
  assert.equal(JSON.parse((await v.get("/api/cart/count")).text).count, 0, "full: not added");
  const { rows } = await h.pool.query("SELECT count(*)::int AS n FROM class_dropin_seats WHERE class_id = $1 AND status = 'reserved'", [classId]);
  assert.equal(rows[0].n, 2);
  const mail = h.emailsTo(p.email)[0].text;
  assert.match(mail, /you pay at the session/i);
});

test("capacity race: two accounts reserve the last seat at once, only one gets it", async () => {
  const classId = await h.session({ capacity: 1, price: 5 });
  const [x, y] = [await h.account(), await h.account()];
  const vx = h.visitor(x);
  const vy = h.visitor(y);
  await vx.post("/cart/add-dropin", { classId });
  await vy.post("/cart/add-dropin", { classId });
  const [rx, ry] = await Promise.all([
    vx.post("/cart/reserve", { name: "X", acceptCgv: "on" }),
    vy.post("/cart/reserve", { name: "Y", acceptCgv: "on" }),
  ]);
  assert.equal([rx, ry].filter((r) => r.status === 302).length, 1);
  const { rows } = await h.pool.query("SELECT count(*)::int AS n FROM class_dropin_seats WHERE class_id = $1 AND status = 'reserved'", [classId]);
  assert.equal(rows[0].n, 1);
});

test("the customer cancels their own reservation: books back in stock; another account cannot (404); a second press changes nothing", async () => {
  const buyer = await h.account();
  const other = await h.account();
  const copy = await h.copy();
  const { order, v } = await h.reserve(buyer, { copyIds: [copy] });
  const intruder = h.visitor(other);
  assert.equal((await intruder.post(`/cart/reservations/${order.id}/cancel`)).status, 404);
  assert.equal((await h.order(order.id)).status, "reserved");
  assert.equal(await h.copyStatus(copy), "reserved");
  assert.equal((await h.visitor().post(`/cart/reservations/${order.id}/cancel`)).location, "/login?returnTo=%2Fcart");

  const r = await v.post(`/cart/reservations/${order.id}/cancel`);
  assert.equal(r.location, "/account?notice=reservation-cancelled");
  const after = await h.order(order.id);
  assert.equal(after.status, "cancelled");
  assert.equal(after.release_reason, "customer");
  assert.ok(after.released_at);
  assert.equal(await h.copyStatus(copy), "in_stock");
  const { rows } = await h.pool.query("SELECT reserved_by_email, cart_order_id FROM book_copies WHERE id = $1", [copy]);
  assert.equal(rows[0].reserved_by_email, null);
  assert.equal(rows[0].cart_order_id, null);
  assert.equal((await v.post(`/cart/reservations/${order.id}/cancel`)).location, "/account?notice=reservation-not-open");
  // Free again for someone else.
  assert.equal((await h.reserve(other, { copyIds: [copy] })).order.status, "reserved");
});

test("a drop-in seat can be cancelled until 24 hours before the session, not after", async () => {
  const soon = await h.session({ startsInHours: 10, capacity: 3 });
  const later = await h.session({ startsInHours: 24 * 5, capacity: 3 });
  const buyer = await h.account();
  const lateOrder = (await h.reserve(buyer, { classIds: [soon] })).order;
  const earlyOrder = (await h.reserve(buyer, { classIds: [later] })).order;
  const v = h.visitor(buyer, { lang: "en" });

  const tooLate = await v.post(`/cart/reservations/${lateOrder.id}/cancel`);
  assert.equal(tooLate.location, "/account?notice=reservation-too-late");
  assert.equal((await h.order(lateOrder.id)).status, "reserved", "nothing changed");
  const page = (await v.get("/account?notice=reservation-too-late")).text;
  assert.match(page, /only be cancelled online until 24 hours before the session/);

  const ok = await v.post(`/cart/reservations/${earlyOrder.id}/cancel`);
  assert.equal(ok.location, "/account?notice=reservation-cancelled");
  const seat = (await h.pool.query("SELECT status FROM class_dropin_seats WHERE order_id = $1", [earlyOrder.id])).rows[0];
  assert.equal(seat.status, "released");
});

test("the account page lists the reservation with its status, the deadline and a cancel button (EN/FR); no HelloAsso wording", async () => {
  const buyer = await h.account();
  const { v } = await h.reserve(buyer, { copyIds: [await h.copy({ title: `Listed Book ${h.uniq()}` })] });
  const en = (await v.get("/account")).text;
  assert.match(en, /My reservations/);
  assert.match(en, /Reserved/);
  assert.match(en, /Held until the end of/);
  assert.match(en, /Cancel reservation/);
  const fr = h.visitor(buyer, { lang: "fr" });
  const html = (await fr.get("/account")).text;
  assert.match(html, /Mes réservations/);
  assert.match(html, /Annuler la réservation/);
  assert.match(html, /Gardée jusqu’à la fin de la journée du/);
});

test("the HelloAsso client was never called by any of the above", () => {
  assert.deepEqual(h.helloassoCalls, []);
});

test("createReservation is atomic: when one book of two was taken, nothing is held, no order exists and no confirmation was queued", async () => {
  const { createReservation } = require("../../src/lib/cart");
  const buyer = await h.account();
  const [a, b] = [await h.copy({ price: 3 }), await h.copy({ price: 4 })];
  await h.pool.query("UPDATE book_copies SET status = 'sold' WHERE id = $1", [b]);
  const items = [
    { kind: "book", copyId: a, title: "A", price: 3 },
    { kind: "book", copyId: b, title: "B", price: 4 },
  ];
  await assert.rejects(createReservation(h.pool, { user: buyer, name: "Atomic", items, acceptedVersion: "v" }), /SOLD_OUT/);
  assert.equal(await h.copyStatus(a), "in_stock", "the first book was not left held");
  assert.equal((await h.ordersOf(buyer)).length, 0);
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM email_outbox WHERE to_email = $1", [buyer.email])).rows[0].n, 0);
});

test("createReservation called twice at once for one copy (the route's check bypassed): one succeeds, the other is SOLD_OUT", async () => {
  const { createReservation } = require("../../src/lib/cart");
  const copy = await h.copy({ price: 3 });
  const [x, y] = [await h.account(), await h.account()];
  const items = [{ kind: "book", copyId: copy, title: "Race", price: 3 }];
  const res = await Promise.allSettled([
    createReservation(h.pool, { user: x, name: "X", items, acceptedVersion: "v" }),
    createReservation(h.pool, { user: y, name: "Y", items, acceptedVersion: "v" }),
  ]);
  assert.equal(res.filter((r) => r.status === "fulfilled").length, 1);
  const lost = res.find((r) => r.status === "rejected");
  assert.equal(lost.reason.message, "SOLD_OUT");
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM order_items WHERE book_copy_id = $1", [copy])).rows[0].n, 1);
});

test("French pages use French typography: no-break space before ':' and curly apostrophes on the cart and reservation pages", async () => {
  const buyer = await h.account();
  const copy = await h.copy();
  const v = h.visitor(buyer, { lang: "fr" });
  await v.post("/cart/add", { copyId: copy });
  const cart = (await v.get("/cart")).text;
  assert.match(cart, /Total\u00a0:/);
  assert.match(cart, /Rien n’est payé en ligne/);
  const { order } = await h.reserve(buyer, { copyIds: [await h.copy()], v: h.visitor(buyer, { lang: "fr" }) });
  const page = (await h.visitor(buyer, { lang: "fr" }).get(`/cart/return?order=${order.access_token}`)).text;
  assert.match(page, /Total à régler à la boutique\u00a0:/);
  assert.match(page, /Nous gardons vos livres jusqu’à la fin de la journée du/);
  const plain = page.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, "").match(/[a-zé] [:?!;]/g); assert.equal(plain, null, "no plain space left before ; : ! ?");
});

test(`the limits cannot be raced past: ${MAX_ACTIVE_RESERVATIONS + 2} reservations of different books pressed at once give exactly ${MAX_ACTIVE_RESERVATIONS}`, async () => {
  const buyer = await h.account();
  const visitors = [];
  for (let i = 0; i < MAX_ACTIVE_RESERVATIONS + 2; i++) {
    const v = h.visitor(buyer);
    await v.post("/cart/add", { copyId: await h.copy() });
    visitors.push(v);
  }
  const results = await Promise.all(visitors.map((v) => v.post("/cart/reserve", { name: "Racer", acceptCgv: "on" })));
  assert.equal(results.filter((r) => r.status === 302).length, MAX_ACTIVE_RESERVATIONS);
  assert.equal((await h.ordersOf(buyer)).length, MAX_ACTIVE_RESERVATIONS);
  const held = (await h.pool.query(
    "SELECT count(*)::int AS n FROM book_copies c JOIN orders o ON o.id = c.cart_order_id WHERE o.user_id = $1 AND c.status = 'reserved'", [buyer.id])).rows[0].n;
  assert.equal(held, MAX_ACTIVE_RESERVATIONS);
});

test("createReservation refuses a copy whose price is missing or 0 at the moment of the write, whatever the cart said", async () => {
  const { createReservation } = require("../../src/lib/cart");
  const buyer = await h.account();
  const [unpriced, free] = [await h.copy({ price: null }), await h.copy({ price: 0 })];
  for (const copyId of [unpriced, free]) {
    await assert.rejects(
      createReservation(h.pool, { user: buyer, name: "Price", items: [{ kind: "book", copyId, title: "P", price: 5 }], acceptedVersion: "v" }),
      /SOLD_OUT/
    );
    assert.equal(await h.copyStatus(copyId), "in_stock");
  }
  assert.equal((await h.ordersOf(buyer)).length, 0);
});
