// Email outbox: every customer email is STORED first, then sent.
//
// Why: mail goes through one Gmail mailbox. When Gmail is down, rate-limited
// (about 2000 messages a day) or the app password is revoked, a send used to
// fail with only a console.error: a buyer paid and never got a confirmation,
// a signup never got its link, and nobody knew. Now:
//
//   enqueueEmail(db, msg)   inserts the row. `db` may be a transaction
//                           client, so a paid order and its confirmation are
//                           queued atomically (lib/cart.js createReservation).
//   sendEmail(msg)          enqueue + immediate best-effort send, so people
//                           still get instant mail. Never throws on a send
//                           failure (the worker retries); throws only when
//                           the row cannot be stored (database down).
//   deliverNow(pool, id)    the immediate send for a row stored in a
//                           transaction, called after it committed.
//   processOutbox(pool)     the 60-second worker: retries due rows with
//                           backoff 1, 5, 15, 60, 240 min (then every 240 min)
//                           up to 8 attempts, then marks the row 'failed' and
//                           sends ONE admin alert per hour. A row waiting over
//                           60 minutes raises one "stuck" alert per 6 hours.
//   purgeOutbox(pool)       retention: bodies are personal data (see privacy.js).
//
// Two protections against misuse of the one-time-link mails (see THROTTLED_KINDS):
//   - per-RECIPIENT throttling: anyone can type someone else's address into the
//     signup / forgot-password / membership / book-request forms, so the mail
//     layer (not only the per-IP limits) caps what one address can receive and
//     what the shop sends per hour. Throttled requests store nothing; the web
//     response is the same neutral one, so nothing can be enumerated.
//   - token bodies: a reset/confirmation link must not sit in the database (or
//     its dumps and backups) after it is useless: bodies of TOKEN_KINDS rows are
//     blanked when sent, when they FAIL, and when their link lifetime passes
//     while still pending (status 'expired', never retried).
//
// A row is "claimed" by pushing next_try_at five minutes ahead in a single
// UPDATE, so the fast path and the worker (or two app instances) can never
// both send the same row.
const mailer = require("../mailer");
const { scrubPersonalData } = require("./scrub");
const { sendAdminAlert } = require("./errorAlert");
const { claimAlertSlot, releaseAlertSlot } = require("./alertFlags");

const MAX_ATTEMPTS = 8;
// Minutes to wait after the Nth failed attempt (1-based); the last value repeats.
const BACKOFF_MINUTES = [1, 5, 15, 60, 240];
const LEASE_MINUTES = 5;
const BATCH_SIZE = 20;
const ALERT_EVERY_MINUTES = 60;
// The backoff adds up to 801 minutes before a row becomes 'failed' (and alerts),
// so a mail that cannot be sent would stay silent for most of a working day.
// Any row still waiting after STUCK_AFTER_MINUTES raises one alert per
// STUCK_ALERT_EVERY_MINUTES.
const STUCK_AFTER_MINUTES = 60;
const STUCK_ALERT_EVERY_MINUTES = 6 * 60;
const STUCK_FLAG = "outbox-stuck";
const FAST_PATH_WAIT_MS = 5000;
const ADVISORY_KEY = 7243902;

// Kinds whose body is a live login/confirmation link. The link is single-use
// and short-lived, so the body is blanked as soon as the mail is sent.
const TOKEN_KINDS = new Set(["verification", "password_reset", "book_request_confirm", "book_request_list", "signup_attempt"]);
// How long the link inside such a mail works; a still-pending mail older than
// this is dead weight (and a live link in the database) and is expired.
// verification / password_reset match lib/emailVerification.js (24 h) and
// lib/passwordReset.js (1 h); the book-request ones match lib/bookRequests.js LIMITS.
const TOKEN_LIFETIME_MINUTES = {
  password_reset: 60,
  verification: 24 * 60,
  signup_attempt: 24 * 60,
  book_request_confirm: 7 * 24 * 60,
  book_request_list: 30 * 24 * 60,
};

// Kinds an anonymous visitor can trigger toward ANY address they type. Order and
// reservation confirmations, reminders and admin mail are never in this set.
const THROTTLED_KINDS = new Set(["verification", "signup_attempt", "password_reset", "book_request_confirm", "book_request_list"]);
const THROTTLE = {
  intervalMinutes: 10, // at most 1 mail per (recipient, kind) per this many minutes
  perRecipientPerDay: 5, // and at most this many throttled-kind mails per recipient per 24 h
  // Shop-wide ceiling per kind per hour: a flood of DIFFERENT addresses cannot
  // make Gmail (about 2000 a day) refuse the order confirmations. Trade-off: a
  // determined flood can use the ceiling up and delay genuine signups for an
  // hour (the per-IP limits still apply first); the log counter shows it. The
  // MAIL_GLOBAL_PER_HOUR environment variable overrides all of them (tests).
  globalPerHour: { verification: 100, signup_attempt: 100, password_reset: 60, book_request_confirm: 60, book_request_list: 60 },
};
const throttleCounts = new Map(); // "kind:reason" -> number since boot (never any address)
const getThrottleCounts = () => Object.fromEntries(throttleCounts);
const resetThrottleCounts = () => throttleCounts.clear();

const backoffMinutes = (attempts) => BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length) - 1];

// The address of the person a message is ABOUT when it is not the recipient:
// form mail goes to the shop inbox, the submitter is the Reply-To.
function subjectEmailOf(msg) {
  if (msg.subjectEmail) return String(msg.subjectEmail).trim().toLowerCase() || null;
  if (msg.kind !== "contact" || !msg.replyTo) return null;
  const addr = typeof msg.replyTo === "string" ? msg.replyTo : msg.replyTo.address;
  return addr ? String(addr).trim().toLowerCase() : null;
}

async function enqueueEmail(db, msg) {
  if (!msg || !msg.to || !msg.subject || msg.text == null || !msg.kind) {
    throw new Error("enqueueEmail: to, subject, text and kind are required");
  }
  const headers = {};
  if (msg.replyTo) headers.replyTo = msg.replyTo;
  if (msg.headers && Object.keys(msg.headers).length) headers.extra = msg.headers;
  const { rows } = await db.query(
    `INSERT INTO email_outbox (to_email, subject, body_text, body_html, headers, lang, kind, related_order_id, subject_email)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9) RETURNING id`,
    [msg.to, msg.subject, msg.text, msg.html || null, JSON.stringify(headers), msg.lang || null, msg.kind, msg.relatedOrderId || null, subjectEmailOf(msg)]
  );
  return rows[0].id;
}

function globalCap(kind, limits) {
  if (limits && limits.globalPerHour) return limits.globalPerHour[kind] ?? Infinity;
  const override = Number(process.env.MAIL_GLOBAL_PER_HOUR);
  if (Number.isFinite(override) && override > 0) return override;
  return THROTTLE.globalPerHour[kind] ?? Infinity;
}

// Stores a mail of a THROTTLED kind unless the recipient or the shop is over a
// cap. Resolves { id } or { throttled: reason } (reason: "interval" | "daily" |
// "global"). One transaction per recipient (advisory lock), so parallel
// requests for the same address cannot both pass the check.
//   mode "skipInterval": the caller has its own cooldown (resend buttons): the
//        10-minute rule is skipped, the daily and shop-wide caps still apply.
//   mode "off": never throttled (an admin acting on purpose).
async function enqueueThrottled(db, msg, { mode, limits } = {}) {
  if (mode === "off") return { id: await enqueueEmail(db, msg) };
  const t = { ...THROTTLE, ...(limits || {}) };
  const own = typeof db.connect === "function";
  const client = own ? await db.connect() : db;
  try {
    if (own) await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [`mailthrottle:${String(msg.to).toLowerCase()}`]);
    const { rows: [r] } = await client.query(
      `SELECT count(*) FILTER (WHERE kind = $2 AND created_at > now() - ($3 * interval '1 minute'))::int AS recent,
              count(*)::int AS day
       FROM email_outbox
       WHERE lower(to_email) = lower($1) AND kind = ANY($4::text[]) AND created_at > now() - interval '1 day'`,
      [msg.to, msg.kind, t.intervalMinutes, [...THROTTLED_KINDS]]
    );
    let reason = null;
    if (mode !== "skipInterval" && r.recent >= 1) reason = "interval";
    else if (r.day >= t.perRecipientPerDay) reason = "daily";
    if (!reason) {
      const cap = globalCap(msg.kind, limits);
      if (Number.isFinite(cap)) {
        const { rows: [g] } = await client.query(
          "SELECT count(*)::int AS n FROM email_outbox WHERE kind = $1 AND created_at > now() - interval '1 hour'",
          [msg.kind]
        );
        if (g.n >= cap) reason = "global";
      }
    }
    if (reason) {
      if (own) await client.query("ROLLBACK");
      const key = `${msg.kind}:${reason}`;
      throttleCounts.set(key, (throttleCounts.get(key) || 0) + 1);
      console.warn(`Mail throttled (${key}), ${throttleCounts.get(key)} since boot.`);
      return { throttled: reason };
    }
    const id = await enqueueEmail(client, msg);
    if (own) await client.query("COMMIT");
    return { id };
  } catch (err) {
    if (own) await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    if (own) client.release();
  }
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
      // A failed one-time-link mail is blanked at once: nobody will ever use
      // that link, and it must not sit in the database (or a backup) for the
      // 90 days a failed row is kept.
      await pool.query(
        `UPDATE email_outbox SET status = 'failed', failed_at = now(), attempts = $2, last_error = $3,
           body_text = CASE WHEN $4 THEN '' ELSE body_text END,
           body_html = CASE WHEN $4 THEN NULL ELSE body_html END
         WHERE id = $1`,
        [row.id, attempts, text, TOKEN_KINDS.has(row.kind)]
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
// throttle: see enqueueThrottled (only kinds in THROTTLED_KINDS are affected).
// A throttled mail resolves { id: null, sent: false, queued: false, throttled: reason }:
// callers that must stay neutral (signup, forgot-password) simply ignore it.
async function sendEmail(msg, { db = require("../db").pool, waitMs, throttle, limits } = {}) { // db is loaded lazily: unit tests load this file without a database
  let id;
  if (msg && THROTTLED_KINDS.has(msg.kind) && throttle !== "off" && msg.to) {
    const r = await enqueueThrottled(db, msg, { mode: throttle, limits });
    if (r.throttled) return { id: null, sent: false, queued: false, throttled: r.throttled };
    id = r.id;
  } else {
    id = await enqueueEmail(db, msg);
  }
  const result = await deliverNow(db, id, { waitMs });
  return { id, ...result };
}

// A pending mail whose one-time link has lapsed is never sent: marked 'expired'
// and its body (the link) blanked. Run first in every worker tick.
async function expireStaleTokenMail(pool) {
  const kinds = Object.keys(TOKEN_LIFETIME_MINUTES);
  const r = await pool.query(
    `UPDATE email_outbox o
     SET status = 'expired', body_text = '', body_html = NULL, last_error = 'link lifetime passed, not sent'
     FROM unnest($1::text[], $2::int[]) AS t(kind, minutes)
     WHERE o.status = 'pending' AND o.kind = t.kind AND o.created_at < now() - (t.minutes * interval '1 minute')`,
    [kinds, kinds.map((k) => TOKEN_LIFETIME_MINUTES[k])]
  );
  return r.rowCount;
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

// One alert (at most every 6 hours, across restarts and instances: alert_flags)
// when any email has been waiting more than an hour, whether it is pending its
// first try or retrying. Lists counts per kind only: no addresses, no subjects.
async function alertStuckEmails(pool) {
  const { rows } = await pool.query(
    `SELECT kind, COUNT(*)::int AS n, MIN(created_at) AS oldest,
            (array_agg(last_error ORDER BY attempts DESC, id DESC) FILTER (WHERE last_error IS NOT NULL))[1] AS sample_error
       FROM email_outbox
      WHERE status = 'pending' AND created_at < now() - ($1 * interval '1 minute')
      GROUP BY kind ORDER BY kind`,
    [STUCK_AFTER_MINUTES]
  );
  if (!rows.length) return false;
  if (!(await claimAlertSlot(pool, STUCK_FLAG, STUCK_ALERT_EVERY_MINUTES))) return false;

  const total = rows.reduce((a, r) => a + r.n, 0);
  const oldest = rows.reduce((a, r) => (new Date(r.oldest) < new Date(a) ? r.oldest : a), rows[0].oldest);
  const minutes = Math.round((Date.now() - new Date(oldest).getTime()) / 60000);
  const sample = rows.map((r) => r.sample_error).find(Boolean);
  const base = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
  const text =
    `${total} email${total === 1 ? " has" : "s have"} been waiting to be sent for more than ${STUCK_AFTER_MINUTES} minutes ` +
    `(the oldest for ${minutes} minutes). The site keeps retrying, but something is wrong with sending.\n\n` +
    rows.map((r) => `  ${r.kind}: ${r.n}`).join("\n") +
    `\n\nLast error: ${scrubPersonalData(sample || "(none recorded yet)")}\n\n` +
    `Check the Gmail account (password revoked? daily limit reached?) and that GMAIL_USER / GMAIL_APP_PASSWORD are set in Render, ` +
    `then open ${base}/admin/email-outbox. This alert repeats at most every ${STUCK_ALERT_EVERY_MINUTES / 60} hours. ` +
    `See docs/runbook.md, "Emails are not arriving".`;
  const ok = await sendAdminAlert({ subject: `[umas-books] ${total} email${total === 1 ? " is" : "s are"} stuck in the outbox`, text });
  if (!ok) {
    await releaseAlertSlot(pool, STUCK_FLAG);
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
    await expireStaleTokenMail(pool).catch((err) => console.error("Outbox: expiring stale link mail failed:", err.message));
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
    await alertStuckEmails(pool).catch((err) => console.error("Outbox stuck-email alert failed:", err.message));
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
     WHERE id = $1 AND status IN ('pending', 'failed', 'handled') AND sent_at IS NULL AND purged_at IS NULL
       AND (body_text <> '' OR NOT (kind = ANY($3::text[])))`, 
    [id, MAX_ATTEMPTS, [...TOKEN_KINDS]]
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
       OR (status IN ('failed', 'handled', 'expired') AND COALESCE(failed_at, created_at) < now() - ($2 * interval '1 day'))
     )`,
    [sentDays, failedDays]
  );
  return r.rowCount;
}

// Right to erasure (lib/privacy.js eraseMember, lib/privacyRequests.js): every
// message queued for this address, as recipient (to_email) or as the person the
// message is about (subject_email: form mail to the shop inbox).
async function eraseOutboxFor(db, email) {
  const r = await db.query(
    `UPDATE email_outbox
     SET to_email = 'erased@erased.invalid', subject = '', body_text = '', body_html = NULL, headers = '{}'::jsonb,
         subject_email = NULL, purged_at = now(), status = CASE WHEN status = 'pending' THEN 'handled' ELSE status END
     WHERE (lower(to_email) = lower($1) OR lower(subject_email) = lower($1)) AND purged_at IS NULL`,
    [email]
  );
  return r.rowCount;
}

// What we hold in the outbox for an address (no bodies): for the admin Privacy
// requests tool and the member export.
async function listOutboxFor(db, email) {
  const { rows } = await db.query(
    `SELECT id, kind, subject, status, created_at, sent_at,
            CASE WHEN lower(subject_email) = lower($1) AND lower(to_email) <> lower($1) THEN 'sender' ELSE 'recipient' END AS role
     FROM email_outbox
     WHERE (lower(to_email) = lower($1) OR lower(subject_email) = lower($1)) AND purged_at IS NULL
     ORDER BY created_at, id`,
    [email]
  );
  return rows;
}

module.exports = {
  enqueueEmail, enqueueThrottled, sendEmail, deliverNow, processOutbox, alertFailedEmails, alertStuckEmails, retryNow, markFailedHandled,
  purgeOutbox, eraseOutboxFor, listOutboxFor, expireStaleTokenMail, getThrottleCounts, resetThrottleCounts,
  MAX_ATTEMPTS, BACKOFF_MINUTES, TOKEN_KINDS, TOKEN_LIFETIME_MINUTES, THROTTLED_KINDS, THROTTLE,
};
