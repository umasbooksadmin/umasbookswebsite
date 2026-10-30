// Membership sign-up and payment now happen entirely on a HelloAsso
// "Adhésion" form (see membership.html) rather than on our own site, so
// is_member is kept in sync here rather than set directly by a route —
// the only two writers of is_member are this file (from a real HelloAsso
// payment) and the manual admin toggle at /admin/members (for one-off
// exceptions, which stay in effect since those accounts have no
// member_expires_at to lapse).

const { findMembershipOrdersByEmail, listRecentMembershipOrders, isConfigured } = require("./helloasso");
const { sendAdminAlert } = require("./errorAlert");
const config = require("./config");
const { looseBaseUrl } = require("./baseUrl");
const { parisDateString, parisInstant } = require("./tz");

const UNMATCHED_ALERT_EVERY_MINUTES = 60;

function isAuthorized(order) {
  return Array.isArray(order.payments) && order.payments.some((p) => p.state === "Authorized");
}

// Optional: restrict membership to ONE HelloAsso form (its slug, e.g.
// "adhesion-2026"). Unset = every Membership-type form of the organisation.
// An order that carries no formSlug at all is accepted only when unset.
function formMatches(order) {
  const slug = config.get("HELLOASSO_MEMBERSHIP_FORM_SLUG");
  if (!slug) return true;
  return String(order.formSlug || "").toLowerCase() === slug;
}

function amountCents(order) {
  const n = order && order.amount && Number(order.amount.total);
  return Number.isFinite(n) ? n : 0;
}

// A payment that grants membership: paid (Authorized), more than 0 EUR (a free
// or 100%-discounted order is not a membership), on the configured form.
function countsForMembership(order) {
  return isAuthorized(order) && amountCents(order) > 0 && formMatches(order);
}

// Calendar arithmetic on "YYYY-MM-DD" strings (UTC fields only, so the process and database time zones
// play no part). A membership lasts one calendar year: paid on 2027-03-01 it runs through 2028-03-01.
function addOneYear(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  const ny = y + 1;
  const leap = (ny % 4 === 0 && ny % 100 !== 0) || ny % 400 === 0;
  const nd = m === 2 && d === 29 && !leap ? 28 : d; // 29 February: the last day of February the year after
  return `${String(ny).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(nd).padStart(2, "0")}`;
}
function nextDay(ymd) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
// The last instant (23:59:59.999, Paris time) of a Paris day: so every page that shows the end date as a
// date shows the LAST day of the membership, and an end date is never an hour out across a clock change.
function endOfParisDay(ymd) {
  return new Date(parisInstant(nextDay(ymd)).getTime() - 1);
}

// End date of a membership built from payments, oldest first. Every payment adds ONE CALENDAR YEAR in Paris
// time (not 365 days: a leap year would end a day early, and the end hour would drift across a clock change)
// and the membership ends at the END of that Paris day. A payment made while the previous period is still
// running starts when that one ends, so renewing early loses no time:
//   last day = one year after max(paid day, previous last day).
// Derived only from the payments, so re-running a sync never adds time twice.
function expiryFromPayments(paidAtList) {
  const paid = [...paidAtList].map((d) => new Date(d)).sort((a, b) => a - b);
  let lastDay = null; // the last Paris day the membership covers so far
  for (const at of paid) {
    const stillRunning = lastDay && at.getTime() <= endOfParisDay(lastDay).getTime();
    lastDay = addOneYear(stillRunning ? lastDay : parisDateString(at));
  }
  return lastDay ? endOfParisDay(lastDay) : null;
}

// Sets is_member/member_expires_at for one account from its recorded payments
// (db is a pool or a transaction client). A result already in the past grants
// nothing: a year-old payment found late must not flip is_member on with a
// dead end date. Returns the end date applied, or null.
async function applyMembershipGrant(db, userId, now = new Date()) {
  const { rows } = await db.query(
    // NULL amount: a row recorded before amounts were stored; it stays valid.
    // A payment HelloAsso later refunded (reversed_at set) grants nothing.
    "SELECT paid_at FROM membership_payments WHERE user_id = $1 AND reversed_at IS NULL AND (amount_cents IS NULL OR amount_cents > 0)",
    [userId]
  );
  if (!rows.length) return null;
  const expiresAt = expiryFromPayments(rows.map((r) => r.paid_at));
  if (expiresAt.getTime() <= now.getTime()) return null;
  await db.query(
    "UPDATE users SET is_member = TRUE, member_expires_at = $1 WHERE id = $2 AND (NOT is_member OR member_expires_at IS DISTINCT FROM $1)",
    [expiresAt, userId]
  );
  return expiresAt;
}

// A payment we cannot attach to a confirmed account is KEPT (user_id NULL,
// unmatched_at set) instead of only logged: it shows in /admin/members under
// "Unmatched membership payments" and triggers a (throttled) admin alert. The
// usual cause is a typo in the email typed on HelloAsso's own form.
async function recordUnmatchedPayments(pool, email, orders, reason) {
  for (const order of orders.filter(countsForMembership)) {
    await pool.query(
      `INSERT INTO membership_payments (user_id, helloasso_order_id, payer_email, amount_cents, paid_at, unmatched_at, unmatched_reason)
       VALUES (NULL, $1, $2, $3, $4, now(), $5)
       ON CONFLICT (helloasso_order_id) DO NOTHING`,
      [order.id, (order.payer && order.payer.email) || email, amountCents(order), new Date(order.date), reason]
    );
  }
  await alertUnmatchedPayments(pool).catch((err) => console.error("Unmatched-payment alert failed:", err.message));
}

// ONE alert per hour covering every unmatched payment not yet alerted. The
// claim is a single UPDATE (two instances cannot both alert); it is handed
// back when the alert mail cannot be sent, so the next tick tries again.
async function alertUnmatchedPayments(pool) {
  const { rows: recent } = await pool.query(
    "SELECT 1 FROM membership_payments WHERE alerted_at > now() - ($1 * interval '1 minute') LIMIT 1",
    [UNMATCHED_ALERT_EVERY_MINUTES]
  );
  if (recent.length) return false;
  const { rows } = await pool.query(
    `UPDATE membership_payments SET alerted_at = now()
     WHERE user_id IS NULL AND unmatched_at IS NOT NULL AND alerted_at IS NULL
     RETURNING id, payer_email, amount_cents, paid_at, unmatched_reason`
  );
  if (!rows.length) return false;
  const base = looseBaseUrl();
  const subject = rows.length === 1
    ? `[umas-books] Membership payment from ${rows[0].payer_email} matches no confirmed account`
    : `[umas-books] ${rows.length} membership payments match no confirmed account`;
  const lines = rows.map((r) =>
    `- ${r.payer_email}: EUR ${(r.amount_cents / 100).toFixed(2)}, paid ${new Date(r.paid_at).toISOString().slice(0, 10)} ` +
    `(${r.unmatched_reason === "unverified" ? "an account with this email exists but its email is not confirmed" : "no account with this email"})`
  );
  const text =
    `${lines.join("\n")}\n\n` +
    `The person paid on HelloAsso but no confirmed site account uses that email (often a typo, or another address than their account's). ` +
    `Open ${base}/admin/members#unmatched-payments, find their account and use "Link to account". See docs/runbook.md, "A member paid with another email".`;
  const ok = await sendAdminAlert({ subject, text });
  if (!ok) {
    await pool.query("UPDATE membership_payments SET alerted_at = NULL WHERE id = ANY($1::int[])", [rows.map((r) => r.id)]);
    return false;
  }
  return true;
}

// Admin tool: attach an unmatched payment to the account the admin chose and
// run the grant, in one transaction. Resolves { ok, reason? }.
async function linkUnmatchedPayment(pool, paymentId, userId, now = new Date()) {
  const { withTransaction } = require("../db"); // lazy: unit tests load this file without a database
  // An unmatched payment can be refunded before anyone links it. Re-check HelloAsso first (outside the
  // transaction: no network call while rows are locked); a refund found now is recorded as a reversal.
  const { rows: pre } = await pool.query(
    "SELECT payer_email, helloasso_order_id FROM membership_payments WHERE id = $1 AND user_id IS NULL AND unmatched_at IS NOT NULL",
    [paymentId]
  );
  if (pre.length && isConfigured()) {
    let found;
    try {
      found = await findMembershipOrdersByEmail(pre[0].payer_email);
    } catch (err) {
      console.error("Cannot re-check an unmatched membership payment at HelloAsso:", err.message);
      return { ok: false, reason: "check_failed" };
    }
    await reverseRecordedPayments(pool, found);
  }
  return withTransaction(pool, async (client) => {
    const { rows: pay } = await client.query(
      "SELECT id, reversed_at FROM membership_payments WHERE id = $1 AND user_id IS NULL AND unmatched_at IS NOT NULL FOR UPDATE",
      [paymentId]
    );
    if (!pay.length) return { ok: false, reason: "payment_gone" };
    if (pay[0].reversed_at) return { ok: false, reason: "refunded" };
    const { rows: u } = await client.query("SELECT id, is_disabled FROM users WHERE id = $1 FOR UPDATE", [userId]);
    if (!u.length) return { ok: false, reason: "no_account" };
    if (u[0].is_disabled) return { ok: false, reason: "disabled" };
    await client.query(
      "UPDATE membership_payments SET user_id = $1, unmatched_at = NULL, unmatched_reason = NULL, linked_at = now() WHERE id = $2",
      [userId, paymentId]
    );
    const expiresAt = await applyMembershipGrant(client, userId, now);
    return { ok: true, expiresAt };
  });
}

// Reverses every RECORDED payment whose order HelloAsso returned and no longer shows as Authorized, matched by
// helloasso_order_id and NOT by owner: a payment linked by hand to an account with another email (or kept after the
// account's email changed) is still the same order. Same semantics as the per-account pass in
// syncMembershipForEmail: the row is kept, reversed_at is dated once, then each owner's membership is recomputed
// (is_member is only cleared when it was payment-driven, i.e. member_expires_at set). Returns the reversed count.
async function reverseRecordedPayments(pool, orders) {
  const ids = orders.filter((o) => !isAuthorized(o)).map((o) => Number(o.id)).filter(Number.isFinite);
  if (!ids.length) return 0;
  const { rows } = await pool.query(
    `UPDATE membership_payments SET reversed_at = now(), reversed_amount_cents = amount_cents
     WHERE helloasso_order_id = ANY($1::bigint[]) AND reversed_at IS NULL
     RETURNING user_id`,
    [ids]
  );
  const owners = [...new Set(rows.map((r) => r.user_id).filter((id) => id != null))];
  for (const userId of owners) {
    const { rows: left } = await pool.query(
      "SELECT 1 FROM membership_payments WHERE user_id = $1 AND reversed_at IS NULL AND (amount_cents IS NULL OR amount_cents > 0) LIMIT 1",
      [userId]
    );
    if (left.length) await applyMembershipGrant(pool, userId); // another payment still stands: recompute the end date
    else {
      await pool.query(
        "UPDATE users SET is_member = FALSE, member_expires_at = NULL WHERE id = $1 AND member_expires_at IS NOT NULL",
        [userId]
      );
    }
  }
  return rows.length;
}

// Re-checks HelloAsso (never trusts the webhook body itself — see
// lib/helloasso.js) for this payer's Membership-form orders, records any
// newly-seen paid order, extends the matching site account's membership
// (see expiryFromPayments), and REVERSES any
// previously-recorded payment whose order is returned by HelloAsso but no
// longer shows as Authorized (a refund or a won dispute both land here,
// since HelloAsso reuses the same order id and just flips its payment's
// state — see paiement-remboursé.md/paiement-contesté-gagne.md). A reversed
// payment is kept and marked (reversed_at), never deleted. A
// recorded payment that is merely absent from the response is kept. A payer
// email with no matching (or no confirmed) account is recorded as an
// unmatched payment for the admin to link by hand (see above).
async function syncMembershipForEmail(pool, email) {
  if (!email) return;
  const orders = await findMembershipOrdersByEmail(email);
  if (!orders.length) return;

  // Refunds/disputes first, by order id, whoever owns the recorded payment (see reverseRecordedPayments).
  await reverseRecordedPayments(pool, orders);

  const { rows: userRows } = await pool.query("SELECT id, email_verified_at FROM users WHERE lower(email) = lower($1)", [email]);
  const user = userRows[0];
  if (!user) {
    console.warn(`HelloAsso membership payment has no matching site account — recorded as unmatched.`);
    await recordUnmatchedPayments(pool, email, orders, "no_account");
    return;
  }
  // Signup never proved this account actually controls this email
  // address (see migrations/032_email_verification.sql) — auto-matching
  // an unverified account here is exactly what let someone register a
  // real person's email ahead of them and inherit a membership payment
  // that person later made with their own money. This stops the
  // mis-attribution itself; it doesn't free up the email address for its
  // real owner to sign up with (the UNIQUE constraint still blocks that)
  // — that part still needs an admin to step in via /admin/members (edit
  // the squatter's email, or disable the account) once noticed.
  if (!user.email_verified_at) {
    console.warn(`HelloAsso membership payment matched an account with an unverified email — recorded as unmatched.`);
    await recordUnmatchedPayments(pool, email, orders, "unverified");
    return;
  }

  // Orders HelloAsso returned, by id. The search is fuzzy and paginated
  // (pageSize 50), so a recorded payment merely missing from the response
  // proves nothing; only an order that IS present and no longer Authorized
  // is positive evidence of a refund/dispute.
  const returnedById = new Map(orders.map((o) => [Number(o.id), o]));

  // A row can already exist without an owner: eraseMember() detaches a deleted
  // account's payments (user_id NULL, payer email replaced) because the record
  // must be kept for accounting. When the same person registers again and
  // confirms their email, that orphan row is re-attached to the new account
  // (only ever an orphan: a row owned by another account is never taken over),
  // otherwise their paid membership would never be restored.
  for (const order of orders.filter(countsForMembership)) {
  // (A payment earlier recorded as UNMATCHED, user_id NULL, is attached here too.)
    await pool.query(
      `INSERT INTO membership_payments (user_id, helloasso_order_id, payer_email, amount_cents, paid_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (helloasso_order_id) DO UPDATE
         SET user_id = EXCLUDED.user_id, payer_email = EXCLUDED.payer_email,
             linked_at = CASE WHEN membership_payments.unmatched_at IS NOT NULL THEN now() ELSE membership_payments.linked_at END,
             unmatched_at = NULL, unmatched_reason = NULL
         WHERE membership_payments.user_id IS NULL`,
      [user.id, order.id, email, amountCents(order), new Date(order.date)]
    );
  }

  const { rows: recorded } = await pool.query(
    "SELECT id, helloasso_order_id, paid_at, amount_cents, reversed_at FROM membership_payments WHERE user_id = $1",
    [user.id]
  );
  const reversing = []; // newly refunded / lost in a dispute: kept as a record, marked reversed (never deleted)
  const reinstating = []; // reversed earlier, Authorized again: the payment stands again
  let alreadyReversed = false;
  let ungranted = false; // a recorded payment that no longer counts (0 EUR)
  let validCount = 0;
  for (const r of recorded) {
    const order = returnedById.get(Number(r.helloasso_order_id));
    if (order && !isAuthorized(order)) {
      if (r.reversed_at) alreadyReversed = true;
      else reversing.push(r);
    } else if (r.reversed_at && !order) {
      alreadyReversed = true; // absent from the response proves nothing: a reversal stays
    } else {
      if (r.reversed_at) reinstating.push(r);
      if (!order) {
        console.warn(`HelloAsso order ${r.helloasso_order_id} is recorded but absent from the search response — keeping it.`);
      }
      if (r.amount_cents == null || r.amount_cents > 0) validCount++;
      else ungranted = true;
    }
  }
  if (reversing.length) {
    // The row is KEPT (10-year accounting record) and the reversal is dated once: the accounting export adds a
    // NEGATIVE Membership row on that day (lib/accounting.js), so a month already exported never changes.
    // reversed_at IS NULL in the WHERE: a second sync never moves the date.
    await pool.query(
      `UPDATE membership_payments SET reversed_at = now(), reversed_amount_cents = amount_cents
       WHERE id = ANY($1::int[]) AND reversed_at IS NULL`,
      [reversing.map((r) => r.id)]
    );
  }
  if (reinstating.length) {
    await pool.query(
      "UPDATE membership_payments SET reversed_at = NULL, reversed_amount_cents = NULL WHERE id = ANY($1::int[])",
      [reinstating.map((r) => r.id)]
    );
  }

  if (!validCount) {
    // Nothing left to base a membership on. Only clear is_member if it
    // was payment-driven (member_expires_at set) — a manual admin grant
    // (member_expires_at NULL) is never touched by this sync.
    if (reversing.length || alreadyReversed || ungranted) {
      await pool.query(
        "UPDATE users SET is_member = FALSE, member_expires_at = NULL WHERE id = $1 AND member_expires_at IS NOT NULL",
        [user.id]
      );
    }
    return;
  }

  await applyMembershipGrant(pool, user.id);
}

// Fire-and-forget re-sync for the moment an account becomes eligible for
// attribution (email verified, password reset, admin-created account): a
// payer who paid before their account existed or was verified is only
// otherwise picked up by the webhook/backstop that already ran. Never
// throws and never blocks the caller; does nothing when HelloAsso isn't
// configured (dev) so it can't spam errors.
function syncMembershipInBackground(pool, email) {
  if (!email || !isConfigured()) return;
  syncMembershipForEmail(pool, email).catch((err) =>
    console.error(`Membership sync after account change failed:`, err.message));
}

// Belt-and-suspenders backstop (see runReservationMaintenance/runCartMaintenance
// in index.js for the same pattern): a membership granted manually from
// /admin/members has no member_expires_at and is never touched here.
async function expireStaleMemberships(pool) {
  await pool.query(
    "UPDATE users SET is_member = FALSE WHERE is_member = TRUE AND member_expires_at IS NOT NULL AND member_expires_at < now()"
  );
}

// Periodic backstop for the public, unsigned webhook (see
// routes/helloassoWebhook.js): the hosted membership form creates no local
// order row, so unlike shop orders nothing else would ever notice a
// missed delivery. One org-wide lookup, then the normal verified
// per-email sync for each distinct payer with a recent order. Only a
// recent window is re-synced — the sync is idempotent, this just avoids
// re-checking every historical member on each run. (A refund on an older
// order is still only caught by its webhook.)
//
// The window is 60 days (it was 3): a refund usually comes days to weeks after the payment, and the sync is what
// marks the payment reversed (reversed_at), so a missed webhook for a refund is now caught for two months.
// Cost, bounded: the org-wide listing is ONE HelloAsso call returning at most 50 orders (pageSize 50), so there
// are at most 50 distinct payers, i.e. at most 1 + 50 calls per run; the job runs every 6 h, so at most ~204
// calls a day, made one after the other. These calls do not go through the webhook guard's 120-per-10-minutes
// cap (lib/webhookGuard.js), which only limits the public webhook; MAX_RECONCILE_EMAILS is a second, explicit
// ceiling on what a run may check. Typical use is far lower: a small shop has a handful of payers in 60 days.
const RECENT_WINDOW_MS = 60 * 24 * 60 * 60 * 1000;
const MAX_RECONCILE_EMAILS = 50;

async function reconcileRecentMemberships(pool) {
  if (!isConfigured()) return;
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const orders = await listRecentMembershipOrders();
  const emails = new Set(
    [...new Set(
      orders
        .filter((o) => o.payer && typeof o.payer.email === "string" && new Date(o.date).getTime() >= cutoff)
        .map((o) => o.payer.email.toLowerCase())
    )].slice(0, MAX_RECONCILE_EMAILS) // newest first (the listing is sorted that way)
  );
  const failures = [];
  for (const email of emails) {
    try {
      await syncMembershipForEmail(pool, email);
    } catch (err) {
      console.error(`Membership reconciliation failed:`, err.message);
      failures.push(err.message);
    }
  }
  // One bad payer must not stop the others (the loop above carries on), but the
  // run still counts as failed so the job tracker (lib/jobRuns.js) can alert.
  if (failures.length) throw new Error(`${failures.length} of ${emails.size} membership check(s) failed; first: ${failures[0]}`);
}

module.exports = { alertUnmatchedPayments, linkUnmatchedPayment, expiryFromPayments, applyMembershipGrant, countsForMembership, syncMembershipForEmail, syncMembershipInBackground, expireStaleMemberships, reconcileRecentMemberships };
