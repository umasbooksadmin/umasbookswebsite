// Items for the "Needs attention" box on the admin dashboard that come from
// the email outbox and membership payments (lib/outbox.js, lib/membership.js).
// Kept out of routes/admin/dashboard.js so that file stays small.
// Each is a real query; nothing is shown when everything is fine.
const { runLimited } = require("./runLimited");

async function outboxAttention(db) {
  const { jobAttention } = require("./jobRuns");
  const [orders, failed, stuck, unmatched, jobs] = await runLimited([
    () => db.query(`SELECT COUNT(*)::int AS n FROM orders
              WHERE status = 'reserved' AND confirmation_sent_at IS NULL AND created_at < now() - interval '30 minutes'`),
    () => db.query("SELECT COUNT(*)::int AS n FROM email_outbox WHERE status = 'failed'"),
    () => db.query(`SELECT COUNT(*)::int AS n FROM email_outbox WHERE status = 'pending' AND created_at < now() - interval '30 minutes'`),
    () => db.query("SELECT COUNT(*)::int AS n FROM membership_payments WHERE user_id IS NULL AND unmatched_at IS NOT NULL"),
    () => jobAttention(db),
  ], 1); // one at a time: the dashboard already runs this beside two other queries
  const items = [];
  if (orders.rows[0].n) items.push({ href: "/admin/orders", text: `${orders.rows[0].n} reservation(s) have no confirmation email sent after 30 minutes. Resend it from the reservations list.` });
  if (failed.rows[0].n) items.push({ href: "/admin/email-outbox", text: `${failed.rows[0].n} email(s) could not be sent after 8 attempts.` });
  if (stuck.rows[0].n) items.push({ href: "/admin/email-outbox", text: `${stuck.rows[0].n} email(s) have been waiting to be sent for more than 30 minutes.` });
  if (unmatched.rows[0].n) items.push({ href: "/admin/members#unmatched-payments", text: `${unmatched.rows[0].n} membership payment(s) match no confirmed account.` });
  items.push(...jobs);
  // The Anthropic credit alert (lib/aiCreditAlert.js): shown until a call works again.
  try {
    const { creditAlertState, parisTime } = require("./aiCreditAlert");
    const credit = await creditAlertState(db);
    if (credit.active) items.push({ href: "/admin/reports/lookup-sources", text: `Anthropic API credit ran out at ${parisTime(new Date(credit.at).getTime())} (Paris time). The AI helpers are off until you add credit at console.anthropic.com > Settings > Billing.` });
  } catch { /* the dashboard must not depend on it */ }
  // The database nears its plan's storage limit (lib/dbSize.js): only with DB_PLAN_STORAGE_MB set, from 70%.
  try {
    items.push(...(await require("./dbSize").dbSizeAttention(db)));
  } catch { /* the dashboard must not depend on it */ }
  return items;
}

// Every number on the dashboard is a real query against this app's own
// data — there's no analytics/traffic tracking anywhere in this
// app, so there's deliberately no "website traffic" stat here; showing
// one would mean making it up. "This month" vs "last month" comparisons
// use calendar-month boundaries in the server's local time.

module.exports = { outboxAttention };
