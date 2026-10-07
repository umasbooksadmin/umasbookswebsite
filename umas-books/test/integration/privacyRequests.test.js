// Admin "Privacy requests" (/admin/privacy): everything held under an EMAIL
// ADDRESS, including people with no account: look up, download as JSON, erase
// (typed confirmation, one transaction, anonymised accounting rows, audit with
// a hash instead of the address). Also the audit entry for viewing the Accounts
// report page (item 10 of the second review).

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");

const h = adminHarness("privacy_requests", ["privacyRequests", "reports"], { isolated: true });
const outbox = require("../../src/lib/outbox");
const pr = require("../../src/lib/privacyRequests");

before(() => h.start());
after(() => h.stop());
const q = (sql, params) => h.q(sql, params);
const audits = (action) => q("SELECT * FROM admin_audit_log WHERE action = $1 ORDER BY id", [action]);

async function seed(email, { account = false } = {}) {
  const s = { email };
  if (account) s.user = (await q("INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, 'x', 'Held Person', now()) RETURNING id", [email]))[0];
  const [ev] = await q("INSERT INTO events (title, starts_at) VALUES ('Ev', now() + interval '1 day') RETURNING id");
  await q("INSERT INTO event_signups (event_id, name, email) VALUES ($1, 'Held Person', $2)", [ev.id, email]);
  const [cl] = await q("INSERT INTO classes (title, starts_at, capacity) VALUES ('Cl', now() + interval '1 day', 5) RETURNING id");
  await q("INSERT INTO class_signups (class_id, name, email) VALUES ($1, 'Held Person', $2)", [cl.id, email]);
  const [paid] = await q("INSERT INTO orders (buyer_name, buyer_email, buyer_phone, total_amount, status, checkout_intent_id, paid_at) VALUES ('Held Person', $1, '0600000000', 7, 'paid', $2, now()) RETURNING id, access_token", [email, `i-${h.uniq()}`]);
  s.paid = paid;
  const [book] = await q("INSERT INTO books (title, authors) VALUES ('Held Book', 'A') RETURNING id");
  await q("INSERT INTO book_copies (book_id, status, reserved_by_name, reserved_by_email, reserved_at) VALUES ($1, 'reserved', 'Held Person', $2, now())", [book.id, email]);
  await q("INSERT INTO membership_payments (helloasso_order_id, payer_email, amount_cents, paid_at, unmatched_at) VALUES ($1, $2, 1500, now(), now())", [Math.floor(Math.random() * 1e12), email]);
  await q("INSERT INTO book_requests (title, email, name, status) VALUES ('Wanted', $1, 'Held Person', 'open')", [email]);
  await outbox.enqueueEmail(h.pool, { kind: "order_confirmation", to: email, subject: "Your order", text: "SECRET BODY TEXT" });
  await outbox.enqueueEmail(h.pool, { kind: "contact", to: "admin@umasbooks.org", subject: "Website pre-registration: Ada", text: "child details", replyTo: { name: "P", address: email } });
  return s;
}

test("only an admin can reach the page", async () => {
  for (const [path, method] of [["/admin/privacy", "get"]]) {
    assert.notEqual((await h[method](path, null)).res.status, 200, "anonymous");
    assert.notEqual((await h[method](path, h.member)).res.status, 200, "member");
  }
  for (const path of ["search", "export", "erase-confirm", "erase"]) {
    const r = await h.post(`/admin/privacy/${path}`, { email: "a@example.test" }, { user: h.member });
    assert.notEqual(r.res.status, 200, `member POST ${path}`);
    const anon = await h.post(`/admin/privacy/${path}`, { email: "a@example.test" }, { user: null });
    assert.notEqual(anon.res.status, 200, `anonymous POST ${path}`);
  }
  assert.equal((await h.get("/admin/privacy")).res.status, 200);
});

test("lookup lists every record with counts, never message bodies, and audits with a hash only", async () => {
  const email = `held-${h.uniq()}@example.test`;
  await seed(email, { account: true });
  const { res, text } = await h.post("/admin/privacy/search", { email: email.toUpperCase() });
  assert.equal(res.status, 200);
  assert.doesNotMatch(text, /SECRET BODY TEXT/);
  const records = await pr.findRecords(h.pool, email);
  assert.deepEqual(records.counts, {
    accounts: 1, orders: 1, reservations: 1, eventSignups: 1, classSignups: 1, bookRequests: 1,
    membershipPayments: 1, unmatchedPayments: 1, emails: 2, contactForms: 1, bookRequestLinks: 0,
  });
  for (const label of ["Accounts", "Event sign-ups", "Book reservations", "Book requests", "Membership payments", "form mail"]) assert.match(text, new RegExp(label));
  const [a] = await audits("privacy.lookup");
  assert.ok(a, "audited");
  assert.doesNotMatch(JSON.stringify(a), new RegExp(email.split("@")[0]), "the address is not in the audit entry");
  assert.match(a.detail, /^hmac:[0-9a-f]{16} /);
  assert.equal(a.actor_user_id, h.admin.id);
  assert.equal((await h.post("/admin/privacy/search", { email: "not an address" })).text.includes("Enter one valid email address."), true);
});

test("download everything (JSON): accounts, address-keyed rows and form mail, no message bodies or secrets", async () => {
  const email = `export-${h.uniq()}@example.test`;
  await seed(email, { account: true });
  const { res, text } = await h.post("/admin/privacy/export", { email });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-disposition"), /attachment/);
  assert.equal(res.headers.get("cache-control"), "no-store");
  const data = JSON.parse(text);
  assert.equal(data.accounts.length, 1);
  assert.equal(data.accounts[0].user.email, email);
  assert.equal(data.accounts[0].user.password_hash, undefined);
  const held = data.held_under_address;
  assert.equal(held.event_signups.length, 1);
  assert.equal(held.orders.length, 1);
  assert.equal(held.book_requests.length, 1);
  assert.equal(held.emails_sent.length, 2);
  assert.doesNotMatch(text, /SECRET BODY TEXT|child details/);
  assert.equal((await audits("privacy.export")).length >= 1, true);
});

test("an address with NO account is answered too", async () => {
  const email = `guest-${h.uniq()}@example.test`;
  await seed(email);
  const r = await pr.findRecords(h.pool, email);
  assert.equal(r.counts.accounts, 0);
  assert.equal(r.counts.orders, 1);
  const data = await pr.buildAddressExport(h.pool, email);
  assert.equal(data.accounts.length, 0);
  assert.equal(data.held_under_address.class_signups.length, 1);
});

test("erase needs the typed address; a wrong one erases nothing", async () => {
  const email = `typo-${h.uniq()}@example.test`;
  await seed(email, { account: true });
  const confirm = await h.post("/admin/privacy/erase-confirm", { email });
  assert.match(confirm.text, /Type the address again/);
  const wrong = await h.post("/admin/privacy/erase", { email, confirmEmail: "someone-else@example.test" });
  assert.match(wrong.text, /does not match\. Nothing was erased/);
  assert.equal((await pr.findRecords(h.pool, email)).counts.accounts, 1);
  assert.equal((await audits("privacy.erase")).length, 0);
});

test("erase everything: deletes the rest, anonymises the paid order and payment, rotates the link, audits a hash", async () => {
  const email = `erase-${h.uniq()}@example.test`;
  const bystander = `bystander-${h.uniq()}@example.test`;
  const s = await seed(email, { account: true });
  await seed(bystander);
  const { res, text } = await h.post("/admin/privacy/erase", { email, confirmEmail: email.toUpperCase() });
  assert.equal(res.status, 200);
  assert.match(text, /erased or anonymised/);

  assert.equal((await q("SELECT 1 FROM users WHERE lower(email) = $1", [email])).length, 0);
  for (const t of ["event_signups", "class_signups"]) assert.equal((await q(`SELECT 1 FROM ${t} WHERE lower(email) = $1`, [email])).length, 0, t);
  assert.equal((await q("SELECT 1 FROM book_requests WHERE lower(email) = $1", [email])).length, 0);
  const [order] = await q("SELECT * FROM orders WHERE id = $1", [s.paid.id]);
  assert.equal(order.status, "paid");
  assert.equal(Number(order.total_amount), 7);
  assert.equal(order.buyer_name, "Erased");
  assert.equal(order.buyer_phone, null);
  assert.match(order.buyer_email, /@erased\.invalid$/);
  assert.notEqual(order.access_token, s.paid.access_token);
  const pays = await q("SELECT payer_email, amount_cents FROM membership_payments WHERE amount_cents = 1500 AND payer_email LIKE '%@erased.invalid'");
  assert.ok(pays.length >= 1);
  assert.equal((await q("SELECT 1 FROM book_copies WHERE lower(reserved_by_email) = $1", [email])).length, 0);
  // Outbox: the confirmation and the form mail (found through subject_email) are blanked.
  const gone = await q("SELECT body_text FROM email_outbox WHERE lower(to_email) = $1 OR lower(subject_email) = $1", [email]);
  assert.deepEqual(gone, [], "no row is findable by the address any more");
  assert.equal((await q("SELECT 1 FROM email_outbox WHERE purged_at IS NOT NULL AND body_text = '' AND kind = 'contact'")).length >= 1, true);
  assert.equal((await pr.findRecords(h.pool, email)).total, 0);
  // Someone else is untouched.
  assert.equal((await pr.findRecords(h.pool, bystander)).counts.orders, 1);
  assert.equal((await pr.findRecords(h.pool, bystander)).counts.contactForms, 1);

  const [a] = await audits("privacy.erase");
  assert.ok(a);
  assert.doesNotMatch(JSON.stringify(a), new RegExp(email.split("@")[0]));
  assert.match(a.detail, /^hmac:[0-9a-f]{16} accounts=1/);
});

test("erase works for an address with no account at all", async () => {
  const email = `noacct-${h.uniq()}@example.test`;
  const s = await seed(email);
  const r = await pr.eraseEverythingFor(h.pool, email);
  assert.equal(r.ok, true);
  assert.equal(r.accounts, 0);
  assert.equal((await q("SELECT buyer_name FROM orders WHERE id = $1", [s.paid.id]))[0].buyer_name, "Erased");
  assert.equal((await pr.findRecords(h.pool, email)).total, 0);
});

test("an administrator's address is refused (demote first)", async () => {
  const r = await pr.eraseEverythingFor(h.pool, h.admin.email);
  assert.deepEqual(r, { ok: false, reason: "admin" });
  assert.equal((await q("SELECT 1 FROM users WHERE id = $1", [h.admin.id])).length, 1);
});

test("the audit hash is stable and keyed", () => {
  assert.equal(pr.auditToken("A@x.org"), pr.auditToken("a@x.org"));
  assert.notEqual(pr.auditToken("a@x.org"), pr.auditToken("b@x.org"));
  assert.equal(pr.normaliseAddress(" A@X.org "), "a@x.org");
  assert.equal(pr.normaliseAddress("a@x.org, b@y.org"), null);
});

// ---------- item 10: the Accounts report page view is audited once an hour per admin ----------

test("viewing the Accounts report page is audited once per hour per admin; other reports are not", async () => {
  const before = (await audits("reports.accounts.view")).length;
  assert.equal((await h.get("/admin/reports/accounts")).res.status, 200);
  assert.equal((await h.get("/admin/reports/accounts?q=foo")).res.status, 200);
  const after = await audits("reports.accounts.view");
  assert.equal(after.length, before + 1, "a refresh or filter change is not a new entry");
  assert.equal(after[after.length - 1].actor_user_id, h.admin.id);
  // After an hour it is logged again, and a different admin has their own entry.
  await q("UPDATE admin_audit_log SET at = now() - interval '2 hours' WHERE action = 'reports.accounts.view'");
  await h.get("/admin/reports/accounts");
  assert.equal((await audits("reports.accounts.view")).length, before + 2);
  const admin2 = await h.makeUser({ admin: true });
  await h.get("/admin/reports/accounts", admin2);
  assert.equal((await audits("reports.accounts.view")).length, before + 3);
  const n = (await audits("reports.accounts.view")).length;
  await h.get("/admin/reports/inventory");
  assert.equal((await audits("reports.accounts.view")).length, n);
});
