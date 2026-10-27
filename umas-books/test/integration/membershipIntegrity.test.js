// Membership payment integrity (src/lib/membership.js, middleware/auth.js):
//  - a membership lasts one CALENDAR year in Paris time and ends at the end of that Paris day; renewing early
//    loses no time: last day = one year after max(paid day, current last day);
//  - an old payment found late (already past) grants nothing;
//  - a 0 EUR "payment" is not a membership; an optional form slug restricts it;
//  - a payment whose payer email matches no confirmed account is KEPT as an
//    unmatched payment, alerted to the admin (throttled), listed on
//    /admin/members and linked to an account by an admin in one transaction;
//  - attachUser trusts is_member only while member_expires_at is in the future;
//  - end dates are shown in Paris time (not UTC).
//
// In-process: HelloAsso lookups and the mailer are stubbed.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");
const { createAccount } = require("../helpers/accounts");

const h = adminHarness("membership_integrity", ["members"], { isolated: true });

const mailer = require("../../src/mailer");
const sent = [];
let failSends = false;
mailer.sendMail = async (opts) => { if (failSends) throw new Error("smtp down"); sent.push(opts); };

const helloasso = require("../../src/lib/helloasso");
let orders = new Map(); // lower-case email -> HelloAsso orders
helloasso.findMembershipOrdersByEmail = async (email) => orders.get(email.toLowerCase()) || [];

const errorAlert = require("../../src/lib/errorAlert");
const membership = require("../../src/lib/membership");
const { attachUser } = require("../../src/middleware/auth");
const { isoDateParis } = require("../../src/lib/memberStatus");

const DAY = 24 * 60 * 60 * 1000;
const ago = (days) => new Date(Date.now() - days * DAY);

before(() => h.start());
after(() => h.stop());
beforeEach(() => {
  sent.length = 0;
  failSends = false;
  orders = new Map();
  delete process.env.HELLOASSO_MEMBERSHIP_FORM_SLUG;
  errorAlert.setAlertRetryDelay(0);
});

let nextId = 5_000_000;
const order = (email, paidAt, { cents = 1500, slug } = {}) => ({
  id: ++nextId, date: paidAt.toISOString(), payer: { email }, amount: { total: cents }, payments: [{ state: "Authorized" }],
  ...(slug ? { formSlug: slug } : {}),
});
const email = (label) => `${label}-${h.uniq()}@example.test`;
const account = (e, opts = {}) => createAccount(h.pool, { email: e, ...opts });
const userRow = async (e) => (await h.q("SELECT * FROM users WHERE email = $1", [e]))[0];
const sync = (e) => membership.syncMembershipForEmail(h.pool, e);
const close = (a, b, ms = 5000) => Math.abs(new Date(a) - new Date(b)) <= ms;
// The expected end, worked out by POSTGRES (an independent oracle): the last millisecond of the Paris day one year
// after the given Paris day (PG clamps 29 February to 28 February).
const endOfYearFrom = async (instantOrDay) => (await h.q(
  `SELECT ((((($1::timestamptz) AT TIME ZONE 'Europe/Paris')::date + interval '1 year' + interval '1 day')::timestamp AT TIME ZONE 'Europe/Paris') - interval '1 millisecond') AS t`,
  [instantOrDay]
))[0].t;

// ---------- grant arithmetic ----------

test("a first payment grants one calendar year, to the end of that Paris day", async () => {
  const e = email("first");
  await account(e);
  const paid = ago(10);
  orders.set(e, [order(e, paid)]);
  await sync(e);
  const u = await userRow(e);
  assert.equal(u.is_member, true);
  assert.ok(close(u.member_expires_at, await endOfYearFrom(paid)), `got ${u.member_expires_at}`);
});

test("renewing at day 300 gives a year from the OLD end date, not from the payment", async () => {
  const e = email("renew");
  await account(e);
  const first = ago(300);
  const second = ago(0);
  const o1 = order(e, first);
  orders.set(e, [o1]);
  await sync(e);
  orders.set(e, [o1, order(e, second)]);
  await sync(e);
  const u = await userRow(e);
  const twoYears = await endOfYearFrom(await endOfYearFrom(first));
  assert.ok(close(u.member_expires_at, twoYears), `expected two years after the first payment day, got ${u.member_expires_at}`);
  // And it is idempotent: syncing again adds nothing.
  await sync(e);
  assert.ok(close((await userRow(e)).member_expires_at, twoYears));
});

test("renewing after the membership lapsed starts from the payment date", async () => {
  const e = email("lapsed");
  await account(e);
  const first = ago(500); // ended 135 days ago
  const second = ago(5);
  orders.set(e, [order(e, first), order(e, second)]);
  await sync(e);
  const u = await userRow(e);
  assert.ok(close(u.member_expires_at, await endOfYearFrom(second)));
});

test("a payment older than a year found late grants nothing (no is_member with a past end date)", async () => {
  const e = email("old");
  await account(e);
  orders.set(e, [order(e, ago(400))]);
  await sync(e);
  const u = await userRow(e);
  assert.equal(u.is_member, false);
  assert.equal(u.member_expires_at, null);
  assert.equal((await h.q("SELECT COUNT(*)::int AS n FROM membership_payments WHERE payer_email = $1", [e]))[0].n, 1, "still recorded");
});

test("a 0 EUR order is not a membership", async () => {
  const e = email("zero");
  await account(e);
  orders.set(e, [order(e, ago(1), { cents: 0 })]);
  await sync(e);
  assert.equal((await userRow(e)).is_member, false);
  assert.equal((await h.q("SELECT COUNT(*)::int AS n FROM membership_payments WHERE payer_email = $1", [e]))[0].n, 0);
});

test("with HELLOASSO_MEMBERSHIP_FORM_SLUG set only that form counts; unset, any membership form does", async () => {
  const e1 = email("slug-ok");
  const e2 = email("slug-other");
  await account(e1);
  await account(e2);
  process.env.HELLOASSO_MEMBERSHIP_FORM_SLUG = "adhesion-2026";
  orders.set(e1, [order(e1, ago(1), { slug: "adhesion-2026" })]);
  orders.set(e2, [order(e2, ago(1), { slug: "stage-ete" })]);
  await sync(e1);
  await sync(e2);
  assert.equal((await userRow(e1)).is_member, true);
  assert.equal((await userRow(e2)).is_member, false);
  delete process.env.HELLOASSO_MEMBERSHIP_FORM_SLUG;
  await sync(e2);
  assert.equal((await userRow(e2)).is_member, true);
});

test("a refunded payment still revokes (and a recorded 0 EUR row grants nothing)", async () => {
  const e = email("refund");
  await account(e);
  const o = order(e, ago(2));
  orders.set(e, [o]);
  await sync(e);
  assert.equal((await userRow(e)).is_member, true);
  orders.set(e, [{ ...o, payments: [{ state: "Refunded" }] }]);
  await sync(e);
  assert.equal((await userRow(e)).is_member, false);
});

// ---------- unmatched payments ----------

test("a payment from an email with no account is kept as unmatched and alerts the admin once an hour", async () => {
  const typo = email("tpyo");
  orders.set(typo, [order(typo, ago(1))]);
  await sync(typo);
  const [p] = await h.q("SELECT * FROM membership_payments WHERE payer_email = $1", [typo]);
  assert.equal(p.user_id, null);
  assert.ok(p.unmatched_at);
  assert.equal(p.unmatched_reason, "no_account");
  assert.equal(p.amount_cents, 1500);
  const alerts = sent.filter((m) => /matches no confirmed account/.test(m.subject));
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].subject, new RegExp(`Membership payment from ${typo.replace(/[.+]/g, "\\$&")} matches no confirmed account`));
  assert.match(alerts[0].text, /Link to account/);

  // A second one within the hour: recorded, but no second alert yet.
  sent.length = 0;
  const typo2 = email("tpyo2");
  orders.set(typo2, [order(typo2, ago(1))]);
  await sync(typo2);
  await membership.alertUnmatchedPayments(h.pool);
  assert.equal(sent.length, 0, "throttled");
  assert.equal((await h.q("SELECT COUNT(*)::int AS n FROM membership_payments WHERE user_id IS NULL AND unmatched_at IS NOT NULL AND alerted_at IS NULL"))[0].n >= 1, true);

  // An hour later the next alert covers the one still unalerted.
  await h.q("UPDATE membership_payments SET alerted_at = alerted_at - interval '61 minutes' WHERE alerted_at IS NOT NULL");
  await membership.alertUnmatchedPayments(h.pool);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, new RegExp(`from ${typo2.replace(/[.+]/g, "\\$&")} matches no confirmed account|matches no confirmed account`));
  // And never again for the same payments.
  sent.length = 0;
  await h.q("UPDATE membership_payments SET alerted_at = alerted_at - interval '61 minutes' WHERE alerted_at IS NOT NULL");
  await membership.alertUnmatchedPayments(h.pool);
  assert.equal(sent.length, 0);
});

test("an alert that cannot be sent is retried (the claim is handed back)", async () => {
  await h.q("UPDATE membership_payments SET alerted_at = alerted_at - interval '61 minutes' WHERE alerted_at IS NOT NULL");
  const e = email("alertfail");
  orders.set(e, [order(e, ago(1))]);
  failSends = true;
  const realError = console.error;
  console.error = () => {};
  try { await sync(e); } finally { console.error = realError; }
  failSends = false;
  assert.equal((await h.q("SELECT alerted_at FROM membership_payments WHERE payer_email = $1", [e]))[0].alerted_at, null);
  await membership.alertUnmatchedPayments(h.pool);
  assert.equal(sent.filter((m) => /matches no confirmed account/.test(m.subject)).length, 1);
});

test("an account with an unconfirmed email never gets the payment; it is kept unmatched, then attached once confirmed", async () => {
  const e = email("unconfirmed");
  await account(e, { confirmed: false });
  orders.set(e, [order(e, ago(1))]);
  await sync(e);
  assert.equal((await userRow(e)).is_member, false);
  const [p] = await h.q("SELECT user_id, unmatched_reason FROM membership_payments WHERE payer_email = $1", [e]);
  assert.equal(p.user_id, null);
  assert.equal(p.unmatched_reason, "unverified");
  await h.q("UPDATE users SET email_verified_at = now() WHERE email = $1", [e]);
  await sync(e);
  assert.equal((await userRow(e)).is_member, true);
  const [after_] = await h.q("SELECT user_id, unmatched_at FROM membership_payments WHERE payer_email = $1", [e]);
  assert.ok(after_.user_id);
  assert.equal(after_.unmatched_at, null);
});

test("/admin/members lists unmatched payments and 'Link to account' attaches the payment and grants, in one step", async () => {
  const typo = email("typo-payer");
  const real = email("real-account");
  const acc = await account(real, { displayName: "Real Person" });
  const paid = ago(20);
  orders.set(typo, [order(typo, paid)]);
  await sync(typo);
  const [p] = await h.q("SELECT id FROM membership_payments WHERE payer_email = $1", [typo]);

  let { text } = await h.get("/admin/members");
  assert.match(text, /Unmatched membership payments/);
  assert.match(text, new RegExp(typo.replace(/[.+]/g, "\\$&")));

  // Search for the account (by email), then link.
  ({ text } = await h.get(`/admin/members?linkPayment=${p.id}&linkQ=${encodeURIComponent(real.slice(0, 12))}`));
  assert.match(text, /Link to account/);
  assert.match(text, /Real Person/);

  const anon = await h.post(`/admin/members/unmatched/${p.id}/link`, { userId: acc.id }, { user: h.member });
  assert.equal(anon.res.status, 403);
  assert.equal((await userRow(real)).is_member, false);

  const { res } = await h.post(`/admin/members/unmatched/${p.id}/link`, { userId: acc.id });
  assert.match(res.headers.get("location"), /linkNotice=linked/);
  const u = await userRow(real);
  assert.equal(u.is_member, true);
  assert.ok(close(u.member_expires_at, await endOfYearFrom(paid)));
  const [linked] = await h.q("SELECT user_id, unmatched_at, linked_at FROM membership_payments WHERE id = $1", [p.id]);
  assert.equal(linked.user_id, acc.id);
  assert.equal(linked.unmatched_at, null);
  assert.ok(linked.linked_at);
  assert.equal((await h.q("SELECT COUNT(*)::int AS n FROM admin_audit_log WHERE action = 'membership.link_payment' AND target_id = $1", [p.id]))[0].n, 1);

  // Gone from the list, and linking it again is refused without side effects.
  ({ text } = await h.get("/admin/members"));
  assert.doesNotMatch(text, new RegExp(typo.replace(/[.+]/g, "\\$&")));
  const again = await h.post(`/admin/members/unmatched/${p.id}/link`, { userId: acc.id });
  assert.match(again.res.headers.get("location"), /linkNotice=payment_gone/);
});

test("linking to a disabled account, or with no account chosen, is refused and changes nothing", async () => {
  const typo = email("typo2");
  const dis = email("disabled");
  const acc = await account(dis);
  await h.q("UPDATE users SET is_disabled = TRUE WHERE id = $1", [acc.id]);
  orders.set(typo, [order(typo, ago(3))]);
  await sync(typo);
  const [p] = await h.q("SELECT id FROM membership_payments WHERE payer_email = $1", [typo]);
  let r = await h.post(`/admin/members/unmatched/${p.id}/link`, { userId: acc.id });
  assert.match(r.res.headers.get("location"), /linkNotice=disabled/);
  r = await h.post(`/admin/members/unmatched/${p.id}/link`, {});
  assert.match(r.res.headers.get("location"), /linkNotice=no_account/);
  assert.equal((await h.q("SELECT user_id FROM membership_payments WHERE id = $1", [p.id]))[0].user_id, null);
});

test("linking a year-old payment attaches it but grants nothing", async () => {
  const typo = email("typo-old");
  const real = email("real-old");
  const acc = await account(real);
  orders.set(typo, [order(typo, ago(400))]);
  await sync(typo);
  const [p] = await h.q("SELECT id FROM membership_payments WHERE payer_email = $1", [typo]);
  await h.post(`/admin/members/unmatched/${p.id}/link`, { userId: acc.id });
  assert.equal((await userRow(real)).is_member, false);
});

// ---------- attachUser ----------

async function runAttachUser(userId, passwordChangedAt) {
  const req = { session: { user: { id: userId, passwordChangedAt: passwordChangedAt.getTime(), activeDay: new Date().toISOString().slice(0, 10) } } };
  const res = { locals: {} };
  await new Promise((resolve, reject) => attachUser(h.pool)(req, res, (err) => (err ? reject(err) : resolve())));
  return req.session.user;
}

test("attachUser: a member whose end date has passed is not a member, even before the 6-hourly sweep", async () => {
  const expired = await account(email("expired"), { isMember: true, memberExpiresAt: ago(1) });
  const active = await account(email("active"), { isMember: true, memberExpiresAt: new Date(Date.now() + 30 * DAY) });
  const manual = await account(email("manual"), { isMember: true, memberExpiresAt: null });
  const none = await account(email("nonmember"));
  assert.equal((await runAttachUser(expired.id, expired.password_changed_at)).isMember, false);
  assert.equal((await runAttachUser(active.id, active.password_changed_at)).isMember, true);
  assert.equal((await runAttachUser(manual.id, manual.password_changed_at)).isMember, true, "a hand-granted membership never lapses");
  assert.equal((await runAttachUser(none.id, none.password_changed_at)).isMember, false);
});

// ---------- Paris time ----------

test("end dates are Paris calendar dates, not UTC", () => {
  // 23:30 UTC on 31 Oct is already 1 November in Paris (UTC+1 after the clock change).
  const d = new Date("2026-10-31T23:30:00Z");
  assert.equal(d.toISOString().slice(0, 10), "2026-10-31");
  assert.equal(isoDateParis(d), "2026-11-01");
  // Summer: 22:30 UTC on 30 June is 00:30 on 1 July in Paris (UTC+2).
  assert.equal(isoDateParis(new Date("2026-06-30T22:30:00Z")), "2026-07-01");
  assert.equal(isoDateParis(new Date("2026-06-30T12:00:00Z")), "2026-06-30");
});

test("the membership page shows the Paris date of the end of membership", async () => {
  const { membershipPageState } = require("../../src/lib/membershipPage");
  const end = new Date("2026-12-31T23:30:00Z"); // 1 January 2027, 00:30 in Paris
  const fakePool = { query: async () => ({ rows: [{ email: "x@example.test", is_member: true, member_expires_at: end, is_disabled: false }] }) };
  const state = await membershipPageState(fakePool, { user: { id: 1 } }, new Date("2026-12-01T12:00:00Z"));
  assert.equal(state.memExpires, "2027-01-01");
});
