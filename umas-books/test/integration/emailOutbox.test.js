// The email outbox (src/lib/outbox.js) and what is built on it:
//  - a paid order and its confirmation are queued ATOMICALLY (one transaction);
//  - sent at once when Gmail works; kept and retried with backoff when not;
//  - after 8 attempts: failed + ONE throttled admin alert (no personal data);
//  - retention purge of stored bodies; erasure of one person's rows;
//  - the admin pages: outbox list, retry now, mark failed as handled,
//    "Resend confirmation", and the "needs attention" dashboard item;
//  - a failure while building the confirmation never undoes a payment, and the
//    HelloAsso order id is stamped in the same transaction as the paid status.

const { test, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const { adminHarness } = require("../helpers/adminHarness");

const h = adminHarness("email_outbox", ["dashboard", "orders", "emailOutbox"], { isolated: true });

const mailer = require("../../src/mailer");
const sent = [];
let failSends = false;
mailer.sendMail = async (opts) => {
  if (failSends) throw new Error("Invalid login for jane.doe@example.org: 535 password revoked 0612345678");
  sent.push(opts);
};

const outbox = require("../../src/lib/outbox");
const cart = require("../../src/lib/cart");
const errorAlert = require("../../src/lib/errorAlert");
const { RETENTION, purgeExpiredPersonalData, eraseMember } = require("../../src/lib/privacy");

before(() => h.start());
after(() => h.stop());
beforeEach(() => {
  sent.length = 0;
  failSends = false;
  errorAlert.setAlertRetryDelay(0);
});

const q = (sql, params) => h.q(sql, params);
const msg = (over = {}) => ({ to: `buyer-${h.uniq()}@example.test`, subject: "Hello", text: "Body text", kind: "contact", ...over });
const makeDue = (id) => q("UPDATE email_outbox SET next_try_at = now() WHERE id = $1", [id]);
const row = async (id) => (await q("SELECT * FROM email_outbox WHERE id = $1", [id]))[0];

async function insertPendingOrder({ email = `order-${h.uniq()}@example.test`, lang = null } = {}) {
  const [o] = await q(
    `INSERT INTO orders (buyer_name, buyer_email, total_amount, status, checkout_intent_id, lang)
     VALUES ('Outbox Buyer', $1, 5.00, 'pending', $2, $3) RETURNING *`,
    [email, `intent-${h.uniq()}`, lang]
  );
  const [b] = await q("INSERT INTO books (title, authors) VALUES ('Outbox Book', 'A') RETURNING id");
  const [c] = await q(
    "INSERT INTO book_copies (book_id, status, cart_order_id, cart_added_at, price) VALUES ($1, 'in_cart', $2, now(), 5.00) RETURNING id",
    [b.id, o.id]
  );
  await q("INSERT INTO order_items (order_id, book_copy_id, item_title, price) VALUES ($1, $2, 'Outbox Book', 5.00)", [o.id, c.id]);
  return { order: o, copyId: c.id };
}

// ---------- store, send, retry ----------

test("sendEmail stores the message and sends it at once; the row is marked sent", async () => {
  const r = await outbox.sendEmail(msg({ to: "now@example.test" }), { db: h.pool });
  assert.equal(r.sent, true);
  assert.equal(sent.length, 1);
  const x = await row(r.id);
  assert.equal(x.status, "sent");
  assert.ok(x.sent_at);
  assert.equal(x.attempts, 1);
});

test("a failing mailer does not throw: the message waits in the queue with attempt 1 and a 1-minute delay", async () => {
  failSends = true;
  const realError = console.error;
  console.error = () => {};
  let r;
  try { r = await outbox.sendEmail(msg(), { db: h.pool }); } finally { console.error = realError; }
  assert.equal(r.sent, false);
  const x = await row(r.id);
  assert.equal(x.status, "pending");
  assert.equal(x.attempts, 1);
  const waitMin = (new Date(x.next_try_at) - Date.now()) / 60000;
  assert.ok(waitMin > 0.5 && waitMin <= 1.01, `first retry after about 1 minute, got ${waitMin}`);
  assert.doesNotMatch(x.last_error, /jane\.doe@example\.org|0612345678/, "stored error has no personal data");
});

test("backoff is 1, 5, 15, 60, 240 minutes then 240 again, and the 8th failure marks the row failed", async () => {
  failSends = true;
  const realError = console.error;
  console.error = () => {};
  try {
    const id = await outbox.enqueueEmail(h.pool, msg());
    const waits = [];
    for (let attempt = 1; attempt <= outbox.MAX_ATTEMPTS; attempt++) {
      await makeDue(id);
      await outbox.processOutbox(h.pool);
      const x = await row(id);
      assert.equal(x.attempts, attempt);
      if (x.status === "pending") waits.push(Math.round((new Date(x.next_try_at) - Date.now()) / 60000));
    }
    assert.deepEqual(waits, [1, 5, 15, 60, 240, 240, 240]);
    const x = await row(id);
    assert.equal(x.status, "failed");
    assert.ok(x.failed_at);
    // A failed row is never picked up again.
    await makeDue(id);
    await outbox.processOutbox(h.pool);
    assert.equal((await row(id)).attempts, outbox.MAX_ATTEMPTS);
  } finally {
    console.error = realError;
  }
});

test("when Gmail recovers, the worker sends what is due and not yet due mail waits", async () => {
  const due = await outbox.enqueueEmail(h.pool, msg({ to: "due@example.test" }));
  const later = await outbox.enqueueEmail(h.pool, msg({ to: "later@example.test" }));
  await q("UPDATE email_outbox SET next_try_at = now() + interval '1 hour' WHERE id = $1", [later]);
  const r = await outbox.processOutbox(h.pool);
  assert.equal(r.sent >= 1, true);
  assert.equal((await row(due)).status, "sent");
  assert.equal((await row(later)).status, "pending");
  assert.deepEqual(sent.map((m) => m.to).filter((t) => t === "later@example.test"), []);
});

test("the fast path and the worker never both send one row", async () => {
  const id = await outbox.enqueueEmail(h.pool, msg({ to: "once@example.test" }));
  await Promise.all([outbox.deliverNow(h.pool, id), outbox.deliverNow(h.pool, id), outbox.processOutbox(h.pool)]);
  assert.equal(sent.filter((m) => m.to === "once@example.test").length, 1);
});

test("one-time-link mail loses its body as soon as it is sent", async () => {
  const r = await outbox.sendEmail(msg({ kind: "password_reset", text: "https://x.test/reset-password/SECRET" }), { db: h.pool });
  assert.equal(r.sent, true);
  const x = await row(r.id);
  assert.equal(x.body_text, "");
});

// ---------- atomicity with the order ----------

test("a paid order and its confirmation are queued in the same transaction; the confirmation is sent and stamped", async () => {
  const { order } = await insertPendingOrder({ lang: "fr" });
  assert.equal(await cart.markOrderPaid(h.pool, order, { helloassoOrderId: 777001 }), true);
  const [o] = await q("SELECT status, helloasso_order_id, confirmation_sent_at FROM orders WHERE id = $1", [order.id]);
  assert.equal(o.status, "paid");
  assert.equal(o.helloasso_order_id, "777001", "stamped in the same transaction as the paid status");
  assert.ok(o.confirmation_sent_at);
  const rows = await q("SELECT * FROM email_outbox WHERE related_order_id = $1", [order.id]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "order_confirmation");
  assert.equal(rows[0].status, "sent");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, order.buyer_email);
});

test("if the transaction fails after the confirmation was queued, neither the payment nor the confirmation exists", async () => {
  const { order, copyId } = await insertPendingOrder();
  // Fails the LAST statement of markOrderPaid's transaction would be too late to matter;
  // fail the inventory statement and prove nothing (order, outbox row) was kept.
  const failing = {
    query: (sql, ...rest) => h.pool.query(sql, ...rest),
    connect: async () => {
      const client = await h.pool.connect();
      return {
        query: (sql, ...rest) => {
          if (/INSERT INTO email_outbox/.test(String(sql))) return Promise.reject(Object.assign(new Error("injected after queueing"), { injected: true }));
          return client.query(sql, ...rest);
        },
        release: (e) => client.release(e),
        on: (...a) => client.on(...a),
        removeListener: (...a) => client.removeListener(...a),
      };
    },
  };
  // A failure while queueing is contained by the savepoint: the order IS paid, no row, no confirmation.
  const realError = console.error;
  console.error = () => {};
  try { assert.equal(await cart.markOrderPaid(failing, order, { helloassoOrderId: 777002 }), true); } finally { console.error = realError; }
  assert.equal((await q("SELECT COUNT(*)::int AS n FROM email_outbox WHERE related_order_id = $1", [order.id]))[0].n, 0);
  const [o] = await q("SELECT status, helloasso_order_id, confirmation_sent_at FROM orders WHERE id = $1", [order.id]);
  assert.equal(o.status, "paid", "a confirmation problem never undoes a payment");
  assert.equal(o.helloasso_order_id, "777002", "and the HelloAsso id is still stamped");
  assert.equal(o.confirmation_sent_at, null);
  assert.equal((await q("SELECT status FROM book_copies WHERE id = $1", [copyId]))[0].status, "sold");
});

test("if the commit itself fails, the order is still pending and no confirmation was queued or sent", async () => {
  const { order, copyId } = await insertPendingOrder();
  const failingCommit = {
    query: (sql, ...rest) => h.pool.query(sql, ...rest),
    connect: async () => {
      const client = await h.pool.connect();
      return {
        // The COMMIT never reaches the database: the transaction is rolled back instead.
        query: (sql, ...rest) => (String(sql) === "COMMIT" ? client.query("ROLLBACK").then(() => Promise.reject(new Error("commit failed"))) : client.query(sql, ...rest)),
        release: (e) => client.release(e),
        on: (...a) => client.on(...a),
        removeListener: (...a) => client.removeListener(...a),
      };
    },
  };
  sent.length = 0;
  await assert.rejects(cart.markOrderPaid(failingCommit, order, { helloassoOrderId: 1 }), /commit failed/);
  assert.equal((await q("SELECT status FROM orders WHERE id = $1", [order.id]))[0].status, "pending");
  assert.equal((await q("SELECT status FROM book_copies WHERE id = $1", [copyId]))[0].status, "in_cart");
  assert.equal((await q("SELECT COUNT(*)::int AS n FROM email_outbox WHERE related_order_id = $1", [order.id]))[0].n, 0, "the confirmation is queued in the SAME transaction");
  assert.equal(sent.length, 0);
});

test("a rolled-back transaction leaves no outbox row (enqueue works inside the caller's transaction)", async () => {
  const { withTransaction } = require("../../src/db");
  const to = `rolledback-${h.uniq()}@example.test`;
  await assert.rejects(withTransaction(h.pool, async (client) => {
    await outbox.enqueueEmail(client, msg({ to }));
    throw new Error("boom");
  }), /boom/);
  assert.equal((await q("SELECT COUNT(*)::int AS n FROM email_outbox WHERE to_email = $1", [to]))[0].n, 0);
});

test("with Gmail down at payment time the order is paid and its confirmation waits in the queue, then is sent and stamped by the worker", async () => {
  const { order } = await insertPendingOrder();
  failSends = true;
  const realError = console.error;
  console.error = () => {};
  try { await cart.markOrderPaid(h.pool, order); } finally { console.error = realError; }
  let [o] = await q("SELECT status, confirmation_sent_at FROM orders WHERE id = $1", [order.id]);
  assert.equal(o.status, "paid");
  assert.equal(o.confirmation_sent_at, null);
  const [mail] = await q("SELECT id, status FROM email_outbox WHERE related_order_id = $1", [order.id]);
  assert.equal(mail.status, "pending");

  failSends = false;
  await makeDue(mail.id);
  await outbox.processOutbox(h.pool);
  [o] = await q("SELECT confirmation_sent_at FROM orders WHERE id = $1", [order.id]);
  assert.ok(o.confirmation_sent_at, "stamped when the worker finally sent it");
});

// ---------- throttled alert ----------

test("when mail gives up, ONE alert per hour: kinds, counts, last error without personal data", async () => {
  await q("UPDATE email_outbox SET status = 'handled', alerted_at = NULL WHERE status IN ('failed', 'pending')");
  const ids = [];
  for (const kind of ["order_confirmation", "order_confirmation", "verification"]) ids.push(await outbox.enqueueEmail(h.pool, msg({ kind })));
  failSends = true;
  const realError = console.error;
  console.error = () => {};
  try {
    for (let i = 0; i < outbox.MAX_ATTEMPTS; i++) {
      await q("UPDATE email_outbox SET next_try_at = now() WHERE id = ANY($1::bigint[]) AND status = 'pending'", [ids]);
      await outbox.processOutbox(h.pool);
    }
  } finally { console.error = realError; }
  assert.deepEqual((await q("SELECT DISTINCT status FROM email_outbox WHERE id = ANY($1::bigint[])", [ids])).map((r) => r.status), ["failed"]);

  const alerts = sent.filter((m) => /could not be sent/.test(m.subject));
  failSends = false;
  // Mail was failing while the alert was tried too: both tries failed and the claim was handed back.
  assert.equal(alerts.length, 0);
  assert.ok((await q("SELECT COUNT(*)::int AS n FROM email_outbox WHERE status = 'failed' AND alerted_at IS NULL"))[0].n >= 3);

  assert.equal(await outbox.alertFailedEmails(h.pool), true);
  const alert = sent.find((m) => /could not be sent/.test(m.subject));
  assert.match(alert.subject, /3 emails could not be sent/);
  assert.match(alert.text, /order_confirmation: 2/);
  assert.match(alert.text, /verification: 1/);
  assert.match(alert.text, /Last error: .*Invalid login/);
  assert.doesNotMatch(alert.text, /jane\.doe@example\.org|0612345678/, "the last error is scrubbed");

  // More failures within the hour: no second alert.
  const more = await outbox.enqueueEmail(h.pool, msg({ kind: "contact" }));
  await q("UPDATE email_outbox SET status = 'failed', failed_at = now(), last_error = 'x' WHERE id = $1", [more]);
  sent.length = 0;
  assert.equal(await outbox.alertFailedEmails(h.pool), false);
  assert.equal(sent.length, 0);
  // An hour later it goes out, covering only the new row.
  await q("UPDATE email_outbox SET alerted_at = alerted_at - interval '61 minutes' WHERE alerted_at IS NOT NULL");
  assert.equal(await outbox.alertFailedEmails(h.pool), true);
  assert.match(sent[0].subject, /1 email could not be sent/);
});

test("the failure alert is handed back (and retried next minute) when the alert mail itself fails", async () => {
  await q("UPDATE email_outbox SET status = 'handled' WHERE status = 'failed'");
  const id = await outbox.enqueueEmail(h.pool, msg());
  await q("UPDATE email_outbox SET status = 'failed', failed_at = now(), last_error = 'x' WHERE id = $1", [id]);
  await q("UPDATE email_outbox SET alerted_at = NULL");
  failSends = true;
  const realError = console.error;
  console.error = () => {};
  try { assert.equal(await outbox.alertFailedEmails(h.pool), false); } finally { console.error = realError; }
  assert.equal((await row(id)).alerted_at, null);
  failSends = false;
  assert.equal(await outbox.alertFailedEmails(h.pool), true);
});

// ---------- retention and erasure ----------

test("retention: sent bodies are purged after 30 days, failed after 90, younger rows are untouched", async () => {
  assert.equal(RETENTION.outboxSentDays, 30);
  assert.equal(RETENTION.outboxFailedDays, 90);
  const mk = async (status, ageDays) => {
    const id = await outbox.enqueueEmail(h.pool, msg({ to: `ret-${status}-${ageDays}@example.test`, text: "secret body" }));
    await q(
      `UPDATE email_outbox SET status = $2, sent_at = CASE WHEN $2 = 'sent' THEN now() - ($3 * interval '1 day') END,
         failed_at = CASE WHEN $2 = 'failed' THEN now() - ($3 * interval '1 day') END WHERE id = $1`,
      [id, status, ageDays]
    );
    return id;
  };
  const sentOld = await mk("sent", 31);
  const sentNew = await mk("sent", 29);
  const failedMid = await mk("failed", 60);
  const failedOld = await mk("failed", 91);

  const counts = await purgeExpiredPersonalData(h.pool);
  assert.ok(counts.emailOutbox >= 2);
  for (const id of [sentOld, failedOld]) {
    const x = await row(id);
    assert.equal(x.body_text, "");
    assert.equal(x.subject, "");
    assert.equal(x.to_email, "erased@erased.invalid");
    assert.ok(x.purged_at);
  }
  for (const id of [sentNew, failedMid]) assert.equal((await row(id)).body_text, "secret body");
});

test("erasing an account erases its queued mail and cancels the pending ones", async () => {
  const email = `erase-${h.uniq()}@example.test`;
  const [u] = await q("INSERT INTO users (email, password_hash, display_name, email_verified_at) VALUES ($1, 'x', 'Erase Me', now()) RETURNING id", [email]);
  const pending = await outbox.enqueueEmail(h.pool, msg({ to: email }));
  const done = await outbox.enqueueEmail(h.pool, msg({ to: email.toUpperCase() }));
  await q("UPDATE email_outbox SET status = 'sent', sent_at = now() WHERE id = $1", [done]);
  await eraseMember(h.pool, u.id);
  for (const id of [pending, done]) {
    const x = await row(id);
    assert.equal(x.to_email, "erased@erased.invalid");
    assert.equal(x.body_text, "");
  }
  assert.equal((await row(pending)).status, "handled", "nothing is sent to an erased address");
});

// ---------- admin ----------

test("admin outbox page lists the last rows with status and error, and is admin-only", async () => {
  const id = await outbox.enqueueEmail(h.pool, msg({ to: "listed@example.test", subject: "Listed subject" }));
  await q("UPDATE email_outbox SET status = 'failed', failed_at = now(), last_error = 'smtp refused' WHERE id = $1", [id]);
  const { res, text } = await h.get("/admin/email-outbox");
  assert.equal(res.status, 200);
  assert.match(text, /listed@example\.test/);
  assert.match(text, /Listed subject/);
  assert.match(text, /smtp refused/);
  assert.match(text, /Retry now/);
  assert.match(text, /Mark failed as handled/);
  const anon = await h.get("/admin/email-outbox", null);
  assert.equal(anon.res.status, 302);
  const member = await h.get("/admin/email-outbox", h.member);
  assert.equal(member.res.status, 403);
  assert.equal((await h.post("/admin/email-outbox/handled", {}, { user: h.member })).res.status, 403);
});

test("admin 'retry now' sends a failed row; 'mark failed as handled' clears the failed ones", async () => {
  const a = await outbox.enqueueEmail(h.pool, msg({ to: "retry-me@example.test" }));
  await q("UPDATE email_outbox SET status = 'failed', failed_at = now(), attempts = 8, last_error = 'x' WHERE id = $1", [a]);
  const { res } = await h.post(`/admin/email-outbox/${a}/retry`);
  assert.equal(res.status, 302);
  assert.match(res.headers.get("location"), /notice=retry-sent/);
  assert.equal((await row(a)).status, "sent");
  assert.equal(sent.filter((m) => m.to === "retry-me@example.test").length, 1);
  // A sent row cannot be retried again.
  const again = await h.post(`/admin/email-outbox/${a}/retry`);
  assert.match(again.res.headers.get("location"), /retry-refused/);

  const b = await outbox.enqueueEmail(h.pool, msg());
  await q("UPDATE email_outbox SET status = 'failed', failed_at = now() WHERE id = $1", [b]);
  const handled = await h.post("/admin/email-outbox/handled");
  assert.match(handled.res.headers.get("location"), /notice=handled/);
  assert.equal((await row(b)).status, "handled");
  assert.equal((await q("SELECT COUNT(*)::int AS n FROM email_outbox WHERE status = 'failed'"))[0].n, 0);
});

test("resend confirmation: queues and sends a fresh copy for a paid order, refuses unpaid ones, is admin-only", async () => {
  const { order } = await insertPendingOrder();
  const unpaid = await h.post(`/admin/orders/${order.id}/resend-confirmation`);
  assert.match(unpaid.res.headers.get("location"), /resend-not_paid/);
  assert.equal(sent.length, 0);

  await cart.markOrderPaid(h.pool, order);
  sent.length = 0;
  const forbidden = await h.post(`/admin/orders/${order.id}/resend-confirmation`, {}, { user: h.member });
  assert.equal(forbidden.res.status, 403);
  assert.equal(sent.length, 0);

  const { res } = await h.post(`/admin/orders/${order.id}/resend-confirmation`);
  assert.match(res.headers.get("location"), /notice=resent/);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, order.buyer_email);
  assert.equal((await q("SELECT COUNT(*)::int AS n FROM email_outbox WHERE related_order_id = $1", [order.id]))[0].n, 2);
  const audit = await q("SELECT detail FROM admin_audit_log WHERE action = 'order.resend_confirmation' AND target_id = $1 ORDER BY id", [order.id]);
  assert.deepEqual(audit.map((a) => a.detail), ["not_paid", "sent"], "refused and successful attempts are both recorded");
});

test("the orders list offers 'Resend confirmation' for paid orders, with a NOT SENT marker when the mail never went", async () => {
  const { order } = await insertPendingOrder();
  failSends = true;
  const realError = console.error;
  console.error = () => {};
  try { await cart.markOrderPaid(h.pool, order); } finally { console.error = realError; }
  failSends = false;
  const { text } = await h.get("/admin/orders");
  assert.match(text, new RegExp(`/admin/orders/${order.id}/resend-confirmation`));
  assert.match(text, /Resend confirmation/);
  assert.match(text, /NOT SENT/);
});

test("dashboard 'needs attention': a paid order with no confirmation after 30 minutes, and failed mail", async () => {
  const { order } = await insertPendingOrder();
  failSends = true;
  const realError = console.error;
  console.error = () => {};
  try { await cart.markOrderPaid(h.pool, order); } finally { console.error = realError; }
  failSends = false;
  let { text } = await h.get("/admin");
  assert.doesNotMatch(text, /have no confirmation email/, "not yet: it is recent");
  await q("UPDATE orders SET paid_at = now() - interval '31 minutes' WHERE id = $1", [order.id]);
  ({ text } = await h.get("/admin"));
  assert.match(text, /id="needs-attention"/);
  assert.match(text, /paid order\(s\) have no confirmation email sent after 30 minutes/);

  await q("UPDATE orders SET confirmation_sent_at = now() WHERE id = $1", [order.id]);
  await q("UPDATE email_outbox SET status = 'handled' WHERE status IN ('pending', 'failed')");
  ({ text } = await h.get("/admin"));
  assert.doesNotMatch(text, /id="needs-attention"/, "nothing to flag, nothing shown");
  const id = await outbox.enqueueEmail(h.pool, msg());
  await q("UPDATE email_outbox SET status = 'failed', failed_at = now() WHERE id = $1", [id]);
  ({ text } = await h.get("/admin"));
  assert.match(text, /could not be sent after 8 attempts/);
});

test("a failure loading the order lines after commit does not skip stamping the HelloAsso order id ", async () => {
  const { order } = await insertPendingOrder();
  // Drive markOrderPaid with a pool whose order-lines query throws: the failure
  // that used to skip the stamp.
  const failingPool = {
    query: (sql, ...rest) => h.pool.query(sql, ...rest),
    connect: async () => {
      const client = await h.pool.connect();
      return {
        query: (sql, ...rest) => (/FROM order_items i/.test(String(sql)) ? Promise.reject(new Error("order lines unavailable")) : client.query(sql, ...rest)),
        release: (e) => client.release(e),
        on: (...a) => client.on(...a),
        removeListener: (...a) => client.removeListener(...a),
      };
    },
  };
  const realError = console.error;
  console.error = () => {};
  try { assert.equal(await cart.markOrderPaid(failingPool, order, { helloassoOrderId: "HA-55" }), true); } finally { console.error = realError; }
  const [o] = await q("SELECT status, helloasso_order_id, confirmation_sent_at FROM orders WHERE id = $1", [order.id]);
  assert.equal(o.status, "paid");
  assert.equal(o.helloasso_order_id, "HA-55");
  assert.equal(o.confirmation_sent_at, null, "flagged for the admin instead");
});

test("'Send a test email' goes through the outbox and shows 'sent', or the exact SMTP error", async () => {
  const ok = await h.post("/admin/email-outbox/test-email");
  assert.equal(ok.res.status, 302);
  const loc = ok.res.headers.get("location");
  assert.match(loc, /\/admin\/email-outbox\?test=\d+/);
  assert.equal(sent.filter((m) => m.subject === "Uma's Books: test email" && m.to === h.admin.email).length, 1);
  let page = await h.get(loc);
  assert.match(page.text, /id="test-result"[^>]*>Sent to/);

  failSends = true;
  const realError = console.error;
  console.error = () => {};
  let bad;
  try { bad = await h.post("/admin/email-outbox/test-email"); } finally { console.error = realError; }
  page = await h.get(bad.res.headers.get("location"));
  assert.match(page.text, /NOT sent/);
  assert.match(page.text, /Invalid login for \[email\]: 535 password revoked/, "the real error, with personal data scrubbed");
  assert.doesNotMatch(page.text, /jane\.doe@example\.org/);
  assert.equal((await h.post("/admin/email-outbox/test-email", {}, { user: h.member })).res.status, 403);
});

test("the order detail page offers Resend confirmation for a paid order", async () => {
  const { order } = await insertPendingOrder();
  await cart.markOrderPaid(h.pool, order);
  const { res, text } = await h.get(`/admin/orders/${order.id}`);
  assert.equal(res.status, 200);
  assert.match(text, new RegExp(`/admin/orders/${order.id}/resend-confirmation`));
});
