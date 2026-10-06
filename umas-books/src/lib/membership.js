// Membership sign-up and payment now happen entirely on a HelloAsso
// "Adhésion" form (see membership.html) rather than on our own site, so
// is_member is kept in sync here rather than set directly by a route —
// the only two writers of is_member are this file (from a real HelloAsso
// payment) and the manual admin toggle at /admin/members (for one-off
// exceptions, which stay in effect since those accounts have no
// member_expires_at to lapse).

const { findMembershipOrdersByEmail, listRecentMembershipOrders, isConfigured } = require("./helloasso");
const { sendAdminAlert } = require("./errorAlert");

const MEMBERSHIP_DURATION_MS = 365 * 24 * 60 * 60 * 1000;
const UNMATCHED_ALERT_EVERY_MINUTES = 60;

function isAuthorized(order) {
  return Array.isArray(order.payments) && order.payments.some((p) => p.state === "Authorized");
}

// Optional: restrict membership to ONE HelloAsso form (its slug, e.g.
// "adhesion-2026"). Unset = every Membership-type form of the organisation.
// An order that carries no formSlug at all is accepted only when unset.
function formMatches(order) {
  const slug = (process.env.HELLOASSO_MEMBERSHIP_FORM_SLUG || "").trim().toLowerCase();
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

// End date of a membership built from payments, oldest first. Every payment
// adds 365 days; a payment made while the previous period is still running
// starts when that one ends, so renewing early loses no time:
//   expiry = max(paid_at, previous expiry) + 365 days.
// Derived only from the payments, so re-running a sync never adds time twice.
function expiryFromPayments(paidAtList) {
  return [...paidAtList]
    .map((d) => new Date(d).getTime())
    .sort((a, b) => a - b)
    .reduce((exp, paid) => new Date(Math.max(paid, exp ? exp.getTime() : 0) + MEMBERSHIP_DURATION_MS), null);
}

// Sets is_member/member_expires_at for one account from its recorded payments
// (db is a pool or a transaction client). A result already in the past grants
// nothing: a year-old payment found late must not flip is_member on with a
// dead end date. Returns the end date applied, or null.
async function applyMembershipGrant(db, userId, now = new Date()) {
  const { rows } = await db.query(
    // NULL amount: a row recorded before amounts were stored; it stays valid.
    "SELECT paid_at FROM membership_payments WHERE user_id = $1 AND (amount_cents IS NULL OR amount_cents > 0)",
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
  const base = (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
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
  return withTransaction(pool, async (client) => {
    const { rows: pay } = await client.query(
      "SELECT id FROM membership_payments WHERE id = $1 AND user_id IS NULL AND unmatched_at IS NOT NULL FOR UPDATE",
      [paymentId]
    );
    if (!pay.length) return { ok: false, reason: "payment_gone" };
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

// Re-checks HelloAsso (never trusts the webhook body itself — see
// lib/helloasso.js) for this payer's Membership-form orders, records any
// newly-seen paid order, extends the matching site account's membership
// (see expiryFromPayments), and reverts any
// previously-recorded payment whose order is returned by HelloAsso but no
// longer shows as Authorized (a refund or a won dispute both land here,
// since HelloAsso reuses the same order id and just flips its payment's
// state — see paiement-remboursé.md/paiement-contesté-gagne.md). A
// recorded payment that is merely absent from the response is kept. A payer
// email with no matching (or no confirmed) account is recorded as an
// unmatched payment for the admin to link by hand (see above).
async function syncMembershipForEmail(pool, email) {
  if (!email) return;
  const orders = await findMembershipOrdersByEmail(email);
  if (!orders.length) return;

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

  for (const order of orders.filter(countsForMembership)) {
    // A payment earlier recorded as unmatched is attached now that the
    // account is confirmed; anything else already recorded is left alone.
    await pool.query(
      `INSERT INTO membership_payments (user_id, helloasso_order_id, payer_email, amount_cents, paid_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (helloasso_order_id) DO UPDATE
         SET user_id = EXCLUDED.user_id, unmatched_at = NULL, unmatched_reason = NULL, linked_at = now()
         WHERE membership_payments.user_id IS NULL AND membership_payments.unmatched_at IS NOT NULL`,
      [user.id, order.id, email, amountCents(order), new Date(order.date)]
    );
  }

  const { rows: recorded } = await pool.query(
    "SELECT id, helloasso_order_id, paid_at, amount_cents FROM membership_payments WHERE user_id = $1",
    [user.id]
  );
  const reversed = [];
  let ungranted = false; // a recorded payment that no longer counts (0 EUR)
  let validCount = 0;
  for (const r of recorded) {
    const order = returnedById.get(Number(r.helloasso_order_id));
    if (order && !isAuthorized(order)) {
      reversed.push(r);
    } else {
      if (!order) {
        console.warn(`HelloAsso order ${r.helloasso_order_id} is recorded but absent from the search response — keeping it.`);
      }
      if (r.amount_cents == null || r.amount_cents > 0) validCount++;
      else ungranted = true;
    }
  }
  if (reversed.length) {
    await pool.query("DELETE FROM membership_payments WHERE id = ANY($1)", [reversed.map((r) => r.id)]);
  }

  if (!validCount) {
    // Nothing left to base a membership on. Only clear is_member if it
    // was payment-driven (member_expires_at set) — a manual admin grant
    // (member_expires_at NULL) is never touched by this sync.
    if (reversed.length || ungranted) {
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
const RECENT_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

async function reconcileRecentMemberships(pool) {
  if (!isConfigured()) return;
  const cutoff = Date.now() - RECENT_WINDOW_MS;
  const orders = await listRecentMembershipOrders();
  const emails = new Set(
    orders
      .filter((o) => o.payer && typeof o.payer.email === "string" && new Date(o.date).getTime() >= cutoff)
      .map((o) => o.payer.email.toLowerCase())
  );
  for (const email of emails) {
    try {
      await syncMembershipForEmail(pool, email);
    } catch (err) {
      console.error(`Membership reconciliation failed:`, err.message);
    }
  }
}

module.exports = { alertUnmatchedPayments, linkUnmatchedPayment, expiryFromPayments, applyMembershipGrant, countsForMembership, syncMembershipForEmail, syncMembershipInBackground, expireStaleMemberships, reconcileRecentMemberships };
