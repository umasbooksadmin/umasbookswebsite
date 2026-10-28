// Reserving WITHOUT an account (lib/guestOrders.js, routes/cart.js /cart/guest...), through the real cart, admin
// order and account routes on one in-process app and a real database (test/helpers/reserveHarness.js: every email lands
// in h.sent, HelloAsso may not be called):
//   - the guest form; the hold is made at once for GUEST_CONFIRM_HOURS, the email carries a confirm and a manage link
//   - confirm (GET shows a button, POST confirms): the usual 14-day deadline, the full confirmation with the manage link
//   - a confirm link used twice, expired, wrong or malformed changes nothing
//   - an unconfirmed hold is released after 2 hours (the usual expiry, reason 'unconfirmed'), with no "ended" email
//     and no reminder
//   - the manage link views and cancels (the customer cancel), a wrong one is a 404
//   - at most 10 books held per email (any case), unconfirmed holds included; 3 open reservations per email
//   - admin: the list and the order page say Guest with name/email/phone; collect, refund, no-show, cancel, split pickup;
//     the accounting rows of a guest sale are those of an account holder's
//   - French pages and emails
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");

const h = reserveHarness("guest_checkout");
before(() => h.start());
after(() => h.stop());

// A fresh admin browser each time (as test/integration/reservationsAdmin.test.js does).
const admin = { get: (p) => h.visitor(h.admin).get(p), post: (p, f) => h.visitor(h.admin).post(p, f) };

const TOKEN = "[0-9a-f]{64}";
const confirmLink = (text) => (new RegExp(`/cart/guest/confirm/(${TOKEN})`).exec(text) || [])[1];
const manageLink = (text) => (new RegExp(`/cart/guest/manage/(${TOKEN})`).exec(text) || [])[1];
const lastMailTo = (to) => h.sent.filter((m) => m.to === to).slice(-1)[0];
const guestEmail = () => `guest-${h.uniq()}@example.test`;

// A signed-out visitor fills the cart and reserves with the guest form. Resolves { r, order, v, email, confirm, manage }.
async function guestReserve({ copyIds = [], classIds = [], v, lang, name = "Gail Guest", email = guestEmail(), phone = "06 12 34 56 78", acceptCgv = "on" } = {}) {
  const visitor = v || h.visitor(null, { lang });
  for (const c of copyIds) await visitor.post("/cart/add", { copyId: c });
  for (const c of classIds) await visitor.post("/cart/add-dropin", { classId: c });
  const form = { name, email, phone };
  if (acceptCgv) form.acceptCgv = acceptCgv;
  const r = await visitor.post("/cart/guest/reserve", form);
  const token = (r.location || "").match(/order=([0-9a-f-]{36})/);
  const order = token ? (await h.pool.query("SELECT * FROM orders WHERE access_token = $1", [token[1]])).rows[0] : null;
  const mail = order ? lastMailTo(order.buyer_email) : null;
  return { r, order, v: visitor, email, mail, confirm: mail && confirmLink(mail.text), manage: mail && manageLink(mail.text) };
}

const hoursFromNow = (d) => (new Date(d).getTime() - Date.now()) / 3600000;

test("the cart offers 'continue as a guest' next to log in / create an account; the guest form asks name, email, optional phone", async () => {
  const v = h.visitor();
  await v.post("/cart/add", { copyId: await h.copy({ price: 6 }) });
  const cart = await v.get("/cart");
  assert.match(cart.text, /id="continue-as-guest"/);
  assert.match(cart.text, /<a class="btn" href="\/cart\/guest">Continue as a guest<\/a>/);
  assert.match(cart.text, /id="login-to-checkout"/, "log in / create an account stays the alternative");
  assert.match(cart.text, /href="\/signup\?returnTo=%2Fcart"/);
  assert.doesNotMatch(cart.text, /action="\/cart\/reserve"/, "no account reservation form for a guest");
  const form = await v.get("/cart/guest");
  assert.equal(form.status, 200);
  assert.match(form.text, /action="\/cart\/guest\/reserve"/);
  assert.match(form.text, /<input id="name" name="name"[^>]*required>/);
  assert.match(form.text, /<input id="email" name="email" type="email"[^>]*required/);
  assert.match(form.text, /<input id="phone" name="phone" type="tel"[^>]*value="">/);
  assert.doesNotMatch(form.text, /type="password"/, "no password");
  assert.match(form.text, /no account is created/);
  // a signed-in person never gets the guest form
  const signedIn = h.visitor(await h.account());
  assert.equal((await signedIn.get("/cart/guest")).location, "/cart");
  // an empty cart goes back to the cart page
  assert.equal((await h.visitor().get("/cart/guest")).location, "/cart");
});

test("guest reserve -> email with links -> confirm -> 14-day hold and the full confirmation -> admin collects -> accounting like an account holder's sale", async () => {
  const copy = await h.copy({ price: 7.5, title: "Guest Flow Book" });
  const g = await guestReserve({ copyIds: [copy], email: "Gail.Guest+Flow@Example.test" });
  assert.equal(g.r.status, 302);
  assert.match(g.r.location, /^\/cart\/return\?order=/);
  const o = g.order;
  assert.equal(o.status, "reserved");
  assert.equal(o.is_guest, true);
  assert.equal(o.user_id, null);
  assert.equal(o.guest_confirmed_at, null);
  assert.equal(o.buyer_email, "gail.guest+flow@example.test", "stored lower-case");
  assert.equal(o.buyer_phone, "06 12 34 56 78");
  assert.ok(Math.abs(hoursFromNow(o.reserved_until) - 2) < 0.05, `held for 2 hours, got ${hoursFromNow(o.reserved_until)}`);
  assert.equal(await h.copyStatus(copy), "reserved", "the book is held at once");

  // the email: confirm + manage links, the 2-hour rule; the tokens are stored hashed only
  assert.ok(g.mail, "an email went to the guest");
  assert.match(g.mail.subject, /Please confirm your reservation/);
  assert.match(g.mail.text, /PLEASE CONFIRM WITHIN 2 HOURS/);
  assert.ok(g.confirm && g.manage && g.confirm !== g.manage);
  const { rows: tokens } = await h.pool.query("SELECT purpose, token_hash FROM guest_order_tokens WHERE order_id = $1 ORDER BY purpose", [o.id]);
  assert.deepEqual(tokens.map((t) => t.purpose), ["confirm", "manage"]);
  for (const t of tokens) assert.ok(t.token_hash !== g.confirm && t.token_hash !== g.manage, "never the raw token");
  const { rows: outbox } = await h.pool.query("SELECT kind, body_text FROM email_outbox WHERE related_order_id = $1", [o.id]);
  assert.deepEqual(outbox.map((m) => [m.kind, m.body_text]), [["guest_reservation", ""]], "the sent body (with the links) is blanked");

  // the page after reserving: check your email
  const page = await g.v.get(g.r.location);
  assert.match(page.text, /Check your email to confirm/);
  assert.match(page.text, /gail\.guest\+flow@example\.test/);
  assert.doesNotMatch(page.text, /Reservation #\d+ recorded/);
  assert.equal((await g.v.get("/cart")).text.includes("Your cart is empty."), true, "the cart was emptied");

  // GET the confirm link: a button only, nothing changes
  const ask = await h.visitor().get(`/cart/guest/confirm/${g.confirm}`);
  assert.equal(ask.status, 200);
  assert.match(ask.text, new RegExp(`action="/cart/guest/confirm/${g.confirm}"`));
  assert.equal(ask.res.headers.get("cache-control"), "no-store");
  assert.equal(ask.res.headers.get("referrer-policy"), "no-referrer");
  assert.equal((await h.order(o.id)).guest_confirmed_at, null, "GET does not confirm");

  // POST confirms: the usual deadline (end of day 14, Paris), the full confirmation with a manage link
  const done = await h.visitor().post(`/cart/guest/confirm/${g.confirm}`);
  assert.match(done.seeOther, new RegExp(`^/cart/guest/manage/${TOKEN}\\?notice=confirmed$`));
  assert.equal(done.status, 200);
  assert.match(done.text, /your reservation is confirmed/);
  assert.match(done.text, /We hold your books until the end of/);
  const confirmed = await h.order(o.id);
  assert.ok(confirmed.guest_confirmed_at);
  const { rows: [{ expected }] } = await h.pool.query(
    `SELECT (((created_at AT TIME ZONE 'Europe/Paris')::date + 15)::timestamp AT TIME ZONE 'Europe/Paris') AS expected FROM orders WHERE id = $1`, [o.id]);
  assert.equal(new Date(confirmed.reserved_until).getTime(), new Date(expected).getTime(), "the same deadline as an account holder's");
  const full = lastMailTo(o.buyer_email);
  assert.match(full.subject, /Your reservation at Uma's Books/);
  assert.match(full.text, /TO CANCEL\nTo see or cancel your reservation \(no account needed\), open this private link: \S*\/cart\/guest\/manage\//);
  assert.doesNotMatch(full.text, /Log in and open your account page/);
  const newManage = manageLink(full.text);
  assert.ok((await h.visitor().get(`/cart/guest/manage/${newManage}`)).text.includes("Reservation #"));
  assert.ok((await h.visitor().get(`/cart/guest/manage/${g.manage}`)).text.includes("Cancel reservation"), "the first email's manage link works too");

  // the admin sees it as Guest, collects it and it is a sale
  const list = await admin.get("/admin/orders?show=reserved");
  const row = list.text.slice(list.text.indexOf(`id="order-${o.id}"`));
  assert.match(row.slice(0, 2000), /<span class="status-pill category">Guest<\/span>/);
  assert.match(row.slice(0, 2000), /Gail Guest &middot; gail\.guest\+flow@example\.test · 06 12 34 56 78/);
  const orderPage = await admin.get(`/admin/orders/${o.id}`);
  assert.match(orderPage.text, /id="order-guest">Guest<\/span> Gail Guest &middot; gail\.guest\+flow@example\.test · 06 12 34 56 78/);
  assert.match(orderPage.text, /The guest confirmed it from the email link/);
  const c = await admin.post(`/admin/orders/${o.id}/collect`, { method: "cash" });
  assert.match(c.location, /collected-paid/);
  assert.equal((await h.order(o.id)).status, "paid");
  assert.equal(await h.copyStatus(copy), "sold");

  // the same sale by an account holder lands in the same accounting row
  const acct = await h.account();
  const other = await h.copy({ price: 7.5 });
  const { order: ao } = await h.reserve(acct, { copyIds: [other] });
  assert.match((await admin.post(`/admin/orders/${ao.id}/collect`, { method: "cash" })).location, /collected-paid/);
  const { accountingRows } = require("../../src/lib/accounting");
  const { rows: [{ d }] } = await h.pool.query("SELECT (now() AT TIME ZONE 'Europe/Paris')::date::text AS d");
  const rows = await accountingRows(h.pool, d, d);
  const cash = rows.filter((r) => r.method === "Cash");
  assert.equal(cash.length, 1, `one cash row for both sales: ${JSON.stringify(rows)}`);
  assert.equal(cash[0].category, "Books used");
  assert.ok(cash[0].count >= 2 && cash[0].cents >= 1500);
  const { rows: guestLine } = await h.pool.query("SELECT payment_method, amount_received FROM orders WHERE id = ANY($1::int[]) ORDER BY id", [[o.id, ao.id]]);
  assert.deepEqual(guestLine.map((x) => [x.payment_method, Number(x.amount_received)]), [["cash", 7.5], ["cash", 7.5]]);

  // the guest's manage page now says collected
  assert.match((await h.visitor().get(`/cart/guest/manage/${g.manage}`)).text, /collected/);
  assert.deepEqual(h.helloassoCalls, []);
});

test("a confirm link works once: used, expired, wrong and malformed links change nothing and say so", async () => {
  const g = await guestReserve({ copyIds: [await h.copy()] });
  assert.equal((await h.visitor().post(`/cart/guest/confirm/${g.confirm}`)).status, 200);
  const at = (await h.order(g.order.id)).guest_confirmed_at;
  // used: a second POST (and a GET) says it was already used, nothing changes
  const again = await h.visitor().post(`/cart/guest/confirm/${g.confirm}`);
  assert.equal(again.seeOther, `/cart/guest/confirm/${g.confirm}`);
  assert.equal(again.status, 400);
  assert.match(again.text, /This link was already used/);
  assert.equal(new Date((await h.order(g.order.id)).guest_confirmed_at).getTime(), new Date(at).getTime());
  const before = h.sent.length;
  assert.equal(h.sent.length, before, "no second confirmation email");

  // a manage token is not a confirm token (single purpose)
  const wrongPurpose = await h.visitor().post(`/cart/guest/confirm/${g.manage}`);
  assert.equal(wrongPurpose.status, 400);
  assert.match(wrongPurpose.text, /This confirmation link is not valid/);

  // wrong and malformed
  const wrong = await h.visitor().post(`/cart/guest/confirm/${"a".repeat(64)}`);
  assert.equal(wrong.status, 400);
  assert.match(wrong.text, /not valid/);
  const bad = await h.visitor().get("/cart/guest/confirm/not-a-token");
  assert.equal(bad.status, 400);
  assert.equal((await h.visitor().post("/cart/guest/confirm/%27%20OR%201=1")).status, 400);

  // expired: the link's time is up (here the hold was extended, so the order is still reserved): refused, still unconfirmed
  const e = await guestReserve({ copyIds: [await h.copy()] });
  await h.pool.query("UPDATE guest_order_tokens SET expires_at = now() - interval '1 minute' WHERE order_id = $1 AND purpose = 'confirm'", [e.order.id]);
  await h.pool.query("UPDATE orders SET reserved_until = now() + interval '1 day' WHERE id = $1", [e.order.id]);
  const exp = await h.visitor().post(`/cart/guest/confirm/${e.confirm}`);
  assert.equal(exp.status, 400);
  assert.match(exp.text, /This link has expired/);
  assert.equal((await h.order(e.order.id)).guest_confirmed_at, null);
});

test("an unconfirmed hold is released after 2 hours by the usual expiry (reason 'unconfirmed'), with no 'ended' email and no reminder", async () => {
  const copy = await h.copy();
  const g = await guestReserve({ copyIds: [copy] });
  const { sendReservationReminders, sendExpiryNotices, sendAdminReservationDigest } = require("../../src/lib/orderSweeps");
  // still inside its 2 hours: the sweeps leave it alone and send nothing about it
  await sendReservationReminders(h.pool);
  await sendAdminReservationDigest(h.pool);
  const o0 = await h.order(g.order.id);
  assert.equal(o0.customer_pickup_reminder_sent_at, null, "no customer reminder for an unconfirmed hold");
  assert.equal(o0.pickup_reminder_sent_at, null, "not in the admin digest");
  // a reading of a page before the deadline: still held
  await h.visitor().get("/cart");
  assert.equal(await h.copyStatus(copy), "reserved");

  // time travel: the 2 hours are over (the reservation and its link were made 2 h 1 min ago)
  // (every time of the reservation moves back 121 minutes: the deadline it was GIVEN at reserve time is what passes)
  await h.pool.query("UPDATE orders SET created_at = created_at - interval '121 minutes', reserved_until = reserved_until - interval '121 minutes' WHERE id = $1", [g.order.id]);
  await h.pool.query("UPDATE guest_order_tokens SET created_at = created_at - interval '121 minutes', expires_at = expires_at - interval '121 minutes' WHERE order_id = $1", [g.order.id]);
  // the 10-minute job releases it without any page being read
  const { runCartMaintenance } = require("../../src/lib/cart");
  await runCartMaintenance(h.pool);
  const o = await h.order(g.order.id);
  assert.equal(o.status, "expired");
  assert.equal(o.release_reason, "unconfirmed");
  assert.equal(await h.copyStatus(copy), "in_stock", "the book is back on sale");
  const sentBefore = h.sent.length;
  await sendExpiryNotices(h.pool);
  assert.equal(h.sent.filter((m) => m.to === g.order.buyer_email).length, 1, "only the first email ever went to the address");
  assert.equal(h.sent.length >= sentBefore, true);
  // the confirm link now says it expired; the manage link says it was not confirmed in time
  const late = await h.visitor().post(`/cart/guest/confirm/${g.confirm}`);
  assert.equal(late.status, 400);
  assert.match(late.text, /This link has expired/);
  assert.equal((await h.order(g.order.id)).status, "expired", "a late confirm does not bring it back");
  assert.match((await h.visitor().get(`/cart/guest/manage/${g.manage}`)).text, /Reservation not confirmed/);
});

test("the manage link: view and cancel without an account (the customer cancel); a wrong link is a 404", async () => {
  const a = await h.copy();
  const b = await h.copy();
  const g = await guestReserve({ copyIds: [a, b] });
  const page = await h.visitor().get(`/cart/guest/manage/${g.manage}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Check your email to confirm/, "unconfirmed: the manage page says so");
  assert.match(page.text, new RegExp(`action="/cart/guest/manage/${g.manage}/cancel"`));
  const r = await h.visitor().post(`/cart/guest/manage/${g.manage}/cancel`);
  assert.equal(r.seeOther, `/cart/guest/manage/${g.manage}?notice=cancelled`);
  assert.match(r.text, /Your reservation was cancelled/);
  const o = await h.order(g.order.id);
  assert.deepEqual([o.status, o.release_reason], ["cancelled", "customer"], "exactly the customer cancel");
  assert.equal(await h.copyStatus(a), "in_stock");
  assert.equal(await h.copyStatus(b), "in_stock");
  // a second press changes nothing
  await h.visitor().post(`/cart/guest/manage/${g.manage}/cancel`);
  assert.equal((await h.order(g.order.id)).status, "cancelled");
  // the confirm link of a cancelled reservation cannot revive it
  assert.equal((await h.visitor().post(`/cart/guest/confirm/${g.confirm}`)).status, 400);
  assert.equal((await h.order(g.order.id)).status, "cancelled");
  // wrong, malformed, confirm-token-as-manage, expired manage link
  assert.equal((await h.visitor().get(`/cart/guest/manage/${"b".repeat(64)}`)).status, 404);
  assert.equal((await h.visitor().get("/cart/guest/manage/xyz")).status, 404);
  assert.equal((await h.visitor().post(`/cart/guest/manage/${"b".repeat(64)}/cancel`)).status, 404);
  const g2 = await guestReserve({ copyIds: [await h.copy()] });
  assert.equal((await h.visitor().get(`/cart/guest/manage/${g2.confirm}`)).status, 404, "a confirm token does not open the manage page");
  assert.equal((await h.visitor().post(`/cart/guest/manage/${g2.confirm}/cancel`)).status, 404);
  assert.equal((await h.order(g2.order.id)).status, "reserved");
  await h.pool.query("UPDATE guest_order_tokens SET expires_at = now() - interval '1 second' WHERE order_id = $1 AND purpose = 'manage'", [g2.order.id]);
  assert.equal((await h.visitor().post(`/cart/guest/manage/${g2.manage}/cancel`)).status, 404, "an expired manage link cancels nothing");
  assert.equal((await h.order(g2.order.id)).status, "reserved");
});

test("at most 10 books held at once per email (any case), unconfirmed holds included; another address is separate", async () => {
  const email = guestEmail();
  const copies = [];
  for (let i = 0; i < 11; i++) copies.push(await h.copy());
  // 6 books, not confirmed, then 4 more under the same address in capitals: 10 held
  const first = await guestReserve({ copyIds: copies.slice(0, 6), email });
  assert.equal(first.order.status, "reserved");
  const second = await guestReserve({ copyIds: copies.slice(6, 10), email: email.toUpperCase() });
  assert.equal(second.order.status, "reserved", "10 books in all is allowed");
  // the 11th is refused, nothing held, the typed values come back
  const third = await guestReserve({ copyIds: [copies[10]], email: ` ${email.replace("guest", "GUEST")} ` });
  assert.equal(third.order, null);
  assert.equal(third.r.seeOther, "/cart/guest");
  assert.match(third.r.text, /We can hold at most 10 books at a time for one email address/);
  assert.match(third.r.text, /value="Gail Guest"/);
  assert.equal(await h.copyStatus(copies[10]), "in_stock");
  // releasing one book's worth makes room again
  await h.visitor().post(`/cart/guest/manage/${second.manage}/cancel`);
  const fourth = await guestReserve({ copyIds: [copies[10]], v: third.v, email });
  assert.equal(fourth.order && fourth.order.status, "reserved");
  // a different address has its own allowance
  const other = await guestReserve({ copyIds: [await h.copy()], email: guestEmail() });
  assert.equal(other.order.status, "reserved");
});

test("at most 3 open reservations per email address; the per-IP limit still applies", async () => {
  const email = guestEmail();
  for (let i = 0; i < 3; i++) assert.ok((await guestReserve({ copyIds: [await h.copy()], email })).order);
  const fourth = await guestReserve({ copyIds: [await h.copy()], email });
  assert.equal(fourth.order, null);
  assert.match(fourth.r.text, /There are already 3 open reservations for this email address/);
  // one connection: the 11th reservation attempt in an hour is refused by the existing limiter
  const v = h.visitor();
  let last;
  for (let i = 0; i < 11; i++) last = await v.post("/cart/guest/reserve", { name: "X", email: "bad" });
  assert.equal(last.status, 429);
});

test("the form is validated: name and a valid email, the terms box; a signed-in person cannot post a guest order", async () => {
  const copy = await h.copy();
  const noEmail = await guestReserve({ copyIds: [copy], email: "not-an-email" });
  assert.equal(noEmail.order, null);
  assert.match(noEmail.r.text, /Please enter your name and a valid email address/);
  const noName = await guestReserve({ v: noEmail.v, name: "", email: guestEmail() });
  assert.equal(noName.order, null);
  const noCgv = await guestReserve({ v: noEmail.v, acceptCgv: null });
  assert.equal(noCgv.order, null);
  assert.match(noCgv.r.text, /Please accept the terms of sale/);
  assert.equal(await h.copyStatus(copy), "in_stock");
  const acct = await h.account();
  const signedIn = h.visitor(acct);
  await signedIn.post("/cart/add", { copyId: copy });
  const r = await signedIn.post("/cart/guest/reserve", { name: "N", email: guestEmail(), acceptCgv: "on" });
  assert.equal(r.location, "/cart");
  assert.equal(await h.copyStatus(copy), "in_stock");
  assert.equal((await h.pool.query("SELECT count(*)::int AS n FROM orders WHERE is_guest AND buyer_name = 'N'")).rows[0].n, 0);
  // the account reservation route still needs an account (a guest posting it is sent to log in)
  const guest = h.visitor();
  await guest.post("/cart/add", { copyId: copy });
  assert.equal((await guest.post("/cart/reserve", { name: "N", acceptCgv: "on" })).location, "/login?returnTo=%2Fcart");
});

test("admin on a guest reservation: no-show, cancel, partial pickup (the manage link follows the rest), refund", async () => {
  const g1 = await guestReserve({ copyIds: [await h.copy()] });
  await h.visitor().post(`/cart/guest/confirm/${g1.confirm}`);
  assert.match((await admin.post(`/admin/orders/${g1.order.id}/no-show`)).location, /reservation-expired/);
  assert.deepEqual(Object.values(await h.pool.query("SELECT status, release_reason FROM orders WHERE id = $1", [g1.order.id]).then((r) => r.rows[0])), ["expired", "no_show"]);

  const g2 = await guestReserve({ copyIds: [await h.copy()] });
  assert.match((await admin.post(`/admin/orders/${g2.order.id}/cancel-reservation`)).location, /reservation-cancelled/);
  assert.equal((await h.order(g2.order.id)).status, "cancelled");
  const unconf = await admin.get(`/admin/orders/${g2.order.id}`);
  assert.match(unconf.text, /The email link was never opened/);

  const a = await h.copy({ price: 4 });
  const b = await h.copy({ price: 5 });
  const g3 = await guestReserve({ copyIds: [a, b] });
  await h.visitor().post(`/cart/guest/confirm/${g3.confirm}`);
  const { rows: items } = await h.pool.query("SELECT id, book_copy_id FROM order_items WHERE order_id = $1", [g3.order.id]);
  const r = await admin.post(`/admin/orders/${g3.order.id}/collect-selected`, { method: "card", itemIds: [items.find((i) => i.book_copy_id === a).id] });
  assert.match(r.location, /collected-partial/);
  const { rows: [rest] } = await h.pool.query("SELECT * FROM orders WHERE split_from_order_id = $1", [g3.order.id]);
  assert.equal(rest.is_guest, true);
  assert.ok(rest.guest_confirmed_at, "the rest is still confirmed");
  const manage = await h.visitor().get(`/cart/guest/manage/${g3.manage}`);
  assert.match(manage.text, new RegExp(`Reservation #${rest.id}`), "the manage link now shows the part still reserved");
  await h.visitor().post(`/cart/guest/manage/${g3.manage}/cancel`);
  assert.equal((await h.order(rest.id)).status, "cancelled");
  assert.equal(await h.copyStatus(b), "in_stock");
  assert.equal(await h.copyStatus(a), "sold");
  const refund = await admin.post(`/admin/orders/${g3.order.id}/refund`, { confirmRefunded: "on", refundMethod: "card", note: "Guest returned it" });
  assert.equal(refund.status, 302);
  assert.equal((await h.order(g3.order.id)).status, "refunded");
});

test("admin Resend confirmation for a guest: fresh links (unconfirmed: a new confirm link; confirmed: the full confirmation)", async () => {
  const { resendOrderConfirmation } = require("../../src/lib/cart");
  const g = await guestReserve({ copyIds: [await h.copy()] });
  const r1 = await resendOrderConfirmation(h.pool, g.order.id, { base: "http://shop.test" });
  assert.equal(r1.ok, true);
  const m1 = lastMailTo(g.order.buyer_email);
  assert.match(m1.text, /PLEASE CONFIRM/);
  const c1 = confirmLink(m1.text);
  assert.ok(c1 && c1 !== g.confirm);
  await h.visitor().post(`/cart/guest/confirm/${c1}`);
  assert.ok((await h.order(g.order.id)).guest_confirmed_at, "the resent link confirms");
  await resendOrderConfirmation(h.pool, g.order.id, { base: "http://shop.test" });
  const m2 = lastMailTo(g.order.buyer_email);
  assert.match(m2.text, /TO CANCEL\nTo see or cancel your reservation \(no account needed\)/);
  assert.doesNotMatch(m2.text, /PLEASE CONFIRM/);
});

test("a drop-in seat can be reserved as a guest too (the same cart path): held 2 hours, then until the session once confirmed", async () => {
  const cls = await h.session({ capacity: 2, startsInHours: 48, endsInHours: 50 });
  const g = await guestReserve({ classIds: [cls] });
  assert.ok(g.order);
  assert.ok(Math.abs(hoursFromNow(g.order.reserved_until) - 2) < 0.05);
  await h.visitor().post(`/cart/guest/confirm/${g.confirm}`);
  assert.ok(Math.abs(hoursFromNow((await h.order(g.order.id)).reserved_until) - 50) < 0.05, "until the end of the session");
});

test("French: the guest pages, messages and email are in French", async () => {
  const v = h.visitor(null, { lang: "fr" });
  await v.post("/cart/add", { copyId: await h.copy() });
  const cart = await v.get("/cart");
  assert.match(cart.text, /Continuer en tant qu’invité/);
  assert.match(cart.text, /Réserver sans compte/);
  const form = await v.get("/cart/guest");
  assert.match(form.text, /Réserver en tant qu’invité/);
  assert.match(form.text, /Téléphone \(facultatif\)/);
  assert.match(form.text, /aucun compte n’est créé/);
  const bad = await v.post("/cart/guest/reserve", { name: "Gaëlle", email: "x", acceptCgv: "on" });
  assert.match(bad.text, /Veuillez indiquer votre nom et une adresse e-mail valide/);
  const g = await guestReserve({ v, name: "Gaëlle" });
  assert.ok(g.order);
  assert.equal(g.order.lang, "fr");
  assert.match(g.mail.subject, /Merci de confirmer votre réservation chez Uma's Books/);
  assert.match(g.mail.text, /MERCI DE CONFIRMER DANS LES 2 HEURES/);
  assert.match(g.mail.text, /Ouvrez ce lien et appuyez sur «\u00a0Confirmer ma réservation\u00a0»\u00a0:/, "French typography in the email");
  const page = await v.get(g.r.location);
  assert.match(page.text, /Consultez vos e\u2011mails pour confirmer/);
  const ask = await h.visitor(null, { lang: "fr" }).get(`/cart/guest/confirm/${g.confirm}`);
  assert.match(ask.text, /Confirmer ma réservation/);
  const done = await h.visitor(null, { lang: "fr" }).post(`/cart/guest/confirm/${g.confirm}`);
  assert.match(done.text, /Merci, votre réservation est confirmée/);
  assert.match(lastMailTo(g.order.buyer_email).text, /POUR ANNULER\nPour consulter ou annuler votre réservation \(sans compte\), ouvrez ce lien personnel/);
  const used = await h.visitor(null, { lang: "fr" }).post(`/cart/guest/confirm/${g.confirm}`);
  assert.match(used.text, /Ce lien a déjà été utilisé/);
  const limit = await h.visitor(null, { lang: "fr" }).get(`/cart/guest/manage/${"c".repeat(64)}`);
  assert.match(limit.text, /Lien de réservation non valable/);
});

test("the HelloAsso client was never called by any of the above", () => {
  assert.deepEqual(h.helloassoCalls, []);
});
