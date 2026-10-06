// Email outbox: every customer email is STORED first, then sent.
//
// Why: mail goes through one Gmail mailbox. When Gmail is down, rate-limited
// (about 2000 messages a day) or the app password is revoked, a send used to
// fail with only a console.error: a buyer paid and never got a confirmation,
// a signup never got its link, and nobody knew. Now:
//
//   enqueueEmail(db, msg)   inserts the row. `db` may be a transaction
//                           client, so a paid order and its confirmation are
//                           queued atomically (lib/cart.js markOrderPaid).
//   sendEmail(msg)          enqueue + immediate best-effort send, so people
//                           still get instant mail. Never throws on a send
//                           failure (the worker retries); throws only when
//                           the row cannot be stored (database down).
//   deliverNow(pool, id)    the immediate send for a row stored in a
//                           transaction, called after it committed.
//   processOutbox(pool)     the 60-second worker: retries due rows with
//                           backoff 1, 5, 15, 60, 240 min (then every 240 min)
//                           up to 8 attempts, then marks the row 'failed' and
//                           sends ONE admin alert per hour.
//   purgeOutbox(pool)       retention: bodies are personal data (see privacy.js).
//
// A row is "claimed" by pushing next_try_at five minutes ahead in a single
// UPDATE, so the fast path and the worker (or two app instances) can never
// both send the same row.
const mailer = require("../mailer");
const { scrubPersonalData } = require("./scrub");
const { sendAdminAlert } = require("./errorAlert");

const MAX_ATTEMPTS = 8;
// Minutes to wait after the Nth failed attempt (1-based); the last value repeats.
const BACKOFF_MINUTES = [1, 5, 15, 60, 240];
const LEASE_MINUTES = 5;
const BATCH_SIZE = 20;
const ALERT_EVERY_MINUTES = 60;
const FAST_PATH_WAIT_MS = 5000;
const ADVISORY_KEY = 7243902;

// Kinds whose body is a live login/confirmation link. The link is single-use
// and short-lived, so the body is blanked as soon as the mail is sent.
const TOKEN_KINDS = new Set(["verification", "password_reset", "book_request_confirm", "book_request_list", "signup_attempt"]);

const backoffMinutes = (attempts) => BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1];

async function enqueueEmail(db, msg) {
  if (!msg || !msg.to || !msg.subject || msg.text == null || !msg.kind) {
    throw new Error("enqueueEmail: to, subject, text and kind are required");
  }
  const headers = {};
  if (msg.replyTo) headers.replyTo = msg.replyTo;
  if (msg.headers && Object.keys(msg.headers).length) headers.extra = msg.headers;
  const { rows } = await db.query(
    `INSERT INTO email_outbox (to_email, subject, body_text, body_html, headers, lang, kind, related_order_id)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8) RETURNING id`,
    [msg.to, msg.subject, msg.text, msg.html || null, JSON.stringify(headers), msg.lang || null, msg.kind, msg.relatedOrderId || null]
  );
  return rows[0].id;
}

function errorText(err) {
  return scrubPersonalData((err && err.message) || String(err)).slice(0, 1000);
}

// One claimed row: send it and record the outcome. Resolves true when sent.
async function sendClaimed(pool, row) {
  const h = row.headers || {};
  try {
    await mailer.sendMail({
      to: row.to_email,
      subject: row.subject,
      text: row.body_text,
      ...(row.body_html ? { html: row.body_html } : {}),
      ...(h.replyTo ? { replyTo: h.replyTo } : {}),
      ...(h.extra ? { headers: h.extra } : {}),
    });
  } catch (err) {
    await recordFailure(pool, row, err);
    return false;
  }
  try {
    await pool.query(
      `UPDATE email_outbox
       SET status = 'sent', sent_at = now(), attempts = attempts + 1, last_error = NULL,
           body_text = CASE WHEN $2 THEN '' ELSE body_text END,
           body_html = CASE WHEN $2 THEN NULL ELSE body_html END
       WHERE id = $1`,
      [row.id, TOKEN_KINDS.has(row.kind)]
    );
    if (row.kind === "order_confirmation" && row.related_order_id) {
      await pool.query("UPDATE orders SET confirmation_sent_at = now() WHERE id = $1 AND confirmation_sent_at IS NULL", [row.related_order_id]);
    }
  } catch (err) {
    // The mail went out; only the bookkeeping failed. The lease expires and the
    // worker would send it once more, which is the lesser evil.
    console.error(`Outbox: mail ${row.id} was sent but could not be marked sent:`, err.message);
  }
  return true;
}

async function recordFailure(pool, row, err) {
  const attempts = row.attempts + 1;
  const text = errorText(err);
  console.error(`Outbox: sending mail ${row.id} (${row.kind}) failed, attempt ${attempts}/${MAX_ATTEMPTS}:`, text);
  try {
    if (attempts >= MAX_ATTEMPTS) {
      await pool.query(
        "UPDATE email_outbox SET status = 'failed', failed_at = now(), attempts = $2, last_error = $3 WHERE id = $1",
        [row.id, attempts, text]
      );
    } else {
      await pool.query(
        `UPDATE email_outbox SET attempts = $2, last_error = $3, next_try_at = now() + ($4 * interval '1 minute') WHERE id = $1`,
        [row.id, attempts, text, backoffMinutes(attempts)]
      );
    }
  } catch (dbErr) {
    console.error(`Outbox: could not record the failure of mail ${row.id}:`, dbErr.message);
  }
}

const CLAIM_ONE_SQL = `UPDATE email_outbox SET next_try_at = now() + ($2 * interval '1 minute')
  WHERE id = $1 AND status = 'pending' AND next_try_at <= now() RETURNING *`;

// Immediate best-effort send of one stored row. Waits at most waitMs for the
// SMTP exchange (the send itself carries on in the background and still
// records its outcome). Never throws.
async function deliverNow(pool, id, { waitMs = FAST_PATH_WAIT_MS } = {}) {
  try {
    const { rows } = await pool.query(CLAIM_ONE_SQL, [id, LEASE_MINUTES]);
    if (!rows.length) return { sent: false, queued: true };
    const work = sendClaimed(pool, rows[0]).then((sent) => ({ sent, queued: !sent }));
    let timer;
    const limit = new Promise((resolve) => { timer = setTimeout(() => resolve({ sent: false, queued: true }), waitMs); });
    try {
      return await Promise.race([work, limit]);
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    console.error(`Outbox: immediate send of mail ${id} failed (the worker will retry):`, err.message);
    return { sent: false, queued: true };
  }
}

// Store + send now. The caller never needs to handle a mail failure: the
// message is safely queued once this resolves.
async function sendEmail(msg, { db = require("../db").pool, waitMs } = {}) { // db is loaded lazily: unit tests load this file without a database
  const id = await enqueueEmail(db, msg);
  const result = await deliverNow(db, id, { waitMs });
  return { id, ...result };
}

async function claimDue(client, limit) {
  const { rows } = await client.query(
    `UPDATE email_outbox SET next_try_at = now() + ($2 * interval '1 minute')
     WHERE id IN (
       SELECT id FROM email_outbox WHERE status = 'pending' AND next_try_at <= now()
       ORDER BY next_try_at, id LIMIT $1 FOR UPDATE SKIP LOCKED
     ) RETURNING *`,
    [limit, LEASE_MINUTES]
  );
  return rows.sort((a, b) => a.id - b.id);
}

// ONE alert per hour, however many rows failed, covering every failed row not
// yet alerted. The claim (alerted_at) is one UPDATE, so two instances cannot
// both alert; it is handed back if the alert mail itself cannot be sent.
async function alertFailedEmails(pool) {
  const { rows: recent } = await pool.query(
    `SELECT 1 FROM email_outbox WHERE alerted_at > now() - ($1 * interval '1 minute') LIMIT 1`,
    [ALERT_EVERY_MINUTES]
  );
  if (recent.length) return false;
  const { rows } = await pool.query(
    `UPDATE email_outbox SET alerted_at = now()
     WHERE status = 'failed' AND alerted_at IS NULL RETURNING id, kind, last_error, failed_at`
  );
  if (!rows.length) return false;

  const byKind = new Map();
  for (const r of rows) byKind.set(r.kind, (byKind.get(r.kind) || 0) + 1);
  const latest = rows.reduce((a, b) => (new Date(b.failed_at) > new Date(a.failed_at) ? b : a));
  const base = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
  const text =
    `${rows.length} email${rows.length === 1 ? "" : "s"} could not be sent after ${MAX_ATTEMPTS} attempts.\n\n` +
    [...byKind].map(([k, n]) => `  ${k}: ${n}`).join("\n") +
    `\n\nLast error: ${scrubPersonalData(latest.last_error || "(none)")}\n\n` +
    `Customers may be waiting for a confirmation or a link. Check the Gmail account (password revoked? daily limit reached?), ` +
    `then open ${base}/admin/email-outbox to retry them or mark them as handled. See docs/runbook.md, "Emails are not arriving".`;
  const ok = await sendAdminAlert({ subject: `[umas-books] ${rows.length} email${rows.length === 1 ? "" : "s"} could not be sent`, text });
  if (!ok) {
    await pool.query("UPDATE email_outbox SET alerted_at = NULL WHERE id = ANY($1::bigint[])", [rows.map((r) => r.id)]);
    return false;
  }
  return true;
}

// The worker tick. Guarded by an advisory lock so only one app instance works
// the queue at a time (the claim would make it safe anyway; this also keeps a
// second instance from re-reading the same rows every minute).
async function processOutbox(pool, { limit = BATCH_SIZE } = {}) {
  const client = await pool.connect();
  let locked = false;
  const summary = { sent: 0, failed: 0 };
  try {
    ({ rows: [{ locked }] } = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [ADVISORY_KEY]));
    if (!locked) return { skipped: true, ...summary };
    const batch = await claimDue(client, limit);
    let consecutiveFailures = 0;
    for (let i = 0; i < batch.length; i++) {
      if (await sendClaimed(pool, batch[i])) {
        summary.sent++;
        consecutiveFailures = 0;
      } else {
        summary.failed++;
        // Gmail is refusing everything: stop burning a 10 s timeout per row and
        // hand the unattempted ones back for the next tick.
        if (++consecutiveFailures >= 3) {
          const rest = batch.slice(i + 1).map((r) => r.id);
          if (rest.length) await client.query("UPDATE email_outbox SET next_try_at = now() WHERE id = ANY($1::bigint[])", [rest]);
          break;
        }
      }
    }
    await alertFailedEmails(pool).catch((err) => console.error("Outbox failure alert failed:", err.message));
  } finally {
    if (locked) await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_KEY]).catch(() => {});
    client.release();
  }
  return summary;
}

// Admin: put a failed (or handled) row back in the queue / try a pending one now.
async function retryNow(pool, id) {
  const { rowCount } = await pool.query(
    `UPDATE email_outbox SET status = 'pending', attempts = LEAST(attempts, $2::int - 1), next_try_at = now(), failed_at = NULL, alerted_at = NULL, handled_at = NULL
     WHERE id = $1 AND status IN ('pending', 'failed', 'handled') AND sent_at IS NULL AND purged_at IS NULL`,
    [id, MAX_ATTEMPTS]
  );
  if (!rowCount) return { ok: false };
  const result = await deliverNow(pool, id);
  return { ok: true, ...result };
}

async function markFailedHandled(pool) {
  const { rowCount } = await pool.query(
    "UPDATE email_outbox SET status = 'handled', handled_at = now() WHERE status = 'failed'"
  );
  return rowCount;
}

// Retention: a stored message is personal data. Blanks the recipient, subject,
// body and headers of sent rows after sentDays and of failed/handled rows after
// failedDays; the bare row (kind, status, dates, error text with PII scrubbed)
// stays as a delivery record.
async function purgeOutbox(pool, { sentDays, failedDays }) {
  const r = await pool.query(
    `UPDATE email_outbox
     SET to_email = 'erased@erased.invalid', subject = '', body_text = '', body_html = NULL, headers = '{}'::jsonb,
         purged_at = now()
     WHERE purged_at IS NULL AND (
       (status = 'sent' AND sent_at < now() - ($1 * interval '1 day'))
       OR (status IN ('failed', 'handled') AND COALESCE(failed_at, created_at) < now() - ($2 * interval '1 day'))
     )`,
    [sentDays, failedDays]
  );
  return r.rowCount;
}

// Right to erasure (lib/privacy.js eraseMember): everything queued for this address.
async function eraseOutboxFor(db, email) {
  const r = await db.query(
    `UPDATE email_outbox
     SET to_email = 'erased@erased.invalid', subject = '', body_text = '', body_html = NULL, headers = '{}'::jsonb,
         purged_at = now(), status = CASE WHEN status = 'pending' THEN 'handled' ELSE status END
     WHERE lower(to_email) = lower($1) AND purged_at IS NULL`,
    [email]
  );
  return r.rowCount;
}

module.exports = {
  enqueueEmail, sendEmail, deliverNow, processOutbox, alertFailedEmails, retryNow, markFailedHandled,
  purgeOutbox, eraseOutboxFor, MAX_ATTEMPTS, BACKOFF_MINUTES, TOKEN_KINDS,
};
