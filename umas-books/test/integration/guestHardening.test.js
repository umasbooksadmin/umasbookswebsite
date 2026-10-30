// Guest checkout hardening (security review findings M1, L1, L2, L4), through the real cart routes on one in-process app
// and a real database (test/helpers/reserveHarness.js; every email, admin alerts included, lands in h.sent):
//   M1  a shop-wide ceiling on copies held by UNCONFIRMED guest holds (30), a per-connection cap on unconfirmed holds (2),
//       one neutral refusal, one admin alert an hour; confirmed holds never count; the first-mail cap does not touch
//       the confirmation-sent mail (guest_reservation_confirmed) and raises the same kind of alert
//   L1  the refusals of a guest never say anything about an address (signed-in users keep the specific messages)
//   L2  guest_reservation has its own daily budget (3) and does not use up verification / password_reset's (5)
//   L4  (the manage link of an attached order is tested in guestCheckoutApp.test.js)
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { reserveHarness } = require("../helpers/reserveHarness");

const h = reserveHarness("guest_hardening");
before(() => h.start());
after(() => h.stop());

const NEUTRAL_EN = /We cannot hold these books right now: too many reservations are waiting to be confirmed\. Please try again in a little while, or create an account\./;
const NEUTRAL_FR = /Nous ne pouvons pas garder ces livres pour le moment\s:\strop de réservations attendent d’être confirmées\. Veuillez réessayer dans un moment, ou créer un compte\./;
const TOKEN = "[0-9a-f]{64}";
const guestEmail = () => `guest-${h.uniq()}@example.test`;
const alerts = () => h.sent.filter((m) => /Guest reservation limit reached/.test(m.subject || ""));
const settle = () => new Promise((r) => setTimeout(r, 150)); // the alert is sent after the response, not awaited by it

async function reserve({ copyIds, v = h.visitor(), email = guestEmail(), lang } = {}) {
  const visitor = lang && !v.__lang ? h.visitor(null, { lang }) : v;
  for (const c of copyIds) await visitor.post("/cart/add", { copyId: c });
  const r = await visitor.post("/cart/guest/reserve", { name: "Gail Guest", email, phone: "", acceptCgv: "on" });
  const m = (r.location || "").match(/order=([0-9a-f-]{36})/);
  const order = m ? (await h.pool.query("SELECT * FROM orders WHERE access_token = $1", [m[1]])).rows[0] : null;
  return { r, order, v: visitor, email };
}
const copies = async (n) => { const out = []; for (let i = 0; i < n; i++) out.push(await h.copy()); return out; };
const confirmOf = (email) => {
  const mail = h.sent.filter((m) => m.to === email).slice(-1)[0];
  return new RegExp(`/cart/guest/confirm/(${TOKEN})`).exec(mail.text)[1];
};

test("M1: at most 30 copies are held by unconfirmed guest holds shop-wide; neutral refusal, nothing held, ONE admin alert an hour; a confirmed hold stops counting", async () => {
  const held = [];
  // 3 addresses x 10 copies = 30 copies, each address from its own connection
  for (let i = 0; i < 3; i++) held.push(await reserve({ copyIds: await copies(10) }));
  assert.ok(held.every((g) => g.order && g.order.status === "reserved"), "30 copies are allowed");
  assert.equal(alerts().length, 0, "no alert before the ceiling is hit");

  const [extra] = await copies(1);
  const over = await reserve({ copyIds: [extra] });
  assert.equal(over.order, null, "the 31st copy is refused");
  assert.equal(over.r.seeOther, "/cart/guest");
  assert.match(over.r.text, NEUTRAL_EN);
  assert.equal(await h.copyStatus(extra), "in_stock", "nothing was held");
  await settle();
  assert.equal(alerts().length, 1, "the admin is told");
  assert.doesNotMatch(alerts()[0].text, /@|example\.test/, "the alert names no address");

  // a second refusal in the same hour: still refused, no second alert
  const again = await reserve({ copyIds: [extra] });
  assert.equal(again.order, null);
  await settle();
  assert.equal(alerts().length, 1, "at most one alert an hour");

  // confirming one hold frees its copies from the ceiling (a confirmed hold is a real customer)
  const confirm = await h.visitor().post(`/cart/guest/confirm/${confirmOf(held[0].email)}`);
  assert.match(confirm.seeOther, /notice=confirmed/);
  const ok = await reserve({ copyIds: [extra] });
  assert.equal(ok.order && ok.order.status, "reserved", "room again once a hold is confirmed");
});

test("M1: at most 2 unconfirmed holds per connection; confirming one frees a place; the IP is emptied on confirm and release", async () => {
  const v = h.visitor();
  const a = await reserve({ copyIds: await copies(1), v });
  const b = await reserve({ copyIds: await copies(1), v });
  assert.ok(a.order && b.order);
  assert.ok(a.order.client_ip, "kept only to count unconfirmed holds");
  const [third] = await copies(1);
  const c = await reserve({ copyIds: [third], v });
  assert.equal(c.order, null);
  assert.match(c.r.text, NEUTRAL_EN);
  assert.equal(await h.copyStatus(third), "in_stock");
  // another connection is unaffected
  assert.ok((await reserve({ copyIds: [third] })).order);

  await h.visitor().post(`/cart/guest/confirm/${confirmOf(a.email)}`);
  assert.equal((await h.order(a.order.id)).client_ip, null, "emptied once confirmed");
  const [fourth] = await copies(1);
  assert.ok((await reserve({ copyIds: [fourth], v })).order, "a confirmed hold no longer counts against the connection");
  // released (customer cancel): emptied too
  const manage = /\/cart\/guest\/manage\/([0-9a-f]{64})/.exec(h.sent.filter((m) => m.to === b.email).slice(-1)[0].text)[1];
  await h.visitor().post(`/cart/guest/manage/${manage}/cancel`);
  assert.equal((await h.order(b.order.id)).client_ip, null);
});

test("M1/L1: a signed-in account is not subject to the guest caps and keeps its specific messages", async () => {
  const acct = await h.account();
  const v = h.visitor(acct);
  const ids = await copies(11);
  for (const c of ids) await v.post("/cart/add", { copyId: c });
  const r = await v.post("/cart/reserve", { name: "N", acceptCgv: "on" });
  assert.match(r.text + (r.seeOther || ""), /We can hold at most 10 books at a time for one account/);
  assert.doesNotMatch(r.text, NEUTRAL_EN);
});

test("M1(b)/(c): the shop-wide cap on first guest mails refuses neutrally and alerts the admin, but never blocks the confirmation-sent mail", async () => {
  const { rows } = await h.pool.query("SELECT count(*)::int AS n FROM email_outbox WHERE kind = 'guest_reservation' AND created_at > now() - interval '1 hour'");
  const before = process.env.MAIL_GLOBAL_PER_HOUR;
  const first = await reserve({ copyIds: await copies(1) });
  assert.ok(first.order);
  process.env.MAIL_GLOBAL_PER_HOUR = String(rows[0].n + 1); // the cap is now reached
  const warn = console.warn; console.warn = () => {};
  try {
    const [c] = await copies(1);
    const blocked = await reserve({ copyIds: [c] });
    assert.equal(blocked.order, null);
    assert.match(blocked.r.text, NEUTRAL_EN);
    await settle();
    assert.equal(alerts().length >= 1, true);
    const mailAlert = alerts().find((m) => /first guest-reservation emails/.test(m.text));
    assert.ok(mailAlert, "the mail-cap alert (its own hourly slot)");
    // the unconfirmed guests' mails cannot starve the confirmed ones: the confirmation is not counted in the cap, nor refused
    const confirm = await h.visitor().post(`/cart/guest/confirm/${confirmOf(first.email)}`);
    assert.match(confirm.seeOther, /notice=confirmed/);
    assert.ok(h.sent.some((m) => m.to === first.email && /Reservation|Réservation|reservation/i.test(m.subject || "")), "the full confirmation was sent");
    const { rows: [k] } = await h.pool.query("SELECT count(*)::int AS n FROM email_outbox WHERE kind = 'guest_reservation_confirmed' AND lower(to_email) = $1", [first.email]);
    assert.equal(k.n, 1);
  } finally {
    console.warn = warn;
    if (before === undefined) delete process.env.MAIL_GLOBAL_PER_HOUR; else process.env.MAIL_GLOBAL_PER_HOUR = before;
  }
});

test("L1: every limit gives a guest the same sentence (EN and FR) and never mentions the address; the form keeps the typed values", async () => {
  // per-email: 3 open reservations, then a 4th; 10 copies on one; the daily mail budget
  const email = guestEmail();
  for (let i = 0; i < 3; i++) assert.ok((await reserve({ copyIds: await copies(1), email })).order);
  const four = await reserve({ copyIds: await copies(1), email });
  assert.equal(four.order, null);
  assert.match(four.r.text, NEUTRAL_EN);
  assert.doesNotMatch(four.r.text, /already 3 open|for this email address|several emails/);
  const many = await reserve({ copyIds: await copies(11), email: guestEmail() });
  assert.match(many.r.text, NEUTRAL_EN, "too many copies: the same sentence");
  // French
  const fr = h.visitor(null, { lang: "fr" });
  await fr.post("/cart/add", { copyId: (await copies(1))[0] });
  const f = await fr.post("/cart/guest/reserve", { name: "G", email, acceptCgv: "on" });
  assert.match(f.text, NEUTRAL_FR);
  assert.match(f.text, new RegExp(`value="${email.replace(/[.+]/g, "\\$&")}"`));
});

test("L2: guest_reservation has its own daily budget (3) and does not use the recipient's verification / password_reset budget (5)", async () => {
  const outbox = require("../../src/lib/outbox");
  const q = (sql, p) => h.pool.query(sql, p);
  const mail = (to, kind) => ({ to, subject: "S", text: "t", kind });
  const send = (to, kind) => outbox.sendEmail(mail(to, kind), { db: h.pool, throttle: "skipInterval" });
  const warn = console.warn; console.warn = () => {};
  try {
    // 3 guest mails to a victim: the 4th is refused (daily) ...
    const victim = guestEmail();
    for (let i = 0; i < 3; i++) assert.ok((await send(victim, "guest_reservation")).id, `guest mail #${i + 1}`);
    assert.equal((await send(victim, "guest_reservation")).throttled, "daily");
    // ... yet the victim's own verification and password-reset mails still have their full budget of 5
    for (let i = 0; i < 3; i++) assert.ok((await send(victim, "verification")).id, `verification #${i + 1}`);
    for (let i = 0; i < 2; i++) assert.ok((await send(victim, "password_reset")).id, `reset #${i + 1}`);
    assert.equal((await send(victim, "verification")).throttled, "daily", "the other kinds' budget of 5 is unchanged");
    // and the other way round: 5 verification / reset mails do not use up the guest budget
    const other = guestEmail();
    for (let i = 0; i < 5; i++) assert.ok((await send(other, i % 2 ? "password_reset" : "verification")).id);
    assert.ok((await send(other, "guest_reservation")).id, "guest mail still allowed");
    await q("DELETE FROM email_outbox WHERE lower(to_email) IN ($1, $2)", [victim, other]);
  } finally {
    console.warn = warn;
  }
});
