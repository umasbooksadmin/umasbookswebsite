// Second security/privacy review, items 2, 3 and 4 (mail layer):
//  - per-recipient throttling of mail anyone can trigger toward any address;
//  - one-time-link bodies never linger (failed / past their lifetime);
//  - form mail is findable by the submitter's address (subject_email) and erased;
//  - the free-text detail of old audit rows is blanked.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");

const h = adminHarness("outbox_throttle", ["emailOutbox"], { isolated: true });

const mailer = require("../../src/mailer");
const sent = [];
let failSends = false;
mailer.sendMail = async (opts) => {
  if (failSends) throw new Error("smtp down");
  sent.push(opts);
};
const outbox = require("../../src/lib/outbox");
const { purgeExpiredPersonalData } = require("../../src/lib/privacy");

before(() => h.start());
after(() => h.stop());
beforeEach(() => { sent.length = 0; failSends = false; outbox.resetThrottleCounts(); });

const q = (sql, params) => h.q(sql, params);
const addr = () => `thr-${h.uniq()}@example.test`;
const mail = (to, kind = "verification", extra = {}) => ({ to, subject: "S", text: "link https://x/verify/abc", kind, ...extra });
const quiet = async (fn) => { const w = console.warn; console.warn = () => {}; try { return await fn(); } finally { console.warn = w; } };

// ---------- item 2: per-recipient throttle ----------

test("the same address is mailed at most once per kind per 10 minutes", async () => {
  const to = addr();
  const first = await outbox.sendEmail(mail(to), { db: h.pool });
  assert.ok(first.id && first.sent);
  const second = await quiet(() => outbox.sendEmail(mail(to), { db: h.pool }));
  assert.equal(second.throttled, "interval");
  assert.equal(second.id, null);
  assert.equal(sent.length, 1, "only one mail left the building");
  assert.equal((await q("SELECT count(*)::int AS n FROM email_outbox WHERE to_email = $1", [to]))[0].n, 1, "nothing stored for the throttled one");
  assert.equal(outbox.getThrottleCounts()["verification:interval"], 1, "counter kept (no address in it)");
  // Case-insensitive.
  assert.equal((await quiet(() => outbox.sendEmail(mail(to.toUpperCase()), { db: h.pool }))).throttled, "interval");
});

test("the 10-minute window resets", async () => {
  const to = addr();
  await outbox.sendEmail(mail(to), { db: h.pool });
  await q("UPDATE email_outbox SET created_at = now() - interval '11 minutes' WHERE to_email = $1", [to]);
  const again = await outbox.sendEmail(mail(to), { db: h.pool });
  assert.ok(again.id, "allowed again after 10 minutes");
});

test("a different kind to the same address is not blocked by the interval rule, but 5 a day is the ceiling", async () => {
  const to = addr();
  const kinds = ["verification", "password_reset", "signup_attempt", "book_request_confirm", "book_request_list"];
  for (const k of kinds) assert.ok((await outbox.sendEmail(mail(to, k), { db: h.pool })).id, k);
  const sixth = await quiet(() => outbox.sendEmail(mail(to, "verification"), { db: h.pool, throttle: "skipInterval" }));
  assert.equal(sixth.throttled, "daily");
  // 24 hours later it resets.
  await q("UPDATE email_outbox SET created_at = now() - interval '25 hours' WHERE to_email = $1", [to]);
  assert.ok((await outbox.sendEmail(mail(to), { db: h.pool })).id);
});

test("different addresses are independent of each other", async () => {
  for (let i = 0; i < 4; i++) assert.ok((await outbox.sendEmail(mail(addr()), { db: h.pool })).id);
});

test("shop-wide hourly ceiling per kind (limits are configurable)", async () => {
  const limits = { globalPerHour: { book_request_list: 3 } };
  const mine = [];
  for (let i = 0; i < 3; i++) mine.push(await outbox.sendEmail(mail(addr(), "book_request_list"), { db: h.pool, limits }));
  assert.ok(mine.every((r) => r.id));
  const over = await quiet(() => outbox.sendEmail(mail(addr(), "book_request_list"), { db: h.pool, limits }));
  assert.equal(over.throttled, "global");
  // Another kind is unaffected.
  assert.ok((await outbox.sendEmail(mail(addr(), "password_reset"), { db: h.pool, limits })).id);
  // An hour later the ceiling resets.
  await q("UPDATE email_outbox SET created_at = now() - interval '2 hours' WHERE kind = 'book_request_list'");
  assert.ok((await outbox.sendEmail(mail(addr(), "book_request_list"), { db: h.pool, limits })).id);
});

test("order/reservation/other mail is never throttled", async () => {
  const to = addr();
  for (const kind of ["order_confirmation", "reservation_reminder", "book_request_notify", "inactivity_warning", "contact"]) {
    for (let i = 0; i < 7; i++) assert.ok((await outbox.sendEmail(mail(to, kind), { db: h.pool })).id, `${kind} #${i}`);
  }
});

test("resend flows skip the 10-minute rule; admins can bypass entirely", async () => {
  const to = addr();
  await outbox.sendEmail(mail(to), { db: h.pool });
  const resend = await outbox.sendEmail(mail(to), { db: h.pool, throttle: "skipInterval" });
  assert.ok(resend.id, "resend-verification has its own cooldown, so it is not blocked here");
  const admin = await outbox.sendEmail(mail(to), { db: h.pool, throttle: "off" });
  assert.ok(admin.id);
});

test("a throttled concurrent burst for one address stores exactly one mail", async () => {
  const to = addr();
  const results = await quiet(() => Promise.all(Array.from({ length: 8 }, () => outbox.sendEmail(mail(to), { db: h.pool }))));
  assert.equal(results.filter((r) => r.id).length, 1);
});

// ---------- item 3: token bodies ----------

test("a one-time-link mail that FAILS is blanked at once; other kinds keep their text for retries", async () => {
  failSends = true;
  const tokenId = (await outbox.enqueueEmail(h.pool, mail(addr(), "password_reset")));
  const otherId = (await outbox.enqueueEmail(h.pool, mail(addr(), "order_confirmation", { text: "your order" })));
  for (let i = 0; i < outbox.MAX_ATTEMPTS; i++) {
    await q("UPDATE email_outbox SET next_try_at = now() WHERE id = ANY($1)", [[tokenId, otherId]]);
    await outbox.processOutbox(h.pool);
  }
  const [t] = await q("SELECT * FROM email_outbox WHERE id = $1", [tokenId]);
  assert.equal(t.status, "failed");
  assert.equal(t.body_text, "");
  assert.equal(t.body_html, null);
  const [o] = await q("SELECT * FROM email_outbox WHERE id = $1", [otherId]);
  assert.equal(o.status, "failed");
  assert.equal(o.body_text, "your order", "non-token mail keeps its text so an admin can retry");
  // A blanked mail cannot be "retried" into an empty message.
  assert.equal((await outbox.retryNow(h.pool, tokenId)).ok, false);
  assert.equal((await outbox.retryNow(h.pool, otherId)).ok, true);
});

test("a pending reset/confirmation mail past its link lifetime is expired and blanked, never sent", async () => {
  const reset = await outbox.enqueueEmail(h.pool, mail(addr(), "password_reset", { text: "reset https://x/reset/DEADLINK" }));
  const verify = await outbox.enqueueEmail(h.pool, mail(addr(), "verification", { text: "verify https://x/verify/secret" }));
  const fresh = await outbox.enqueueEmail(h.pool, mail(addr(), "password_reset", { text: "fresh https://x/reset/fresh" }));
  await q("UPDATE email_outbox SET created_at = now() - interval '61 minutes', next_try_at = now() WHERE id = $1", [reset]);
  await q("UPDATE email_outbox SET created_at = now() - interval '59 minutes' WHERE id = $1", [verify]); // 24 h link: still alive
  await q("UPDATE email_outbox SET next_try_at = now() WHERE id IN ($1, $2)", [verify, fresh]);
  const r = await outbox.processOutbox(h.pool);
  const byId = Object.fromEntries((await q("SELECT * FROM email_outbox WHERE id = ANY($1)", [[reset, verify, fresh]])).map((x) => [x.id, x]));
  assert.equal(byId[reset].status, "expired");
  assert.equal(byId[reset].body_text, "");
  assert.equal(byId[reset].attempts, 0, "never attempted");
  assert.equal(byId[verify].status, "sent");
  assert.equal(byId[fresh].status, "sent");
  assert.equal(r.sent, 2);
  assert.ok(!sent.some((m) => /DEADLINK/.test(m.text)), "the expired link was never mailed");
  assert.equal((await outbox.retryNow(h.pool, reset)).ok, false, "expired is final");
});

// ---------- item 4: subject_email, audit detail ----------

test("form mail is stored with the submitter's address and erased with it", async () => {
  const person = addr();
  const other = addr();
  const id = await outbox.enqueueEmail(h.pool, { kind: "contact", to: "admin@umasbooks.org", subject: "Website pre-registration", text: "child Ada born 2020-01-01",
    replyTo: { name: "Parent", address: person.toUpperCase() } });
  const otherId = await outbox.enqueueEmail(h.pool, { kind: "contact", to: "admin@umasbooks.org", subject: "Website contact", text: "hello", replyTo: { name: "X", address: other } });
  assert.equal((await q("SELECT subject_email FROM email_outbox WHERE id = $1", [id]))[0].subject_email, person.toLowerCase());
  const listed = await outbox.listOutboxFor(h.pool, person);
  assert.deepEqual(listed.map((m) => [m.id, m.role]), [[id, "sender"]]);
  assert.equal((await outbox.eraseOutboxFor(h.pool, person)).valueOf(), 1);
  const [gone] = await q("SELECT * FROM email_outbox WHERE id = $1", [id]);
  assert.equal(gone.body_text, "");
  assert.equal(gone.subject_email, null);
  assert.ok(gone.purged_at);
  assert.equal((await q("SELECT body_text FROM email_outbox WHERE id = $1", [otherId]))[0].body_text, "hello", "someone else's mail untouched");
});

test("the retention purge blanks audit-log free text after 6 months and deletes the row after 12", async () => {
  const mk = async (months, detail) => (await q(
    "INSERT INTO admin_audit_log (action, detail, at) VALUES ('order.refund', $1, now() - make_interval(months => $2)) RETURNING id", [detail, months]))[0].id;
  const recent = await mk(1, "refund note for Jane Doe");
  const old = await mk(7, "void reason: customer Jane Doe");
  const ancient = await mk(13, "x");
  const counts = await purgeExpiredPersonalData(h.pool);
  assert.ok(counts.auditDetail >= 1);
  const rows = Object.fromEntries((await q("SELECT id, action, detail, at FROM admin_audit_log WHERE id = ANY($1)", [[recent, old, ancient]])).map((r) => [r.id, r]));
  assert.equal(rows[recent].detail, "refund note for Jane Doe");
  assert.equal(rows[old].detail, null, "free text gone");
  assert.equal(rows[old].action, "order.refund", "action, actor and time stay");
  assert.ok(rows[old].at);
  assert.equal(rows[ancient], undefined, "12 months: the whole row goes");
});
