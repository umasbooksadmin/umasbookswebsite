// Background follow-up for PAID online orders (index.js runs it every 6 hours):
//
//  1. Refund detection. A refund is done by hand in the HelloAsso dashboard,
//     which tells us nothing. So we re-read each recent paid order's checkout
//     intent from HelloAsso itself (authenticated lookup; a webhook body is
//     never trusted) and, when its payment is Refunded/Canceled, flag the order
//     (orders.refund_detected_at) and email the admin ONCE. Nothing is
//     restocked automatically: the admin marks the order refunded
//     (lib/orderActions.js), which is what puts the books back on sale.
//  2. Customer pickup reminder, on day 10 after payment, once per order.
//  3. Admin digest on day 12 of orders not collected, once per order.
//
// Every email is claimed in the database BEFORE it is sent (so two instances
// overlapping during a deploy cannot both send) and the claim is handed back
// when the send fails, so a later run tries again.

const mailer = require("../mailer");
const helloasso = require("./helloasso");
const { alertOnError, ALERT_TO } = require("./errorAlert");
const { emailTr, normLang } = require("./lang");
const { forLocale, LOCALES } = require("./dates");
const { emailSafeName } = require("./validation");
const { formatEuro } = require("./money");
const { loadOrderItems, orderItemLabel } = require("./orderItems");
const { AWAITING_PICKUP } = require("./orderActions");

const REFUND_CHECK_DAYS = 30;
const REFUND_CHECK_LIMIT = 200;
const CUSTOMER_REMINDER_DAY = 10;
const ADMIN_DIGEST_DAY = 12;
// The terms of sale ask for collection within 14 days of payment. A customer
// reminder only makes sense inside that window.
const PICKUP_WINDOW_DAYS = 14;

// HelloAsso payment states that mean "the money went back": Refunded and
// Refunding (a refund in progress), and Canceled. A partial refund is not
// detected (the payment stays Authorized).
const REFUND_STATES = new Set(["Refunded", "Refunding", "Canceled"]);

function isPaymentRefunded(intent) {
  const payments = intent && intent.order && intent.order.payments;
  if (!Array.isArray(payments)) return false;
  // A buyer who retried (first attempt Canceled, second Authorized) is paid.
  if (helloasso.isOrderPaid(intent)) return false;
  return payments.some((p) => REFUND_STATES.has(p.state));
}

const baseUrl = () => (process.env.APP_BASE_URL || process.env.RENDER_EXTERNAL_URL || "").replace(/\/$/, "");
const adminLink = (id) => `${baseUrl()}/admin/orders/${id}`;
const parisDate = (d) => forLocale(LOCALES.en).formatDate(d);

// Sends one email for a claimed batch of order ids; gives the claim back
// (sets `column` to NULL) if the send throws.
async function claimAndSend(pool, { column, whereSql, params = [], limit = 500 }, buildEmail) {
  const { rows: candidates } = await pool.query(
    `SELECT o.id FROM orders o WHERE ${whereSql} AND o.${column} IS NULL ORDER BY o.id LIMIT ${limit}`,
    params
  );
  if (!candidates.length) return { sent: 0 };
  const { rows: claimed } = await pool.query(
    `UPDATE orders SET ${column} = now() WHERE id = ANY($1::int[]) AND ${column} IS NULL RETURNING *`,
    [candidates.map((c) => c.id)]
  );
  if (!claimed.length) return { sent: 0 };
  claimed.sort((a, b) => a.id - b.id);
  try {
    await buildEmail(claimed);
    return { sent: claimed.length, ids: claimed.map((o) => o.id) };
  } catch (err) {
    console.error(`Order follow-up email failed (${column}):`, err.message);
    await pool.query(`UPDATE orders SET ${column} = NULL WHERE id = ANY($1::int[])`, [claimed.map((o) => o.id)]).catch((resetErr) =>
      console.error(`Could not release the ${column} claim:`, resetErr.message)
    );
    return { sent: 0, failed: claimed.length };
  }
}

// ---------- 1. refund detection ----------

async function detectRefundedOrders(pool) {
  const { rows: toCheck } = await pool.query(
    `SELECT id, checkout_intent_id FROM orders
     WHERE status = 'paid' AND refund_detected_at IS NULL AND checkout_intent_id IS NOT NULL
       AND paid_at > now() - interval '${REFUND_CHECK_DAYS} days'
     ORDER BY paid_at LIMIT ${REFUND_CHECK_LIMIT}`
  );
  let detected = 0;
  for (const order of toCheck) {
    let intent;
    try {
      intent = await helloasso.getCheckoutIntent(order.checkout_intent_id);
    } catch (err) {
      console.error(`HelloAsso refund check failed for order ${order.id}:`, err.message);
      if (err && (err.kind === "auth" || err.kind === "network")) {
        // HelloAsso is unreachable or rejecting our credentials: the rest would only time out.
        await alertOnError("HelloAsso refund check failing", `The refund check stopped after a HelloAsso ${err.kind} failure: ${err.message}`);
        break;
      }
      continue;
    }
    if (!isPaymentRefunded(intent)) continue;
    const { rowCount } = await pool.query(
      "UPDATE orders SET refund_detected_at = now() WHERE id = $1 AND status = 'paid' AND refund_detected_at IS NULL",
      [order.id]
    );
    if (rowCount) detected++;
  }

  // One email for everything newly detected (so a burst never floods the
  // inbox), once per order.
  const alert = await claimAndSend(
    pool,
    { column: "refund_alert_sent_at", whereSql: "o.status = 'paid' AND o.refund_detected_at IS NOT NULL" },
    async (orders) => {
      const lines = orders.map((o) => `- Order #${o.id}: ${o.buyer_name}, ${formatEuro(o.total_amount, "en")}\n  ${adminLink(o.id)}`).join("\n");
      const one = orders.length === 1;
      await mailer.sendMail({
        to: ALERT_TO,
        subject: one
          ? `Order #${orders[0].id} was refunded in HelloAsso: mark it refunded in admin to restock`
          : `${orders.length} orders were refunded in HelloAsso: mark them refunded in admin to restock`,
        text:
          `HelloAsso shows ${one ? "this order's payment" : "these orders' payments"} as refunded or canceled, but the site still shows ${one ? "it" : "them"} as Paid, ` +
          `so the books are still marked sold.\n\n${lines}\n\n` +
          `Open ${one ? "the order" : "each order"}, check the payment in the HelloAsso dashboard, then press "Mark refunded (done in HelloAsso)". ` +
          `That puts the books back on sale and removes the order from the sales figures. Nothing was changed automatically.`,
      });
    }
  );
  return { checked: toCheck.length, detected, alerted: alert.sent };
}

// ---------- 2. customer pickup reminder (day 10) ----------

async function sendCustomerPickupReminders(pool) {
  const { rows: candidates } = await pool.query(
    `SELECT o.id FROM orders o
     WHERE ${AWAITING_PICKUP}
       AND o.refund_detected_at IS NULL
       AND o.customer_pickup_reminder_sent_at IS NULL
       AND o.buyer_email NOT LIKE '%@erased.invalid'
       AND o.paid_at <= now() - interval '${CUSTOMER_REMINDER_DAY} days'
       AND o.paid_at > now() - interval '${PICKUP_WINDOW_DAYS} days'
     ORDER BY o.id LIMIT 200`
  );
  let sent = 0;
  for (const { id } of candidates) {
    const { rows } = await pool.query(
      `UPDATE orders o SET customer_pickup_reminder_sent_at = now()
       WHERE o.id = $1 AND ${AWAITING_PICKUP} AND o.refund_detected_at IS NULL AND o.customer_pickup_reminder_sent_at IS NULL
       RETURNING o.*`,
      [id]
    );
    const order = rows[0];
    if (!order) continue;
    try {
      const items = (await loadOrderItems(pool, order.id)).filter((i) => i.class_dropin_seat_id == null);
      await mailer.sendMail({ to: order.buyer_email, ...buildCustomerPickupReminder(order, items) });
      sent++;
    } catch (err) {
      console.error(`Pickup reminder failed for order ${order.id}:`, err.message);
      await pool.query("UPDATE orders SET customer_pickup_reminder_sent_at = NULL WHERE id = $1", [order.id]).catch(() => {});
    }
  }
  return { sent };
}

// Pure: { subject, text } in the order's language. It repeats what the terms of
// sale say (collect within 14 days of payment; write to us if you need longer)
// and promises nothing else.
function buildCustomerPickupReminder(order, items) {
  const lang = normLang(order.lang) || "en";
  const tr = emailTr(lang);
  const fmt = forLocale(LOCALES[lang]);
  const name = emailSafeName(order.buyer_name);
  const deadline = new Date(new Date(order.paid_at).getTime() + PICKUP_WINDOW_DAYS * 24 * 3600 * 1000);
  const lines = items.map((i) => `- ${orderItemLabel(i, lang)}`).join("\n");
  return {
    subject: tr(`Your books are waiting at the shop (order #${order.id})`, `Vos livres vous attendent à la boutique (commande n° ${order.id})`),
    text: tr(
      `Hi ${name},\n\nYour books from order #${order.id} (paid on ${fmt.formatDateLong(order.paid_at)}) are waiting for you at Uma's Books:\n\n${lines}\n\nOur terms of sale ask you to collect them within 14 days of payment, that is by ${fmt.formatDateLong(deadline)}. We are open Tuesday to Saturday, 10:00 to 19:00, Rue Peyrolière, 81000 Albi. Please bring your confirmation email.\n\nIf you need more time, just write to us at admin@umasbooks.org.\n\nUma's Books`,
      `Bonjour ${name},\n\nVos livres de la commande n° ${order.id} (payée le ${fmt.formatDateLong(order.paid_at)}) vous attendent à Uma's Books :\n\n${lines}\n\nNos conditions de vente vous demandent de les retirer dans les 14 jours suivant le paiement, soit avant le ${fmt.formatDateLong(deadline)}. Nous sommes ouverts du mardi au samedi, de 10 h à 19 h, Rue Peyrolière, 81000 Albi. Merci de vous munir de votre e-mail de confirmation.\n\nSi vous avez besoin de plus de temps, écrivez-nous simplement à admin@umasbooks.org.\n\nUma's Books`
    ),
  };
}

// ---------- 3. admin digest (day 12) ----------

async function sendAdminPickupDigest(pool) {
  return claimAndSend(
    pool,
    {
      column: "pickup_reminder_sent_at",
      whereSql: `${AWAITING_PICKUP} AND o.paid_at <= now() - interval '${ADMIN_DIGEST_DAY} days'`,
    },
    async (orders) => {
      const now = Date.now();
      const lines = orders
        .map((o) => {
          const days = Math.floor((now - new Date(o.paid_at).getTime()) / (24 * 3600 * 1000));
          const flag = o.refund_detected_at ? " [refund detected in HelloAsso]" : "";
          return `- Order #${o.id}: ${o.buyer_name} <${o.buyer_email}>, ${formatEuro(o.total_amount, "en")}, paid ${parisDate(o.paid_at)} (${days} days ago)${flag}\n  ${adminLink(o.id)}`;
        })
        .join("\n");
      await mailer.sendMail({
        to: ALERT_TO,
        subject: `${orders.length} online order${orders.length === 1 ? "" : "s"} not collected after ${ADMIN_DIGEST_DAY} days`,
        text:
          `These paid orders have not been marked collected, and were paid ${ADMIN_DIGEST_DAY} or more days ago. ` +
          `The terms of sale ask customers to collect within 14 days of payment and to write to us if they need longer.\n\n${lines}\n\n` +
          `If a customer collected, open the order and press "Mark collected". If they have not, see the runbook, "An order was not collected after 14 days". ` +
          `This list is sent once per order; the full list is always at ${baseUrl()}/admin/orders?view=uncollected`,
      });
    }
  );
}

// One run, each part isolated so one failure never skips the others.
async function runOrderFollowUps(pool) {
  const results = {};
  for (const [name, fn] of [
    ["refunds", detectRefundedOrders],
    ["customerReminders", sendCustomerPickupReminders],
    ["adminDigest", sendAdminPickupDigest],
  ]) {
    try {
      results[name] = await fn(pool);
    } catch (err) {
      console.error(`Order follow-up "${name}" failed:`, err);
      results[name] = { error: err.message };
    }
  }
  return results;
}

module.exports = {
  detectRefundedOrders, sendCustomerPickupReminders, sendAdminPickupDigest, runOrderFollowUps,
  buildCustomerPickupReminder, isPaymentRefunded, REFUND_STATES,
};
