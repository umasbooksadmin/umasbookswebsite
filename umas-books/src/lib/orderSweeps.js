// Background follow-up for RESERVATIONS and the other order mail (index.js runs
// it every 6 hours; every email is claimed in the database BEFORE it is sent, so
// two instances overlapping during a deploy cannot both send, and the claim is
// handed back when the send cannot even be stored).
//
//  0. Release: reservations past their deadline and seats whose session is over
//     go back on sale (lib/reservations.js). The same release also runs on page
//     reads; this makes it happen without any traffic.
//  1. Customer reminder RESERVATION_REMINDER_DAYS_BEFORE days before the deadline
//     (day 10 of 14), once per order (orders.customer_pickup_reminder_sent_at).
//  2. Drop-in seat reminder SEAT_REMINDER_HOURS before the session, once per seat
//     (class_dropin_seats.reminder_sent_at).
//  3. "Your reservation has ended" email when a reservation expired, once
//     (orders.expiry_notice_sent_at).
//  4. Admin digest: reservations expiring within 2 days, once per order
//     (orders.pickup_reminder_sent_at).
//  5. Orders PAID ONLINE before reservations existed and never collected: the
//     old day-10 customer reminder and day-12 admin digest (nothing new creates
//     such orders).
// There is NO payment-provider lookup here: refunds are done in the shop by hand.
// Customer mail goes through the email outbox (retried when Gmail is down).

const mailer = require("../mailer");
const { looseBaseUrl, configuredBaseUrl } = require("./baseUrl");
const { ALERT_TO } = require("./errorAlert");
const { sendEmail } = require("./outbox");
const { emailTr, normLang } = require("./lang");
const { forLocale, LOCALES } = require("./dates");
const { emailSafeName } = require("./validation");
const { formatEuro } = require("./money");
const { loadOrderItems, orderItemLabel, reservationLastDay } = require("./orderItems");
const { AWAITING_PICKUP } = require("./orderActions");
const { expireOrderReservations, releaseEndedSeats } = require("./reservations");
const { buildReservationReminder, buildReservationExpiredNotice, buildSeatReminder } = require("./orderEmail");
const legal = require("./legal");

const ADMIN_DIGEST_DAYS_BEFORE = 2;
const EXPIRY_NOTICE_WINDOW_DAYS = 7;
// Old online orders (see 5. above).
const CUSTOMER_REMINDER_DAY = 10;
const ADMIN_DIGEST_DAY = 12;
const PICKUP_WINDOW_DAYS = 14;

const baseUrl = () => looseBaseUrl();
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

// ---------- 0. release ----------

async function releaseDue(pool) {
  const orders = await expireOrderReservations(pool);
  const seats = await releaseEndedSeats(pool);
  return { orders, seats };
}

// ---------- 1. customer reminder (day 10 of 14) ----------

async function sendReservationReminders(pool) {
  const due = `o.status = 'reserved' AND o.customer_pickup_reminder_sent_at IS NULL
       AND o.buyer_email NOT LIKE '%@erased.invalid'
       AND o.reserved_until > now()
       AND o.reserved_until <= now() + interval '${legal.RESERVATION_REMINDER_DAYS_BEFORE} days'
       AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.book_copy_id IS NOT NULL)`;
  const { rows: candidates } = await pool.query(`SELECT o.id FROM orders o WHERE ${due} ORDER BY o.id LIMIT 200`);
  let sent = 0;
  for (const { id } of candidates) {
    const { rows } = await pool.query(
      `UPDATE orders o SET customer_pickup_reminder_sent_at = now() WHERE o.id = $1 AND ${due} RETURNING o.*`,
      [id]
    );
    const order = rows[0];
    if (!order) continue;
    try {
      const items = await loadOrderItems(pool, order.id);
      await sendEmail({ kind: "reservation_reminder", lang: order.lang, relatedOrderId: order.id, to: order.buyer_email, ...buildReservationReminder(order, items, configuredBaseUrl()) });
      sent++;
    } catch (err) {
      console.error(`Reservation reminder failed for order ${order.id}:`, err.message);
      await pool.query("UPDATE orders SET customer_pickup_reminder_sent_at = NULL WHERE id = $1", [order.id]).catch(() => {});
    }
  }
  return { sent };
}

// ---------- 2. drop-in seat reminder (24 h before) ----------

async function sendSeatReminders(pool) {
  const { rows: candidates } = await pool.query(
    `SELECT s.id FROM class_dropin_seats s JOIN classes c ON c.id = s.class_id JOIN orders o ON o.id = s.order_id
     WHERE s.status = 'reserved' AND s.reminder_sent_at IS NULL AND o.status = 'reserved'
       AND o.buyer_email NOT LIKE '%@erased.invalid'
       AND c.starts_at > now() AND c.starts_at <= now() + make_interval(hours => $1)
     ORDER BY s.id LIMIT 200`,
    [legal.SEAT_REMINDER_HOURS]
  );
  let sent = 0;
  for (const { id } of candidates) {
    const { rows } = await pool.query(
      `UPDATE class_dropin_seats s SET reminder_sent_at = now()
       FROM classes c WHERE c.id = s.class_id AND s.id = $1 AND s.status = 'reserved' AND s.reminder_sent_at IS NULL
         AND c.starts_at > now() AND c.starts_at <= now() + make_interval(hours => $2)
       RETURNING s.id, s.order_id`,
      [id, legal.SEAT_REMINDER_HOURS]
    );
    if (!rows[0]) continue;
    try {
      const { rows: o } = await pool.query("SELECT * FROM orders WHERE id = $1 AND status = 'reserved'", [rows[0].order_id]);
      if (!o[0]) throw new Error("order is no longer reserved");
      const items = (await loadOrderItems(pool, o[0].id)).filter((i) => i.class_dropin_seat_id === id);
      if (!items[0]) throw new Error("seat has no order line");
      await sendEmail({ kind: "seat_reminder", lang: o[0].lang, relatedOrderId: o[0].id, to: o[0].buyer_email, ...buildSeatReminder(o[0], items[0]) });
      sent++;
    } catch (err) {
      console.error(`Seat reminder failed for seat ${id}:`, err.message);
      await pool.query("UPDATE class_dropin_seats SET reminder_sent_at = NULL WHERE id = $1", [id]).catch(() => {});
    }
  }
  return { sent };
}

// ---------- 3. "your reservation has ended" ----------

async function sendExpiryNotices(pool) {
  // Only a reservation that lapsed by itself (not one the customer or the staff
  // cancelled or marked no-show), and only when books were involved: a seat for a
  // session that has passed needs no "back on sale" message.
  const due = `o.status = 'expired' AND o.release_reason = 'expired' AND o.expiry_notice_sent_at IS NULL
       AND o.buyer_email NOT LIKE '%@erased.invalid'
       AND o.released_at > now() - interval '${EXPIRY_NOTICE_WINDOW_DAYS} days'
       AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.book_copy_id IS NOT NULL)`;
  const { rows: candidates } = await pool.query(`SELECT o.id FROM orders o WHERE ${due} ORDER BY o.id LIMIT 200`);
  let sent = 0;
  for (const { id } of candidates) {
    const { rows } = await pool.query(`UPDATE orders o SET expiry_notice_sent_at = now() WHERE o.id = $1 AND ${due} RETURNING o.*`, [id]);
    const order = rows[0];
    if (!order) continue;
    try {
      const items = (await loadOrderItems(pool, order.id)).filter((i) => i.class_dropin_seat_id == null);
      await sendEmail({ kind: "reservation_expired", lang: order.lang, relatedOrderId: order.id, to: order.buyer_email, ...buildReservationExpiredNotice(order, items, configuredBaseUrl()) });
      sent++;
    } catch (err) {
      console.error(`Reservation expiry notice failed for order ${order.id}:`, err.message);
      await pool.query("UPDATE orders SET expiry_notice_sent_at = NULL WHERE id = $1", [order.id]).catch(() => {});
    }
  }
  return { sent };
}

// ---------- 4. admin digest: reservations expiring within 2 days ----------

async function sendAdminReservationDigest(pool) {
  return claimAndSend(
    pool,
    {
      column: "pickup_reminder_sent_at",
      whereSql: `o.status = 'reserved' AND o.reserved_until > now() AND o.reserved_until <= now() + interval '${ADMIN_DIGEST_DAYS_BEFORE} days'
        AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id AND i.book_copy_id IS NOT NULL)`,
    },
    async (orders) => {
      const lines = orders
        .map((o) => `- Reservation #${o.id}: ${o.buyer_name} <${o.buyer_email}>, ${formatEuro(o.total_amount, "en")}, held until the end of ${parisDate(reservationLastDay(o))}\n  ${adminLink(o.id)}`)
        .join("\n");
      await mailer.sendMail({
        to: ALERT_TO,
        subject: `${orders.length} reservation${orders.length === 1 ? "" : "s"} expiring within ${ADMIN_DIGEST_DAYS_BEFORE} days`,
        text:
          `These reservations will be released automatically within ${ADMIN_DIGEST_DAYS_BEFORE} days if nobody collects them.\n\n${lines}\n\n` +
          `If a customer asked for more time, open the reservation and press "Extend by ${legal.RESERVATION_EXTENSION_DAYS} days" (once). ` +
          `See the runbook, "Reservations not collected". This list is sent once per reservation; the full list is always at ${baseUrl()}/admin/orders?show=expiring_soon`,
      });
    }
  );
}

// ---------- 5. orders paid online before reservations (old; nothing new creates them) ----------
// Customer reminder on day 10 after payment.

async function sendCustomerPickupReminders(pool) {
  const { rows: candidates } = await pool.query(
    `SELECT o.id FROM orders o
     WHERE ${AWAITING_PICKUP}
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
       WHERE o.id = $1 AND ${AWAITING_PICKUP} AND o.customer_pickup_reminder_sent_at IS NULL
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
    subject: tr(`Your books are waiting at the shop (reservation #${order.id})`, `Vos livres vous attendent à la boutique (réservation n° ${order.id})`),
    text: tr(
      `Hi ${name},\n\nYour books from reservation #${order.id} (paid on ${fmt.formatDateLong(order.paid_at)}) are waiting for you at Uma's Books:\n\n${lines}\n\nOur terms of sale ask you to collect them within 14 days of payment, that is by ${fmt.formatDateLong(deadline)}. The shop is at ${legal.shopStreet("en")}, 81000 Albi. ${legal.shopHoursFirm("en")} Please bring your confirmation email.\n\nIf you need more time, just write to us at ${legal.CONTACT_EMAIL}.\n\nUma's Books`,
      `Bonjour ${name},\n\nVos livres de la réservation n° ${order.id} (payée le ${fmt.formatDateLong(order.paid_at)}) vous attendent à Uma's Books :\n\n${lines}\n\nNos conditions générales de vente (CGV) vous demandent de les retirer dans les 14 jours suivant le paiement, soit avant le ${fmt.formatDateLong(deadline)}. La boutique est située ${legal.shopStreet("fr", false)}, 81000 Albi. ${legal.shopHoursFirm("fr")} Merci de vous munir de votre e-mail de confirmation.\n\nSi vous avez besoin de plus de temps, écrivez-nous simplement à ${legal.CONTACT_EMAIL}.\n\nUma's Books`
    ),
  };
}

// Admin digest on day 12 after payment.

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
          const flag = "";
          return `- Reservation #${o.id}: ${o.buyer_name} <${o.buyer_email}>, ${formatEuro(o.total_amount, "en")}, paid ${parisDate(o.paid_at)} (${days} days ago)${flag}\n  ${adminLink(o.id)}`;
        })
        .join("\n");
      await mailer.sendMail({
        to: ALERT_TO,
        subject: `${orders.length} online reservation${orders.length === 1 ? "" : "s"} not collected after ${ADMIN_DIGEST_DAY} days`,
        text:
          `These paid reservations have not been marked collected, and were paid ${ADMIN_DIGEST_DAY} or more days ago. ` +
          `The terms of sale ask customers to collect within 14 days of payment and to write to us if they need longer.\n\n${lines}\n\n` +
          `If a customer collected, open the reservation and press "Mark collected". If they have not, see the runbook, "A reservation was not collected after 14 days". ` +
          `This list is sent once per reservation; the full list is always at ${baseUrl()}/admin/orders?show=uncollected`,
      });
    }
  );
}

// One run, each part isolated so one failure never skips the others.
async function runOrderFollowUps(pool) {
  const results = {};
  for (const [name, fn] of [
    ["release", releaseDue],
    ["reservationReminders", sendReservationReminders],
    ["seatReminders", sendSeatReminders],
    ["expiryNotices", sendExpiryNotices],
    ["adminReservationDigest", sendAdminReservationDigest],
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
  releaseDue, sendReservationReminders, sendSeatReminders, sendExpiryNotices, sendAdminReservationDigest,
  sendCustomerPickupReminders, sendAdminPickupDigest, runOrderFollowUps, buildCustomerPickupReminder,
};
