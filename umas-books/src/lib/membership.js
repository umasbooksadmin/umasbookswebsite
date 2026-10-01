// Membership sign-up and payment now happen entirely on a HelloAsso
// "Adhésion" form (see membership.html) rather than on our own site, so
// is_member is kept in sync here rather than set directly by a route —
// the only two writers of is_member are this file (from a real HelloAsso
// payment) and the manual admin toggle at /admin/members (for one-off
// exceptions, which stay in effect since those accounts have no
// member_expires_at to lapse).

const { findMembershipOrdersByEmail, listRecentMembershipOrders, isConfigured } = require("./helloasso");

const MEMBERSHIP_DURATION_MS = 365 * 24 * 60 * 60 * 1000;

function isAuthorized(order) {
  return Array.isArray(order.payments) && order.payments.some((p) => p.state === "Authorized");
}

// Re-checks HelloAsso (never trusts the webhook body itself — see
// lib/helloasso.js) for this payer's Membership-form orders, records any
// newly-seen paid order, extends the matching site account's membership
// by MEMBERSHIP_DURATION_MS from that payment's date, and reverts any
// previously-recorded payment whose order is returned by HelloAsso but no
// longer shows as Authorized (a refund or a won dispute both land here,
// since HelloAsso reuses the same order id and just flips its payment's
// state — see paiement-remboursé.md/paiement-contesté-gagne.md). A
// recorded payment that is merely absent from the response is kept. A payer email with
// no matching account is logged and otherwise ignored: there's no safe
// way to guess which account it belongs to.
async function syncMembershipForEmail(pool, email) {
  if (!email) return;
  const orders = await findMembershipOrdersByEmail(email);
  if (!orders.length) return;

  const { rows: userRows } = await pool.query("SELECT id, email_verified_at FROM users WHERE lower(email) = lower($1)", [email]);
  const user = userRows[0];
  if (!user) {
    console.warn(`HelloAsso membership payment from ${email} has no matching site account — skipped.`);
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
    console.warn(`HelloAsso membership payment from ${email} matched an account with an unverified email — skipped.`);
    return;
  }

  // Orders HelloAsso returned, by id. The search is fuzzy and paginated
  // (pageSize 50), so a recorded payment merely missing from the response
  // proves nothing; only an order that IS present and no longer Authorized
  // is positive evidence of a refund/dispute.
  const returnedById = new Map(orders.map((o) => [Number(o.id), o]));

  for (const order of orders.filter(isAuthorized)) {
    await pool.query(
      `INSERT INTO membership_payments (user_id, helloasso_order_id, payer_email, amount_cents, paid_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (helloasso_order_id) DO NOTHING`,
      [user.id, order.id, email, order.amount && order.amount.total, new Date(order.date)]
    );
  }

  const { rows: recorded } = await pool.query(
    "SELECT id, helloasso_order_id, paid_at FROM membership_payments WHERE user_id = $1",
    [user.id]
  );
  const reversed = [];
  const stillValid = [];
  for (const r of recorded) {
    const order = returnedById.get(Number(r.helloasso_order_id));
    if (order && !isAuthorized(order)) {
      reversed.push(r);
    } else {
      if (!order) {
        console.warn(`HelloAsso order ${r.helloasso_order_id} for ${email} is recorded but absent from the search response — keeping it.`);
      }
      stillValid.push(r);
    }
  }
  if (reversed.length) {
    await pool.query("DELETE FROM membership_payments WHERE id = ANY($1)", [reversed.map((r) => r.id)]);
  }

  if (!stillValid.length) {
    // Nothing left to base a membership on. Only clear is_member if it
    // was payment-driven (member_expires_at set) — a manual admin grant
    // (member_expires_at NULL) is never touched by this sync.
    if (reversed.length) {
      await pool.query(
        "UPDATE users SET is_member = FALSE, member_expires_at = NULL WHERE id = $1 AND member_expires_at IS NOT NULL",
        [user.id]
      );
    }
    return;
  }

  const newExpiresAt = stillValid.reduce((max, r) => {
    const exp = new Date(new Date(r.paid_at).getTime() + MEMBERSHIP_DURATION_MS);
    return !max || exp > max ? exp : max;
  }, null);

  const { rows: freshUser } = await pool.query("SELECT member_expires_at FROM users WHERE id = $1", [user.id]);
  const currentExpiresAt = freshUser[0].member_expires_at ? new Date(freshUser[0].member_expires_at) : null;
  if (!currentExpiresAt || newExpiresAt.getTime() !== currentExpiresAt.getTime()) {
    await pool.query("UPDATE users SET is_member = TRUE, member_expires_at = $1 WHERE id = $2", [newExpiresAt, user.id]);
  }
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
    console.error(`Membership sync after account change failed for ${email}:`, err.message));
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
      console.error(`Membership reconciliation failed for ${email}:`, err.message);
    }
  }
}

module.exports = { syncMembershipForEmail, syncMembershipInBackground, expireStaleMemberships, reconcileRecentMemberships };
