// Membership sign-up and payment now happen entirely on a HelloAsso
// "Adhésion" form (see membership.html) rather than on our own site, so
// is_member is kept in sync here rather than set directly by a route —
// the only two writers of is_member are this file (from a real HelloAsso
// payment) and the manual admin toggle at /admin/members (for one-off
// exceptions, which stay in effect since those accounts have no
// member_expires_at to lapse).

const { findMembershipOrdersByEmail } = require("./helloasso");

const MEMBERSHIP_DURATION_MS = 365 * 24 * 60 * 60 * 1000;

function isAuthorized(order) {
  return Array.isArray(order.payments) && order.payments.some((p) => p.state === "Authorized");
}

// Re-checks HelloAsso (never trusts the webhook body itself — see
// lib/helloasso.js) for this payer's Membership-form orders, records any
// newly-seen paid order, and extends the matching site account's
// membership by MEMBERSHIP_DURATION_MS from that payment's date. A
// payer email with no matching account is logged and otherwise ignored:
// there's no safe way to guess which account it belongs to.
async function syncMembershipForEmail(pool, email) {
  if (!email) return;
  const orders = await findMembershipOrdersByEmail(email);
  const paidOrders = orders.filter(isAuthorized);
  if (!paidOrders.length) return;

  const { rows: userRows } = await pool.query("SELECT id, member_expires_at FROM users WHERE lower(email) = lower($1)", [email]);
  const user = userRows[0];
  if (!user) {
    console.warn(`HelloAsso membership payment from ${email} has no matching site account — skipped.`);
    return;
  }

  let newExpiresAt = user.member_expires_at ? new Date(user.member_expires_at) : null;

  for (const order of paidOrders) {
    const paidAt = new Date(order.date);
    const expiresFromThisOrder = new Date(paidAt.getTime() + MEMBERSHIP_DURATION_MS);

    const { rows: inserted } = await pool.query(
      `INSERT INTO membership_payments (user_id, helloasso_order_id, payer_email, amount_cents, paid_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (helloasso_order_id) DO NOTHING RETURNING id`,
      [user.id, order.id, email, order.amount && order.amount.total, paidAt]
    );
    if (!inserted.length) continue; // already processed this order

    if (!newExpiresAt || expiresFromThisOrder > newExpiresAt) newExpiresAt = expiresFromThisOrder;
  }

  if (newExpiresAt && (!user.member_expires_at || newExpiresAt.getTime() !== new Date(user.member_expires_at).getTime())) {
    await pool.query("UPDATE users SET is_member = TRUE, member_expires_at = $1 WHERE id = $2", [newExpiresAt, user.id]);
  }
}

// Belt-and-suspenders backstop (see runReservationMaintenance/runCartMaintenance
// in index.js for the same pattern): a membership granted manually from
// /admin/members has no member_expires_at and is never touched here.
async function expireStaleMemberships(pool) {
  await pool.query(
    "UPDATE users SET is_member = FALSE WHERE is_member = TRUE AND member_expires_at IS NOT NULL AND member_expires_at < now()"
  );
}

module.exports = { syncMembershipForEmail, expireStaleMemberships };
