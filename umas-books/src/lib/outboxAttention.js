// Items for the "Needs attention" box on the admin dashboard that come from
// the email outbox and membership payments (lib/outbox.js, lib/membership.js).
// Kept out of routes/admin/dashboard.js so that file stays small.
// Each is a real query; nothing is shown when everything is fine.
async function outboxAttention(db) {
  const [orders, failed, stuck, unmatched] = await Promise.all([
    db.query(`SELECT COUNT(*)::int AS n FROM orders
              WHERE status = 'paid' AND confirmation_sent_at IS NULL AND paid_at < now() - interval '30 minutes'`),
    db.query("SELECT COUNT(*)::int AS n FROM email_outbox WHERE status = 'failed'"),
    db.query(`SELECT COUNT(*)::int AS n FROM email_outbox WHERE status = 'pending' AND created_at < now() - interval '30 minutes'`),
    db.query("SELECT COUNT(*)::int AS n FROM membership_payments WHERE user_id IS NULL AND unmatched_at IS NOT NULL"),
  ]);
  const items = [];
  if (orders.rows[0].n) items.push({ href: "/admin/orders", text: `${orders.rows[0].n} paid order(s) have no confirmation email sent after 30 minutes. Resend it from the orders list.` });
  if (failed.rows[0].n) items.push({ href: "/admin/email-outbox", text: `${failed.rows[0].n} email(s) could not be sent after 8 attempts.` });
  if (stuck.rows[0].n) items.push({ href: "/admin/email-outbox", text: `${stuck.rows[0].n} email(s) have been waiting to be sent for more than 30 minutes.` });
  if (unmatched.rows[0].n) items.push({ href: "/admin/members#unmatched-payments", text: `${unmatched.rows[0].n} membership payment(s) match no confirmed account.` });
  return items;
}

// Every number on the dashboard is a real query against this app's own
// data — there's no analytics/traffic tracking anywhere in this
// app, so there's deliberately no "website traffic" stat here; showing
// one would mean making it up. "This month" vs "last month" comparisons
// use calendar-month boundaries in the server's local time.

module.exports = { outboxAttention };
